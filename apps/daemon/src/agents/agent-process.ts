import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import { writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import type { AgentConfig, AgentEvent, AgentState, McpServerEntry } from "../shared/types/index.js";
import type { Logger } from "../shared/logger.js";
import { resolveFrameworkSkillsDir } from "../shared/paths.js";
import { appendTranscriptEntry } from "../shared/transcript.js";

const MAX_CRASHES_PER_DAY = 5;

const FRAMEWORK_SKILLS_DIR = resolveFrameworkSkillsDir();

/**
 * Escalating restart delays based on consecutive crash count.
 * Crash #1 restarts quickly (transient glitch). Each subsequent crash
 * delays longer, giving persistent issues time to resolve and avoiding
 * rapid-fire API calls. The user can always /restart immediately.
 */
const CRASH_BACKOFF_MS = [5_000, 15_000, 30_000, 60_000, 120_000]; // 5s, 15s, 30s, 60s, 2m

/**
 * Time window (ms) to detect resume failures.
 * If the process exits within this window after spawning with --resume,
 * we assume the session couldn't be restored and fall back to fresh.
 */
const RESUME_FAILURE_WINDOW_MS = 10_000;

/**
 * Built-in Claude CLI tools that Rondel always disallows because it
 * supersedes them with managed MCP equivalents.
 *
 * - Agent: Rondel owns delegation via rondel_spawn_subagent. The built-in
 *   Agent tool is untracked — Rondel can't monitor, kill, or budget it.
 *
 * This list is a framework invariant, not a per-agent config choice.
 * User-configured disallowedTools in agent.json are merged on top.
 */
export const FRAMEWORK_DISALLOWED_TOOLS: readonly string[] = ["Agent"];

/**
 * Complete MCP config passed to Claude CLI via --mcp-config.
 * Maps server names to their launch configs.
 * Rondel's own server is merged with any user-defined servers from agent.json.
 */
export type McpConfigMap = Readonly<Record<string, McpServerEntry>>;

/** Options for session-aware spawning. */
export interface AgentProcessSessionOptions {
  /** Session ID to use. If resuming, this is the session to restore. */
  readonly sessionId?: string;
  /** If true, spawn with --resume instead of --session-id. */
  readonly resume?: boolean;
  /** Path to the transcript JSONL file. If set, all events are appended. */
  readonly transcriptPath?: string;
}

interface AgentProcessEvents {
  stateChange: [state: AgentState];
  /**
   * Fired once per complete text block from the model. The optional
   * `blockId` (format: `${messageId}:${index}`) correlates this complete
   * block with the corresponding `response_delta` stream. Present when
   * partial-message streaming is active; absent otherwise (defensive —
   * downstream callers should treat blockId as a hint, not an invariant).
   */
  response: [text: string, blockId?: string];
  /**
   * Fired for each text chunk emitted during streaming (between
   * content_block_start and content_block_stop). The `blockId` matches
   * the corresponding `response` event's blockId. Callers that want
   * token-level UX should accumulate chunks by blockId and reconcile
   * against the final `response` event as the source of truth —
   * "deltas are hints, blocks are truth".
   */
  response_delta: [blockId: string, chunk: string];
  turnComplete: [result: AgentEvent];
  error: [error: Error];
  sessionEstablished: [sessionId: string];
}

export class AgentProcess extends EventEmitter<AgentProcessEvents> {
  private process: ChildProcess | null = null;
  private sessionId: string = "";
  private state: AgentState = "stopped";
  private crashesToday = 0;
  private crashCountResetDate: string = "";
  private readonly log: Logger;
  private mcpConfigPath: string | null = null;
  private spawnedAt: number = 0;

  /**
   * Id of the currently-streaming Anthropic message, captured from the
   * `message_start` event inside `stream_event`. Used together with the
   * content block index to construct a globally-unique `blockId` of the
   * form `${messageId}:${index}` for both `response_delta` (streaming
   * chunks) and `response` (complete blocks). Cleared on turn boundaries
   * so a stale id can't leak across turns.
   */
  private currentMessageId: string | null = null;

  private sessionOptions: AgentProcessSessionOptions;

  constructor(
    private readonly agentConfig: AgentConfig,
    private readonly systemPrompt: string,
    log: Logger,
    private readonly mcpConfig?: McpConfigMap,
    sessionOptions?: AgentProcessSessionOptions,
    private readonly agentDir?: string,
  ) {
    super();
    this.log = log.child(agentConfig.agentName);
    this.sessionOptions = sessionOptions ?? {};

    // If we have a session ID from a previous run, set it now
    if (this.sessionOptions.sessionId) {
      this.sessionId = this.sessionOptions.sessionId;
    }
  }

  getState(): AgentState {
    return this.state;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  /** Update session options (e.g., after a session reset). */
  setSessionOptions(options: AgentProcessSessionOptions): void {
    this.sessionOptions = options;
    if (options.sessionId) {
      this.sessionId = options.sessionId;
    }
  }

  /** Spawn the claude CLI process with stream-json I/O. */
  start(): void {
    if (this.process) {
      this.log.warn("Agent already running — ignoring start()");
      return;
    }

    this.setState("starting");
    this.writeMcpConfigFile();

    const args = [
      "-p",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      // Emit `stream_event` events carrying Anthropic's raw message/
      // content-block deltas. Required for token-level streaming in the
      // web chat UI. The legacy block-complete `assistant` event continues
      // to fire — delta consumers treat chunks as hints and reconcile
      // against the complete block as the source of truth.
      "--include-partial-messages",
      "--model", this.agentConfig.model,
      "--system-prompt", this.systemPrompt,
    ];

    if (this.agentConfig.permissionMode === "bypassPermissions") {
      args.push("--dangerously-skip-permissions");
    }

    if (this.agentConfig.tools.allowed.length > 0) {
      args.push("--allowedTools", ...this.agentConfig.tools.allowed);
    }

    const disallowed = new Set([...FRAMEWORK_DISALLOWED_TOOLS, ...this.agentConfig.tools.disallowed]);
    if (disallowed.size > 0) {
      args.push("--disallowedTools", ...disallowed);
    }

    if (this.mcpConfigPath) {
      args.push("--mcp-config", this.mcpConfigPath);
    }

    // Skill discovery: --add-dir for per-agent and framework skills
    if (this.agentDir) {
      args.push("--add-dir", this.agentDir);
    }
    args.push("--add-dir", FRAMEWORK_SKILLS_DIR);

    // Session persistence: --resume for existing sessions, --session-id for new ones
    if (this.sessionOptions.resume && this.sessionOptions.sessionId) {
      args.push("--resume", this.sessionOptions.sessionId);
      this.log.info(`Resuming session: ${this.sessionOptions.sessionId}`);
    } else if (this.sessionOptions.sessionId) {
      args.push("--session-id", this.sessionOptions.sessionId);
      this.log.info(`Starting session: ${this.sessionOptions.sessionId}`);
    }

    this.log.info("Spawning claude process...");
    this.log.debug(`Args: claude ${args.join(" ")}`);

    const child = spawn("claude", args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: this.agentConfig.workingDirectory ?? undefined,
      env: process.env,
    });

    this.process = child;
    this.spawnedAt = Date.now();

    // Parse newline-delimited JSON from stdout
    const rl = createInterface({ input: child.stdout! });
    rl.on("line", (line) => this.handleStdoutLine(line));

    // Capture stderr for diagnostics
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) this.log.warn(`stderr: ${text}`);
    });

    child.on("exit", (code, signal) => this.handleExit(code, signal));

    child.on("error", (err) => {
      this.log.error("Failed to spawn claude process:", err.message);
      this.setState("crashed");
      this.emit("error", err);
    });

    // stream-json doesn't emit init until first message is sent,
    // so transition to idle immediately — the process is ready to receive.
    this.setState("idle");
    this.log.info("Agent process spawned — ready to receive messages");
  }

  /** Send a user message to the agent via stdin. */
  sendMessage(text: string, senderInfo?: { senderId?: string; senderName?: string }): void {
    if (!this.process?.stdin?.writable) {
      this.log.error("Cannot send message — agent process not running");
      return;
    }

    this.setState("busy");

    const message = JSON.stringify({
      type: "user",
      session_id: this.sessionId,
      message: {
        role: "user",
        content: text,
      },
      parent_tool_use_id: null,
    });

    this.process.stdin.write(message + "\n");
    this.log.info(`Sent message (${text.length} chars)`);

    // Append user message to transcript
    if (this.sessionOptions.transcriptPath) {
      appendTranscriptEntry(this.sessionOptions.transcriptPath, {
        type: "user",
        text,
        senderId: senderInfo?.senderId,
        senderName: senderInfo?.senderName,
        timestamp: new Date().toISOString(),
      }, this.log);
    }
  }

  /** Kill the agent process. */
  stop(): void {
    // Set state BEFORE killing so handleExit knows this was intentional.
    this.setState("stopped");
    if (this.process) {
      this.log.info("Stopping agent process...");
      this.process.kill("SIGTERM");
      this.process = null;
    }
    this.cleanupMcpConfigFile();
  }

  /** Kill and restart the agent. */
  restart(): void {
    this.log.info("Restarting agent...");
    // Invariant relied on by Router.consumePendingRestart → drainQueue skipping:
    // stop() sets state to "stopped" synchronously (see stop() above), and
    // handleExit() early-returns on state=="stopped", so no "idle" transition
    // can be emitted during the gap between stop() and the respawn below.
    // The Router is therefore safe to return from its idle handler without
    // draining — the fresh process will emit its own idle when it's ready.
    //
    // Session continuity is handled by the `system init` handler, which flips
    // sessionOptions into resume mode the first time the CLI confirms the
    // session exists on disk. We don't need to touch sessionOptions here.
    this.stop();
    // Small delay to ensure clean shutdown before respawn
    setTimeout(() => this.start(), 1_000);
  }

  private handleStdoutLine(line: string): void {
    if (!line.trim()) return;

    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.log.warn(`Non-JSON stdout line: ${line.slice(0, 200)}`);
      return;
    }

    // Append raw stream-json event to transcript (every event, as-is)
    if (this.sessionOptions.transcriptPath) {
      appendTranscriptEntry(this.sessionOptions.transcriptPath, raw, this.log);
    }

    const eventType = raw.type as string | undefined;

    switch (eventType) {
      case "system":
        if (raw.subtype === "init" && typeof raw.session_id === "string") {
          this.sessionId = raw.session_id;
          this.log.info(`Session established: ${this.sessionId}`);
          // Session now exists on CLI's disk. From this moment on, any
          // future spawn of this AgentProcess — whether via restart() or
          // crash recovery — must use --resume, not --session-id, or it
          // will name a second fresh session and lose context. Flip the
          // knob once, here, at the moment reality changes.
          this.sessionOptions = {
            ...this.sessionOptions,
            sessionId: this.sessionId,
            resume: true,
          };
          this.emit("sessionEstablished", this.sessionId);
        }
        break;

      case "stream_event":
        this.handleStreamEvent(raw);
        break;

      case "assistant": {
        // Emit each text block as a complete `response` event. This is the
        // "source of truth" emission — streaming consumers accumulate deltas
        // per blockId, then replace their partial buffer with this canonical
        // text. Non-streaming consumers (Telegram, ledger) only subscribe to
        // this event and see the same behavior as before.
        const message = raw.message as
          | { id?: string; content?: readonly { type: string; text?: string }[] }
          | undefined;
        if (message?.content) {
          // Prefer the message id carried on the `assistant` event itself.
          // Fall back to whatever `currentMessageId` we captured from a prior
          // `stream_event` (same id in practice, belt-and-suspenders in case
          // partial streaming is disabled by a flag change upstream).
          const messageId = message.id ?? this.currentMessageId ?? null;
          let index = 0;
          for (const block of message.content) {
            if (block.type === "text" && block.text) {
              const blockId = messageId ? `${messageId}:${index}` : undefined;
              this.emit("response", block.text, blockId);
            }
            // Index advances over ALL content blocks, not just text ones —
            // tool_use and thinking blocks consume indices too. This keeps
            // the blockId aligned with the delta stream's `index` field.
            index++;
          }
        }
        break;
      }

      case "result": {
        // Turn boundary — clear message id so nothing from a stale turn
        // can leak into the next one.
        this.currentMessageId = null;
        this.setState("idle");
        this.emit("turnComplete", raw as unknown as AgentEvent);
        if (typeof raw.total_cost_usd === "number") {
          this.log.info(`Turn complete — cost: $${raw.total_cost_usd}`);
        }
        break;
      }

      default:
        this.log.debug(`Unhandled event type: ${eventType}`);
    }
  }

  /**
   * Handle a `stream_event` line from Claude CLI.
   *
   * These carry Anthropic's raw Messages API SSE payloads — `message_start`,
   * `content_block_start`, `content_block_delta`, `content_block_stop`,
   * `message_delta`, `message_stop`. We only act on two:
   *
   *  1. `message_start` — capture `message.id` into `currentMessageId` so
   *     subsequent deltas can be tagged with a stable blockId.
   *  2. `content_block_delta` with `delta.type === "text_delta"` — emit a
   *     `response_delta` event with the accumulated chunk. Non-text deltas
   *     (tool_use input_json, thinking) are silently ignored.
   *
   * If `currentMessageId` is unset when a delta arrives (e.g. partial
   * streaming disabled server-side, events out of order), we drop the
   * delta rather than fabricate a blockId. The complete `response` event
   * that will follow is the source of truth, so the user just sees a
   * slightly less smooth stream — never missing or duplicated text.
   */
  private handleStreamEvent(raw: Record<string, unknown>): void {
    const inner = raw.event as Record<string, unknown> | undefined;
    if (!inner || typeof inner.type !== "string") return;

    switch (inner.type) {
      case "message_start": {
        const message = inner.message as { id?: string } | undefined;
        if (typeof message?.id === "string") {
          this.currentMessageId = message.id;
        }
        return;
      }

      case "content_block_delta": {
        if (!this.currentMessageId) return;
        const index = typeof inner.index === "number" ? inner.index : null;
        if (index === null) return;
        const delta = inner.delta as { type?: string; text?: string } | undefined;
        if (!delta || delta.type !== "text_delta") return;
        if (typeof delta.text !== "string" || delta.text.length === 0) return;

        const blockId = `${this.currentMessageId}:${index}`;
        this.emit("response_delta", blockId, delta.text);
        return;
      }

      case "message_stop": {
        // Keep `currentMessageId` alive until `result` fires — a single turn
        // can contain multiple Anthropic messages (text → tool use → more
        // text = two messages). The next `message_start` will overwrite it.
        return;
      }

      default:
        // content_block_start, content_block_stop, message_delta — noise.
        return;
    }
  }

  private handleExit(code: number | null, signal: string | null): void {
    this.process = null;
    this.log.warn(`Agent process exited — code: ${code}, signal: ${signal}`);

    // If stop() was called, state is already "stopped" — don't enter crash recovery.
    if (this.state === "stopped") {
      return;
    }

    // Detect resume failure: process exited quickly after spawning with --resume.
    // Fall back to fresh session on next spawn. No exit code check — Claude CLI
    // exits 0 even on "No conversation found" errors.
    const timeSinceSpawn = Date.now() - this.spawnedAt;
    if (this.sessionOptions.resume && timeSinceSpawn < RESUME_FAILURE_WINDOW_MS) {
      this.log.warn(`Resume failed (exited in ${timeSinceSpawn}ms) — will start fresh session on next spawn`);
      this.sessionOptions = {
        ...this.sessionOptions,
        resume: false,
      };
      this.emit("error", new Error("resume_failed"));
    }

    // Reset daily crash counter if it's a new day
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

    const delay = CRASH_BACKOFF_MS[Math.min(this.crashesToday - 1, CRASH_BACKOFF_MS.length - 1)];
    this.log.info(`Scheduling restart in ${delay}ms (crash ${this.crashesToday}/${MAX_CRASHES_PER_DAY} today)`);

    // No explicit resume flip needed here — if the session was ever
    // established, the `system init` handler already flipped sessionOptions
    // into resume mode. Crash recovery just calls start() and inherits it.

    setTimeout(() => {
      if (this.state === "crashed") {
        this.start();
      }
    }, delay);
  }

  /**
   * Write a temporary MCP config file for Claude CLI.
   * Called before each spawn — creates a fresh file so restarts pick up any changes.
   */
  private writeMcpConfigFile(): void {
    if (!this.mcpConfig || Object.keys(this.mcpConfig).length === 0) {
      this.mcpConfigPath = null;
      return;
    }

    const dir = join(tmpdir(), "rondel-mcp");
    mkdirSync(dir, { recursive: true });

    const id = randomBytes(4).toString("hex");
    const filePath = join(dir, `mcp-${this.agentConfig.agentName}-${id}.json`);

    const config = { mcpServers: this.mcpConfig };

    writeFileSync(filePath, JSON.stringify(config), "utf-8");
    this.mcpConfigPath = filePath;
    this.log.info(`MCP config written: ${filePath} (${Object.keys(this.mcpConfig).length} servers)`);
  }

  /** Clean up the temporary MCP config file. */
  private cleanupMcpConfigFile(): void {
    if (this.mcpConfigPath) {
      try {
        unlinkSync(this.mcpConfigPath);
      } catch {
        // File may already be gone
      }
      this.mcpConfigPath = null;
    }
  }

  private setState(newState: AgentState): void {
    if (this.state !== newState) {
      this.log.info(`State: ${this.state} → ${newState}`);
      this.state = newState;
      this.emit("stateChange", newState);
    }
  }
}
