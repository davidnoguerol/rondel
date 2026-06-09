// AgentProcessCompat — a drop-in replacement for AgentProcess backed by the
// claude-wrap SDK (which drives the interactive Claude CLI under a PTY on the
// subscription, never an API key). It re-emits rondel's exact AgentProcess
// events/methods so every consumer (conversation-manager, router, scheduler,
// ledger, bridge) is unchanged.
//
// State model mirrors the legacy AgentProcess (which the Router depends on):
//   - "idle" immediately after start() — the Router sends the first message
//     right away (anything other than idle/busy is dropped as "unavailable").
//   - "busy" on sendMessage; "idle" again on turnComplete.
// Because the interactive PTY isn't actually ready the instant start() returns,
// a message sent during that window is BUFFERED and flushed when claude-wrap
// emits `ready`. Subsequent messages arrive while "busy" and are queued by the
// Router, then drained on the next "idle".
//
// Other behavior notes:
//   - turnComplete cost is an ESTIMATE (token usage x price table), not the
//     CLI's authoritative total_cost_usd.
//   - Attachments are mounted via --add-dir and referenced by path.
//   - Crash recovery (backoff + daily halt) is reimplemented here on top of
//     claude-wrap's exit signal + AgentSession.restart().
import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { AgentSession, type SessionOptions, type SendOptions as CwSendOptions } from "claude-wrap";
import type { AgentConfig, AgentEvent, AgentState, ChannelAttachment } from "../shared/types/index.js";
import type { Logger } from "../shared/logger.js";
import { resolveFrameworkSkillsDir } from "../shared/paths.js";
import { appendTranscriptEntry } from "../shared/transcript.js";
import { FRAMEWORK_DISALLOWED_TOOLS, type McpConfigMap, type AgentProcessSessionOptions } from "./agent-process.js";

const MAX_CRASHES_PER_DAY = 5;
const CRASH_BACKOFF_MS = [5_000, 15_000, 30_000, 60_000, 120_000];
const FRAMEWORK_SKILLS_DIR = resolveFrameworkSkillsDir();

interface AgentProcessEvents {
  stateChange: [state: AgentState];
  response: [text: string, blockId?: string];
  response_delta: [blockId: string, chunk: string];
  turnComplete: [result: AgentEvent];
  error: [error: Error];
  sessionEstablished: [sessionId: string];
}

interface PendingSend {
  text: string;
  opts?: CwSendOptions;
}

export class AgentProcessCompat extends EventEmitter<AgentProcessEvents> {
  private readonly log: Logger;
  private readonly transcriptPath?: string;
  private readonly conversationAttachmentsDir?: string;
  private readonly cwOptions: SessionOptions;

  private session: AgentSession;
  private state: AgentState = "stopped";
  private sessionId = "";
  private stopping = false;
  private downHandled = false;
  private cwReady = false;
  private pendingSend: PendingSend | null = null;
  private crashesToday = 0;
  private crashCountResetDate = "";

  constructor(
    agentConfig: AgentConfig,
    systemPrompt: string,
    log: Logger,
    mcpConfig?: McpConfigMap,
    sessionOptions?: AgentProcessSessionOptions,
    agentDir?: string,
    conversationAttachmentsDir?: string,
  ) {
    super();
    this.log = log.child(agentConfig.agentName);
    this.transcriptPath = sessionOptions?.transcriptPath;
    this.conversationAttachmentsDir = conversationAttachmentsDir;
    if (sessionOptions?.sessionId) this.sessionId = sessionOptions.sessionId;

    const addDirs = [agentDir, FRAMEWORK_SKILLS_DIR, conversationAttachmentsDir].filter(
      (d): d is string => typeof d === "string" && d.length > 0,
    );

    this.cwOptions = {
      provider: "claude-code",
      cwd: agentConfig.workingDirectory ?? process.cwd(),
      sessionId: sessionOptions?.sessionId,
      resume: sessionOptions?.resume,
      model: agentConfig.model,
      systemPrompt,
      allowedTools: agentConfig.tools.allowed.length > 0 ? [...agentConfig.tools.allowed] : undefined,
      disallowedTools: [...FRAMEWORK_DISALLOWED_TOOLS, ...agentConfig.tools.disallowed],
      addDirs,
      mcpConfig: mcpConfig as SessionOptions["mcpConfig"],
      // rondel pre-blocks Bash/Write/Edit and routes them through its own MCP
      // tools, so the CLI never needs to prompt — bypass matches the legacy
      // --dangerously-skip-permissions behavior.
      permission: { mode: "bypassPermissions" },
    };

    this.session = new AgentSession(this.cwOptions);
    this.wire(this.session);
  }

  private wire(session: AgentSession): void {
    session.on("ready", (e) => {
      this.cwReady = true;
      this.sessionId = e.sessionId;
      this.emit("sessionEstablished", this.sessionId);
      this.flushPending();
    });
    session.on("text", (e) => {
      this.emit("response", e.text, e.blockId);
      if (this.transcriptPath) {
        appendTranscriptEntry(
          this.transcriptPath,
          { type: "assistant", message: { content: [{ type: "text", text: e.text }] }, timestamp: new Date().toISOString() },
          this.log,
        );
      }
    });
    session.on("textDelta", (e) => this.emit("response_delta", e.blockId ?? "", e.chunk));
    session.on("turnComplete", (tr) => {
      const result: AgentEvent = {
        type: "result",
        result: tr.text,
        session_id: this.sessionId,
        total_cost_usd: tr.costUsd ?? 0, // estimated; see header note
        is_error: tr.isError,
      };
      this.emit("turnComplete", result);
      // Only a real in-flight turn returns to idle; never override crashed/stopped.
      if (this.state === "busy") this.setState("idle");
    });
    session.on("error", (e) => this.emit("error", e instanceof Error ? e : new Error(e.message)));
    session.on("exit", () => {
      this.cwReady = false;
      this.handleDown();
    });
  }

  private flushPending(): void {
    if (!this.pendingSend || !this.cwReady) return;
    const { text, opts } = this.pendingSend;
    this.pendingSend = null;
    this.session.send(text, opts).catch((err: unknown) => {
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
    });
  }

  getState(): AgentState {
    return this.state;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  setSessionOptions(options: AgentProcessSessionOptions): void {
    if (options.sessionId) {
      this.sessionId = options.sessionId;
      this.cwOptions.sessionId = options.sessionId;
    }
    if (typeof options.resume === "boolean") this.cwOptions.resume = options.resume;
  }

  start(): void {
    this.stopping = false;
    this.downHandled = false;
    this.cwReady = false;
    // Optimistic idle (matches legacy AgentProcess): the Router sends the first
    // message immediately; sendMessage() buffers it until claude-wrap is ready.
    this.setState("idle");
    // Ensure the transcript dir exists before our user/assistant mirroring
    // appends (avoids racing conversation-manager's createTranscript).
    if (this.transcriptPath) {
      try {
        mkdirSync(dirname(this.transcriptPath), { recursive: true });
      } catch {
        /* */
      }
    }
    if (this.conversationAttachmentsDir) {
      try {
        mkdirSync(this.conversationAttachmentsDir, { recursive: true });
      } catch (err) {
        this.log.warn(`Failed to mkdir attachments dir: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    this.session.start().catch((err: unknown) => {
      this.log.warn(`session start failed: ${err instanceof Error ? err.message : String(err)}`);
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
      this.handleDown();
    });
  }

  async sendMessage(
    text: string,
    options?: { senderId?: string; senderName?: string; attachments?: readonly ChannelAttachment[] },
  ): Promise<void> {
    const attachments = options?.attachments?.map((a) => ({ path: a.path, name: a.originalName, mimeType: a.mimeType }));
    const opts: CwSendOptions = { attachments, senderId: options?.senderId, senderName: options?.senderName };
    if (this.transcriptPath) {
      appendTranscriptEntry(this.transcriptPath, { type: "user", text, timestamp: new Date().toISOString() }, this.log);
    }
    this.setState("busy");
    if (this.cwReady) {
      await this.session.send(text, opts);
    } else {
      // PTY not ready yet — buffer and flush on `ready`.
      this.pendingSend = { text, opts };
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.pendingSend = null;
    this.setState("stopped");
    await this.session.stop();
  }

  async restart(): Promise<void> {
    this.log.info("Restarting agent...");
    this.stopping = false;
    this.downHandled = false;
    this.cwReady = false;
    this.setState("idle");
    await this.session.restart();
  }

  private handleDown(): void {
    if (this.stopping || this.downHandled) return;
    this.downHandled = true;

    const today = new Date().toISOString().slice(0, 10);
    if (this.crashCountResetDate !== today) {
      this.crashesToday = 0;
      this.crashCountResetDate = today;
    }
    this.crashesToday++;

    if (this.crashesToday >= MAX_CRASHES_PER_DAY) {
      this.log.error(`Agent halted after ${this.crashesToday} crashes today`);
      this.setState("halted");
      return;
    }

    this.setState("crashed");
    const delay = CRASH_BACKOFF_MS[Math.min(this.crashesToday - 1, CRASH_BACKOFF_MS.length - 1)]!;
    this.log.info(`Scheduling restart in ${delay}ms (crash ${this.crashesToday}/${MAX_CRASHES_PER_DAY} today)`);
    setTimeout(() => {
      if (this.state === "crashed") this.doRestart();
    }, delay);
  }

  private doRestart(): void {
    this.downHandled = false;
    this.cwReady = false;
    this.setState("idle");
    this.session.restart().catch((err: unknown) => {
      this.log.warn(`restart failed: ${err instanceof Error ? err.message : String(err)}`);
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
      this.handleDown();
    });
  }

  private setState(newState: AgentState): void {
    if (this.state !== newState) {
      this.log.info(`State: ${this.state} → ${newState}`);
      this.state = newState;
      this.emit("stateChange", newState);
    }
  }
}
