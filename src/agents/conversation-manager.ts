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
import type { AgentConfig, AgentState, SessionIndex, ConversationKey } from "../shared/types/index.js";
import { conversationKey, parseConversationKey } from "../shared/types/index.js";
import { resolveChannelCredential } from "../shared/channels.js";
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

    // The MCP server needs RONDEL_BOT_TOKEN for direct Telegram API calls
    const botToken = resolveChannelCredential(template.config, "telegram");

    // --- Build MCP config ---
    const mcpConfig: McpConfigMap = {
      // Rondel's own MCP server — always present
      rondel: {
        command: "node",
        args: [this.mcpServerPath],
        env: {
          ...(botToken ? { RONDEL_BOT_TOKEN: botToken } : {}),
          RONDEL_BRIDGE_URL: this.bridgeUrl(),
          RONDEL_PARENT_AGENT: template.name,
          RONDEL_PARENT_CHAT_ID: chatId,
          ...(template.config.admin ? { RONDEL_AGENT_ADMIN: "1" } : {}),
          ...extraMcpEnv,
        },
      },
      // User-defined MCP servers from agent.json
      ...template.config.mcp?.servers,
    };

    // --- Resolve session: existing entry → resume, new → fresh session ID ---
    const existingEntry = this.sessionIndex[key];
    let sessionId: string;
    let resume: boolean;

    if (existingEntry) {
      sessionId = existingEntry.sessionId;
      resume = true;
      this.log.info(`Resuming session ${sessionId} for ${key}`);
      this.hooks?.emit("session:resumed", { agentName: template.name, chatId, sessionId });
    } else {
      sessionId = randomUUID();
      resume = false;
      this.log.info(`New session ${sessionId} for ${key}`);
      this.hooks?.emit("session:start", { agentName: template.name, chatId, sessionId });
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
    const process = new AgentProcess(template.config, template.systemPrompt, this.log, mcpConfig, sessionOptions, template.agentDir);

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

    // Translate AgentProcess state changes into RondelHooks for the ledger
    process.on("stateChange", (state) => {
      if (state === "crashed") {
        this.hooks?.emit("session:crash", { agentName: template.name, chatId, sessionId });
      } else if (state === "halted") {
        this.hooks?.emit("session:halt", { agentName: template.name, chatId, sessionId });
      }
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

  /** Restart a conversation's process (kill + relaunch with --resume). */
  restart(agentName: string, channelType: string, chatId: string): boolean {
    const key = conversationKey(agentName, channelType, chatId);
    const process = this.conversations.get(key);
    if (!process) return false;
    this.log.info(`Restarting conversation: ${agentName} @ ${channelType}:${chatId}`);
    process.restart();
    return true;
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
    this.hooks?.emit("session:reset", { agentName, chatId });

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
}

