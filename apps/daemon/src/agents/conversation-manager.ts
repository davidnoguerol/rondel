/**
 * Conversation lifecycle manager.
 *
 * Owns the per-conversation Claude CLI process lifecycle and session persistence.
 * Each unique (agentName, channelType, chatId) triple gets its own isolated process —
 * agent config is a template, not a singleton. Three users messaging the same bot =
 * three independent Claude instances.
 *
 * Session persistence follows OpenClaw's two-layer model:
 * - Layer 1: Session index (sessions.json) — maps conversation keys to Claude CLI session IDs
 * - Layer 2: Transcripts (JSONL) — append-only conversation history per session
 *
 * The conversation key ({agentName}:{channelType}:{chatId}) is permanent and used for routing.
 * The session ID is mutable — it rotates on /new and can be replaced without
 * changing the routing key. Don't conflate these.
 */

import { AgentProcess, type McpConfigMap, type AgentProcessSessionOptions } from "./agent-process.js";
import { resolveTranscriptPath, createTranscript } from "../shared/transcript.js";
import { atomicWriteFile } from "../shared/atomic-file.js";
import type { AgentConfig, AgentState, AgentStateEvent, SessionIndex, ConversationKey } from "../shared/types/index.js";
import { conversationKey, parseConversationKey } from "../shared/types/index.js";
import { buildChannelMcpEnv } from "../shared/channels.js";
import type { RondelHooks } from "../shared/hooks.js";
import type { Logger } from "../shared/logger.js";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Agent template — the shared config and system prompt for an agent.
 * One template can spawn many conversations (processes).
 * Provided by AgentManager at initialization.
 */
export interface AgentTemplate {
  readonly name: string;
  readonly agentDir: string;
  readonly config: AgentConfig;
  readonly systemPrompt: string;
}

/** Summary info about a single active conversation. */
export interface ConversationInfo {
  readonly agentName: string;
  readonly conversationKey: ConversationKey;
  readonly channelType: string;
  readonly chatId: string;
  readonly state: AgentState;
  readonly sessionId: string;
}

// ---------------------------------------------------------------------------
// ConversationManager
// ---------------------------------------------------------------------------

export class ConversationManager {
  /** Active per-conversation processes: conversationKey → AgentProcess. */
  private readonly conversations = new Map<ConversationKey, AgentProcess>();

  /** Session index: conversation key → session entry. Persisted to disk. */
  private sessionIndex: SessionIndex = {};

  /**
   * Conversations that should restart at the end of their current turn.
   *
   * Set by `rondel_reload_skills` (and any other tool that needs new
   * `--add-dir` content picked up) and consumed by the Router when a
   * process transitions to idle. Keeps restart out of the turn itself —
   * SIGTERM-ing a process mid-tool-call would lose the turn entirely.
   */
  private readonly pendingRestarts = new Set<ConversationKey>();

  /** In-process subscribers to conversation state transitions. */
  private readonly stateChangeListeners = new Set<(event: AgentStateEvent) => void>();

  private readonly log: Logger;

  constructor(
    private readonly stateDir: string,
    private readonly mcpServerPath: string,
    private readonly bridgeUrl: () => string,
    log: Logger,
    private readonly hooks?: RondelHooks,
  ) {
    this.log = log.child("conversations");
  }

  // -------------------------------------------------------------------------
  // State-change subscription registry
  // -------------------------------------------------------------------------

  /**
   * Subscribe to per-conversation state transitions.
   *
   * Fires for EVERY transition (starting → idle → busy → idle → ...) on any
   * conversation, not just the crash/halt subset that's currently emitted to
   * RondelHooks for the ledger. Used by the SSE stream that powers the web
   * UI's live agent badges.
   *
   * Listener errors are swallowed per the hooks convention. Returns an
   * unsubscribe function.
   */
  onStateChange(cb: (event: AgentStateEvent) => void): () => void {
    this.stateChangeListeners.add(cb);
    return () => {
      this.stateChangeListeners.delete(cb);
    };
  }

  private notifyStateChange(event: AgentStateEvent): void {
    for (const cb of this.stateChangeListeners) {
      try {
        cb(event);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.log.warn(`stateChange listener: ${message}`);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Session index persistence
  // -------------------------------------------------------------------------

  private sessionIndexPath(): string {
    return join(this.stateDir, "sessions.json");
  }

  private transcriptsDir(): string {
    return join(this.stateDir, "transcripts");
  }

  /** Load session index from disk. Called once during startup. */
  async loadSessionIndex(): Promise<void> {
    try {
      const raw = await readFile(this.sessionIndexPath(), "utf-8");
      const loaded = JSON.parse(raw) as SessionIndex;

      // Migrate: drop old 2-part keys (agentName:chatId) that lack channelType.
      // New keys have 3 parts (agentName:channelType:chatId) — at least 2 colons.
      const migrated: SessionIndex = {};
      let dropped = 0;
      for (const [key, entry] of Object.entries(loaded)) {
        const firstColon = key.indexOf(":");
        const secondColon = key.indexOf(":", firstColon + 1);
        if (secondColon === -1) {
          // Old format — 2-part key, no channelType segment
          dropped++;
          continue;
        }
        migrated[key] = entry;
      }

      this.sessionIndex = migrated;
      const count = Object.keys(migrated).length;
      if (dropped > 0) {
        this.log.warn(`Session migration: dropped ${dropped} old-format session(s) (missing channelType). They will start fresh.`);
        this.persistSessionIndex().catch(() => {});
      }
      this.log.info(`Loaded session index: ${count} session(s)`);
    } catch {
      this.sessionIndex = {};
      this.log.info("No session index found — starting fresh");
    }
  }

  /** Persist session index to disk. Called after session changes and on shutdown. */
  async persistSessionIndex(): Promise<void> {
    await atomicWriteFile(this.sessionIndexPath(), JSON.stringify(this.sessionIndex, null, 2));
  }

  // -------------------------------------------------------------------------
  // Conversation lifecycle
  // -------------------------------------------------------------------------

  /**
   * Get or spawn a conversation process for a specific chat.
   *
   * First message to a new chat spawns a fresh Claude process. Subsequent
   * messages reuse the existing process. If a session ID exists in the index
   * for this conversation, the process is spawned with --resume to restore
   * context from Claude CLI's persisted session.
   *
   * @param template - The agent template (config + system prompt) to use
   * @param channelType - The channel type (e.g., "telegram", "slack", "internal")
   * @param chatId - The chat/conversation identifier
   * @param extraMcpEnv - Additional env vars to pass to the MCP server (e.g. parent info)
   * @returns The AgentProcess, or undefined if template is missing
   */
  getOrSpawn(
    template: AgentTemplate,
    channelType: string,
    chatId: string,
    extraMcpEnv?: Record<string, string>,
  ): AgentProcess {
    const key = conversationKey(template.name, channelType, chatId);
    const existing = this.conversations.get(key);
    if (existing) return existing;

    this.log.info(`Spawning new conversation: ${template.name} @ ${channelType}:${chatId}`);

    // --- Resolve session: existing entry → resume, new → fresh session ID ---
    //     Hoisted before the MCP config so we can stamp RONDEL_PARENT_SESSION_ID
    //     into the env — filesystem tools key their read-state records on it.
    const existingEntryForEnv = this.sessionIndex[conversationKey(template.name, channelType, chatId)];
    const preResolvedSessionId = existingEntryForEnv?.sessionId ?? randomUUID();

    // --- Build MCP config ---
    const mcpConfig: McpConfigMap = {
      // Rondel's own MCP server — always present
      rondel: {
        command: "node",
        args: [this.mcpServerPath],
        env: {
          ...buildChannelMcpEnv(template.config),
          RONDEL_BRIDGE_URL: this.bridgeUrl(),
          RONDEL_PARENT_AGENT: template.name,
          RONDEL_PARENT_CHANNEL_TYPE: channelType,
          RONDEL_PARENT_CHAT_ID: chatId,
          // Filesystem tools (rondel_read_file / rondel_write_file /
          // rondel_edit_file / rondel_multi_edit_file) key their session-
          // scoped read-state records on this. Present from spawn time so
          // the first tool call in a session sees a stable id. If the CLI
          // later confirms a different sessionId on `system init`, this
          // env var stays pointing at the originally-reserved id — which
          // is still unique per (conversation, spawn), which is the only
          // guarantee the read-state store needs.
          RONDEL_PARENT_SESSION_ID: preResolvedSessionId,
          ...(template.config.admin ? { RONDEL_AGENT_ADMIN: "1" } : {}),
          ...extraMcpEnv,
        },
      },
      // User-defined MCP servers from agent.json
      ...template.config.mcp?.servers,
    };

    // Reuse the id we already reserved for the MCP env — no second randomUUID().
    const existingEntry = existingEntryForEnv;
    const sessionId: string = preResolvedSessionId;
    const resume: boolean = !!existingEntry;

    if (existingEntry) {
      this.log.info(`Resuming session ${sessionId} for ${key}`);
      this.hooks?.emit("session:resumed", { agentName: template.name, channelType, chatId, sessionId });
    } else {
      this.log.info(`New session ${sessionId} for ${key}`);
      this.hooks?.emit("session:start", { agentName: template.name, channelType, chatId, sessionId });
    }

    // --- Session index entry ---
    // For new sessions: DON'T persist until Claude CLI confirms via sessionEstablished event.
    // This prevents stale entries from processes that crash before the first turn.
    // For resumed sessions: entry already exists from a previous successful session.
    if (!resume) {
      // Prepare in memory but will be persisted on sessionEstablished
      const now = Date.now();
      this.sessionIndex[key] = {
        sessionId,
        agentName: template.name,
        channelType,
        chatId,
        createdAt: now,
        updatedAt: now,
      };
    }

    // --- Set up transcript ---
    const transcriptPath = resolveTranscriptPath(this.transcriptsDir(), template.name, sessionId);
    if (!resume) {
      // New session — create transcript with header (async, don't block)
      createTranscript(transcriptPath, {
        type: "session_start",
        sessionId,
        agentName: template.name,
        chatId,
        model: template.config.model,
        timestamp: new Date().toISOString(),
      }, this.log).catch(() => {});
    }

    const sessionOptions: AgentProcessSessionOptions = {
      sessionId,
      resume,
      transcriptPath,
    };

    // --- Spawn the process ---
    const process = new AgentProcess(
      template.config,
      template.systemPrompt,
      this.log,
      mcpConfig,
      sessionOptions,
      template.agentDir,
    );

    // Listen for session establishment to persist the confirmed session ID
    process.on("sessionEstablished", (confirmedSessionId) => {
      const entry = this.sessionIndex[key];
      if (!entry) return; // entry may have been deleted by resetSession()
      if (confirmedSessionId !== sessionId) {
        // CLI assigned a different session ID than we requested — update index
        this.sessionIndex[key] = { ...entry, sessionId: confirmedSessionId, updatedAt: Date.now() };
      } else {
        this.sessionIndex[key] = { ...entry, updatedAt: Date.now() };
      }
      this.persistSessionIndex().catch(() => {});
    });

    // Listen for resume failure — delete entry so next spawn starts fresh
    process.on("error", (err) => {
      if (err.message === "resume_failed") {
        this.log.warn(`Resume failed for ${key} — entry removed, next spawn starts fresh`);
        delete this.sessionIndex[key];
        this.persistSessionIndex().catch(() => {});
      }
    });

    // Translate AgentProcess state changes into:
    //   1. RondelHooks for the ledger (crash/halt only — unchanged from M1)
    //   2. ConversationManager.onStateChange listeners for live SSE streams
    //      (every transition, not just crash/halt)
    process.on("stateChange", (state) => {
      if (state === "crashed") {
        this.hooks?.emit("session:crash", { agentName: template.name, channelType, chatId, sessionId });
      } else if (state === "halted") {
        this.hooks?.emit("session:halt", { agentName: template.name, channelType, chatId, sessionId });
      }
      this.notifyStateChange({
        agentName: template.name,
        chatId,
        channelType,
        state,
        sessionId,
        ts: new Date().toISOString(),
      });
    });

    process.start();
    this.conversations.set(key, process);

    // Persist session index (fire-and-forget)
    this.persistSessionIndex().catch(() => {});

    return process;
  }

  /** Get an existing conversation process (don't spawn). */
  get(agentName: string, channelType: string, chatId: string): AgentProcess | undefined {
    return this.conversations.get(conversationKey(agentName, channelType, chatId));
  }

  /**
   * Look up the persisted session entry for a conversation. Returns undefined
   * if no session has been established yet (fresh chatId, no turns). Used by
   * the bridge's conversation history endpoint to locate the transcript file
   * without reaching into the session index directly.
   */
  getSessionEntry(agentName: string, channelType: string, chatId: string) {
    const key = conversationKey(agentName, channelType, chatId);
    return this.sessionIndex[key];
  }

  /** Directory where transcript files live (one subdir per agent). */
  getTranscriptsDir(): string {
    return this.transcriptsDir();
  }

  /** Restart a conversation's process (kill + relaunch with --resume). */
  restart(agentName: string, channelType: string, chatId: string): boolean {
    const key = conversationKey(agentName, channelType, chatId);
    const process = this.conversations.get(key);
    if (!process) return false;
    this.log.info(`Restarting conversation: ${agentName} @ ${channelType}:${chatId}`);
    process.restart();
    return true;
  }

  // -------------------------------------------------------------------------
  // Post-turn restart scheduling
  // -------------------------------------------------------------------------

  /**
   * Schedule a restart to fire after the current turn completes.
   *
   * Used when an in-turn tool (`rondel_reload_skills`) needs the process
   * to re-read its `--add-dir` roots without killing the turn that's
   * calling the tool. The Router consumes the flag on the next idle
   * transition via `hasPendingRestart` / `clearPendingRestart`.
   *
   * Returns true if a conversation exists to schedule against, false
   * otherwise (e.g. the conversation was reset between the tool call
   * leaving the agent and the bridge receiving it).
   */
  scheduleRestartAfterTurn(agentName: string, channelType: string, chatId: string): boolean {
    const key = conversationKey(agentName, channelType, chatId);
    if (!this.conversations.has(key)) return false;
    this.pendingRestarts.add(key);
    this.log.info(`Post-turn restart scheduled: ${key}`);
    return true;
  }

  /** True if this conversation has a pending post-turn restart. */
  hasPendingRestart(key: ConversationKey): boolean {
    return this.pendingRestarts.has(key);
  }

  /** Clear a pending post-turn restart flag. Idempotent. */
  clearPendingRestart(key: ConversationKey): void {
    this.pendingRestarts.delete(key);
  }

  /**
   * Reset a conversation's session.
   *
   * Deletes the session index entry so the next message starts a completely
   * fresh session. Old transcript stays on disk (history preserved). The next
   * call to getOrSpawn() will generate a new UUID and use --session-id (not --resume).
   */
  resetSession(agentName: string, channelType: string, chatId: string): void {
    const key = conversationKey(agentName, channelType, chatId);

    // Remove the index entry — next spawn will create a fresh session
    delete this.sessionIndex[key];
    this.hooks?.emit("session:reset", { agentName, channelType, chatId });

    // Clear any pending post-turn restart — a /new reset already replaces the
    // process, so firing a restart on the fresh spawn would be redundant
    // (and surprising to the user who just asked for a clean slate).
    this.pendingRestarts.delete(key);

    // Stop and remove the existing process
    const process = this.conversations.get(key);
    if (process) {
      process.stop();
      this.conversations.delete(key);
    }

    this.persistSessionIndex().catch(() => {});
    this.log.info(`Session reset: ${key} (entry removed — next message starts fresh)`);
  }

  /** Stop all active conversation processes. Called during shutdown. */
  stopAll(): void {
    for (const [key, process] of this.conversations) {
      this.log.info(`Stopping conversation: ${key}`);
      process.stop();
    }
  }

  // -------------------------------------------------------------------------
  // Query methods (used by router, bridge, etc.)
  // -------------------------------------------------------------------------

  /** Get info about all active conversations across all agents. */
  getAllInfo(): ConversationInfo[] {
    const info: ConversationInfo[] = [];
    for (const [key, process] of this.conversations) {
      const [agentName, channelType, chatId] = parseConversationKey(key);
      info.push({
        agentName,
        conversationKey: key,
        channelType,
        chatId,
        state: process.getState(),
        sessionId: process.getSessionId(),
      });
    }
    return info;
  }

  /** Get conversations for a specific agent. */
  getForAgent(agentName: string): ConversationInfo[] {
    return this.getAllInfo().filter((c) => c.agentName === agentName);
  }

  /**
   * Snapshot the current state of every active conversation.
   *
   * Used by the agent-state SSE stream when a client first connects, so
   * the UI starts with a complete picture before live deltas begin to
   * arrive. The returned entries share a single `ts` (now), which marks
   * them as snapshot entries rather than transition events.
   */
  getAllConversationStates(): AgentStateEvent[] {
    const ts = new Date().toISOString();
    const entries: AgentStateEvent[] = [];
    for (const [key, process] of this.conversations) {
      const [agentName, channelType, chatId] = parseConversationKey(key);
      entries.push({
        agentName,
        chatId,
        channelType,
        state: process.getState(),
        sessionId: process.getSessionId(),
        ts,
      });
    }
    return entries;
  }
}

