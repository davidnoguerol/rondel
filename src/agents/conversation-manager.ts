/**
 * Conversation lifecycle manager.
 *
 * Owns the per-conversation Claude CLI process lifecycle and session persistence.
 * Each unique (agentName, chatId) pair gets its own isolated process — agent config
 * is a template, not a singleton. Three users messaging the same bot = three
 * independent Claude instances.
 *
 * Session persistence follows OpenClaw's two-layer model:
 * - Layer 1: Session index (sessions.json) — maps conversation keys to Claude CLI session IDs
 * - Layer 2: Transcripts (JSONL) — append-only conversation history per session
 *
 * The conversation key ({agentName}:{chatId}) is permanent and used for routing.
 * The session ID is mutable — it rotates on /new and can be replaced without
 * changing the routing key. Don't conflate these.
 */

import { AgentProcess, type McpConfigMap, type AgentProcessSessionOptions } from "./agent-process.js";
import { resolveTranscriptPath, createTranscript } from "../shared/transcript.js";
import { atomicWriteFile } from "../shared/atomic-file.js";
import type { AgentConfig, AgentState, SessionIndex } from "../shared/types.js";
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
  readonly conversationKey: string;
  readonly chatId: string;
  readonly state: AgentState;
  readonly sessionId: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build the canonical conversation key used for routing and process lookup. */
export function conversationKey(agentName: string, chatId: string): string {
  return `${agentName}:${chatId}`;
}

/** Decompose a conversation key back into its parts. */
export function parseConversationKey(key: string): [string, string] {
  const idx = key.indexOf(":");
  return [key.slice(0, idx), key.slice(idx + 1)];
}

// ---------------------------------------------------------------------------
// ConversationManager
// ---------------------------------------------------------------------------

export class ConversationManager {
  /** Active per-conversation processes: conversationKey → AgentProcess. */
  private readonly conversations = new Map<string, AgentProcess>();

  /** Session index: conversation key → session entry. Persisted to disk. */
  private sessionIndex: SessionIndex = {};

  private readonly log: Logger;

  constructor(
    private readonly stateDir: string,
    private readonly mcpServerPath: string,
    private readonly bridgeUrl: () => string,
    log: Logger,
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
      this.sessionIndex = JSON.parse(raw) as SessionIndex;
      const count = Object.keys(this.sessionIndex).length;
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
   * @param chatId - The chat/conversation identifier
   * @param extraMcpEnv - Additional env vars to pass to the MCP server (e.g. parent info)
   * @returns The AgentProcess, or undefined if template is missing
   */
  getOrSpawn(
    template: AgentTemplate,
    chatId: string,
    extraMcpEnv?: Record<string, string>,
  ): AgentProcess {
    const key = conversationKey(template.name, chatId);
    const existing = this.conversations.get(key);
    if (existing) return existing;

    this.log.info(`Spawning new conversation: ${template.name} @ chat ${chatId}`);

    // --- Build MCP config ---
    const mcpConfig: McpConfigMap = {
      // FlowClaw's own MCP server — always present
      flowclaw: {
        command: "node",
        args: [this.mcpServerPath],
        env: {
          FLOWCLAW_BOT_TOKEN: template.config.telegram.botToken,
          FLOWCLAW_BRIDGE_URL: this.bridgeUrl(),
          FLOWCLAW_PARENT_AGENT: template.name,
          FLOWCLAW_PARENT_CHAT_ID: chatId,
          ...(template.config.admin ? { FLOWCLAW_AGENT_ADMIN: "1" } : {}),
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
    } else {
      sessionId = randomUUID();
      resume = false;
      this.log.info(`New session ${sessionId} for ${key}`);
    }

    // --- Create/update session index entry ---
    const now = Date.now();
    this.sessionIndex[key] = {
      sessionId,
      agentName: template.name,
      chatId,
      createdAt: existingEntry?.createdAt ?? now,
      updatedAt: now,
    };

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
    const process = new AgentProcess(template.config, template.systemPrompt, this.log, mcpConfig, sessionOptions);

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

    process.start();
    this.conversations.set(key, process);

    // Persist session index (fire-and-forget)
    this.persistSessionIndex().catch(() => {});

    return process;
  }

  /** Get an existing conversation process (don't spawn). */
  get(agentName: string, chatId: string): AgentProcess | undefined {
    return this.conversations.get(conversationKey(agentName, chatId));
  }

  /** Restart a conversation's process (kill + relaunch with --resume). */
  restart(agentName: string, chatId: string): boolean {
    const key = conversationKey(agentName, chatId);
    const process = this.conversations.get(key);
    if (!process) return false;
    this.log.info(`Restarting conversation: ${agentName} @ chat ${chatId}`);
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
  resetSession(agentName: string, chatId: string): void {
    const key = conversationKey(agentName, chatId);

    // Remove the index entry — next spawn will create a fresh session
    delete this.sessionIndex[key];

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
      const [agentName, chatId] = parseConversationKey(key);
      info.push({
        agentName,
        conversationKey: key,
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
