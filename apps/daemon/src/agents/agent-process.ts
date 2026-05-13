import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import { writeFileSync, mkdirSync, unlinkSync, existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import type { AgentConfig, AgentEvent, AgentState, ChannelAttachment, McpServerEntry } from "../shared/types/index.js";
import type { Logger } from "../shared/logger.js";
import { resolveFrameworkSkillsDir } from "../shared/paths.js";
import { appendTranscriptEntry } from "../shared/transcript.js";

/**
 * Max raw bytes inlined as base64 image content blocks in a single user
 * turn. Anything larger gets demoted to a manifest reference and the
 * agent reads it via tools (`Read` / `rondel_read_file`) against the
 * per-conversation attachments `--add-dir`. Base64 adds ~33% overhead,
 * so 4 MB raw ≈ 5.3 MB on the wire — well inside Claude's per-message
 * tolerance while still covering the bulk of phone-camera photos.
 */
const MAX_INLINED_IMAGE_BYTES = 4 * 1024 * 1024;

/** MIME types Claude's image content block accepts. */
const CLAUDE_IMAGE_MIME_ALLOWLIST = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

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
 * Maximum time to wait for SIGTERM cleanup before escalating to SIGKILL.
 * Used by `stop()`'s exit handshake. Five seconds is generous for Claude
 * CLI's normal shutdown; anything longer is a stuck process we want gone.
 */
const STOP_TIMEOUT_MS = 5_000;

/**
 * Built-in Claude CLI tools that Rondel always disallows. Each is
 * unconditionally blocked at spawn time — this is a framework invariant,
 * not a per-agent config choice. User-configured disallowedTools in
 * agent.json are merged on top.
 *
 * Three tools have no Rondel equivalent (no runtime surface):
 *
 * - `Agent`: Rondel owns delegation via `rondel_spawn_subagent`. The
 *   built-in Agent tool is untracked — Rondel can't monitor, kill, or
 *   budget it.
 * - `ExitPlanMode`: TTY-only Claude Code tool for the plan-mode
 *   approve/reject flow. No UI surface in headless `-p --input-format
 *   stream-json` mode, and we have no use case for plan mode in
 *   long-running agents.
 * - `AskUserQuestion`: TTY-only interactive prompt. The stream-json
 *   runtime has nowhere to render it. Agents should ask in plain-text
 *   prose (the structured `rondel_ask_user` tool ships in Phase 5).
 *
 * Four tools are replaced by first-class Rondel MCP tools implemented
 * in `apps/daemon/src/tools/` — Rondel owns the safety
 * classifier, approval routing, ledger emission, and backup/history
 * layer for each:
 *
 * - `Bash` → `rondel_bash` (safety classifier + human approval for
 *   dangerous patterns, ledger emit).
 * - `Write` → `rondel_write_file` (read-first staleness check,
 *   pre-write backup, secret scan, safe-zone enforcement).
 * - `Edit` → `rondel_edit_file` (read-first required, backup, secret
 *   scan).
 * - `MultiEdit` → `rondel_multi_edit_file` (atomic multi-edit with the
 *   same invariants as `rondel_edit_file`).
 *
 * Three scheduling tools are replaced by the `rondel_schedule_*`
 * family — Rondel owns durable runtime schedules (survive restarts,
 * no TTL, channel-aware delivery). See
 * `apps/daemon/src/scheduling/schedule-service.ts`:
 *
 * - `CronCreate`, `CronDelete`, `CronList`: session-only (die on CLI
 *   exit) and Claude Code caps them at 7 days. Unfit for anything a
 *   user expects to persist. Use `rondel_schedule_{create,list,update,
 *   delete,run}` instead. `ScheduleWakeup` is NOT disallowed — it's a
 *   short in-turn wait with a different purpose.
 *
 * Empirical note: `--disallowedTools` correctly blocks deferred tools
 * (tested 2026-04-18 against the cron family — Claude reports
 * "CronCreate is not an available deferred tool" when queried).
 */
export const FRAMEWORK_DISALLOWED_TOOLS: readonly string[] = [
  "Agent",
  "ExitPlanMode",
  "AskUserQuestion",
  "Bash",
  "Write",
  "Edit",
  "MultiEdit",
  "CronCreate",
  "CronDelete",
  "CronList",
];

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
   * Promise that resolves when the *currently-running* child process has
   * fully exited (and the in-process exit handler has run). Created at
   * the top of every `start()`, resolved by `handleExit`. Used by
   * `restart()` to await actual exit before respawning, replacing the
   * old hardcoded 1s delay that races SIGTERM cleanup.
   */
  private exitWaiter: Promise<void> | null = null;

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

  /** Resolver for `exitWaiter`. Invoked once from `handleExit`. */
  private resolveExitWaiter: (() => void) | null = null;

  constructor(
    private readonly agentConfig: AgentConfig,
    private readonly systemPrompt: string,
    log: Logger,
    private readonly mcpConfig?: McpConfigMap,
    sessionOptions?: AgentProcessSessionOptions,
    private readonly agentDir?: string,
    /**
     * Absolute path of the per-conversation attachments directory.
     * When set, the directory is created at spawn time (if missing) and
     * mounted into the spawned Claude CLI via `--add-dir`, so the agent
     * can `Read` inbound files staged by the channel adapter.
     */
    private readonly conversationAttachmentsDir?: string,
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

    // Native Bash/Write/Edit/MultiEdit live on FRAMEWORK_DISALLOWED_TOOLS
    // and every shell/filesystem operation routes through a first-class
    // rondel_* MCP tool with its own inline classifier. Safety is therefore
    // our responsibility, not Claude's.
    //
    // `--dangerously-skip-permissions` puts the CLI into bypassPermissions
    // mode — tool calls that would otherwise prompt the user for approval
    // are auto-allowed. We need this in headless stream-json mode because
    // the CLI's interactive approval prompt has no surface to render to:
    // without it, any tool call reaching the permission gate would block
    // indefinitely waiting for input that never comes.
    //
    // It's complementary to, not a replacement for, FRAMEWORK_DISALLOWED_TOOLS
    // — the disallow list is the hard safety net; this flag just prevents
    // the CLI from deadlocking on permission UI.
    args.push("--dangerously-skip-permissions");

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

    // Skill discovery: --add-dir for per-agent and framework skills.
    if (this.agentDir) {
      args.push("--add-dir", this.agentDir);
    }
    args.push("--add-dir", FRAMEWORK_SKILLS_DIR);

    // Inbound attachments: per-conversation directory where the channel
    // adapter stages files (photos, documents, voice notes, video). The
    // CLI needs read access so `Read` / `rondel_read_file` work without
    // additional permission prompts. We mkdir up front because the user
    // could send a file before the agent has emitted anything, and
    // `--add-dir` would otherwise log a missing-path warning.
    //
    // If mkdir fails (permissions, disk pressure), skip the `--add-dir`
    // entirely rather than pointing the CLI at a missing path —
    // attachments will surface as manifest-only paths, which the
    // existsSync gate in buildUserMessage already handles gracefully.
    if (this.conversationAttachmentsDir) {
      let attachmentsDirReady = false;
      try {
        mkdirSync(this.conversationAttachmentsDir, { recursive: true });
        attachmentsDirReady = true;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.log.warn(`Failed to mkdir attachments dir ${this.conversationAttachmentsDir}: ${message}`);
      }
      if (attachmentsDirReady) {
        args.push("--add-dir", this.conversationAttachmentsDir);
      }
    }

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

    // cwd: user-configured workingDirectory, otherwise inherit from parent.
    // The framework no longer owns a runtime dir — the MCP config (written
    // via writeMcpConfigFile) carries the RONDEL_PARENT_* env the MCP
    // server process reads; the Claude CLI's own env doesn't need them.
    const cwd = this.agentConfig.workingDirectory ?? undefined;

    const child = spawn("claude", args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd,
      env: process.env,
    });

    this.process = child;
    this.spawnedAt = Date.now();

    // Set up the exit handshake. handleExit() resolves this promise so
    // stop() (and through it, restart()) can await actual termination
    // instead of guessing with a fixed timeout.
    this.exitWaiter = new Promise<void>((resolve) => {
      this.resolveExitWaiter = resolve;
    });

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

  /**
   * Send a user message to the agent via stdin.
   *
   * Text-only messages preserve today's exact wire format:
   * `{ message: { role: "user", content: "<string>" }, ... }`.
   *
   * When `options.attachments` is non-empty, the wire format switches to
   * the multi-part shape Claude CLI accepts on stream-JSON input —
   * `content` becomes an array of `{type:"text"}` and `{type:"image"}`
   * blocks. Images small enough to inline are base64-encoded; everything
   * else (oversized images, non-image kinds) is summarised in the
   * leading text block as an "attachments manifest" with the absolute
   * staged path, so the model can decide whether to `Read` the bytes
   * itself.
   *
   * Async because attachment ingestion may read several MB off disk to
   * base64-encode — doing that synchronously would block the daemon's
   * event loop and stall every other conversation. Router call sites
   * already run inside the per-conversation `AsyncLock`, so awaiting
   * here doesn't expand the locking surface.
   */
  async sendMessage(
    text: string,
    options?: {
      senderId?: string;
      senderName?: string;
      attachments?: readonly ChannelAttachment[];
    },
  ): Promise<void> {
    if (!this.process?.stdin?.writable) {
      this.log.error("Cannot send message — agent process not running");
      return;
    }

    this.setState("busy");

    const attachments = options?.attachments ?? [];
    const userMessage = await this.buildUserMessage(text, attachments);
    const wire = JSON.stringify({
      type: "user",
      session_id: this.sessionId,
      message: userMessage,
      parent_tool_use_id: null,
    });

    this.process.stdin.write(wire + "\n");

    if (attachments.length === 0) {
      this.log.info(`Sent message (${text.length} chars)`);
    } else {
      this.log.info(
        `Sent message (${text.length} chars + ${attachments.length} attachment(s); ` +
        `${attachments.filter((a) => a.kind === "image").length} image(s))`,
      );
    }

    // Append user message to transcript. We persist the composed text
    // (caption + manifest) so the transcript captures what the agent
    // actually saw; the attachments array carries enough metadata for a
    // later reader to reconstruct the message.
    if (this.sessionOptions.transcriptPath) {
      const transcriptText = typeof userMessage.content === "string"
        ? userMessage.content
        : extractTextFromContentBlocks(userMessage.content);
      appendTranscriptEntry(this.sessionOptions.transcriptPath, {
        type: "user",
        text: transcriptText,
        senderId: options?.senderId,
        senderName: options?.senderName,
        timestamp: new Date().toISOString(),
        ...(attachments.length > 0 ? { attachments: attachments.map(stripBytesForTranscript) } : {}),
      } as Record<string, unknown>, this.log);
    }
  }

  /**
   * Assemble the `message` payload sent to Claude CLI's stdin. Returns
   * a string-content message for the no-attachment fast path; a
   * multi-part array otherwise.
   */
  private async buildUserMessage(text: string, attachments: readonly ChannelAttachment[]): Promise<UserMessagePayload> {
    if (attachments.length === 0) {
      return { role: "user", content: text };
    }

    const manifestLines: string[] = [];
    const imageBlocks: ImageContentBlock[] = [];
    let remainingBudget = MAX_INLINED_IMAGE_BYTES;

    for (const a of attachments) {
      // Manifest pre-check: if the staged file disappeared (24 h
      // cleanup pruned it while this message sat in a persisted queue,
      // a developer rm'd it, etc.), produce a clear manifest line
      // rather than handing the agent a path it'll only discover is
      // dead when it tries to read it.
      if (!this.isPathInsideAttachmentsDir(a.path)) {
        this.log.warn(
          `Refusing attachment outside per-conversation dir: ${a.path}`,
        );
        manifestLines.push(
          `  - ${describeAttachmentKind(a)}: path rejected (outside per-conversation attachments directory)`,
        );
        continue;
      }
      if (!existsSync(a.path)) {
        manifestLines.push(
          `  - ${describeAttachmentKind(a)} (${formatBytes(a.bytes)}, ${a.mimeType}): ` +
          `file no longer available (likely pruned after the 24 h staging window)`,
        );
        continue;
      }
      if (a.kind === "image") {
        const inlined = await this.tryInlineImage(a, remainingBudget);
        if (inlined) {
          imageBlocks.push(inlined.block);
          remainingBudget -= inlined.rawBytes;
          manifestLines.push(`  - image (inlined, ${formatBytes(a.bytes)}, ${a.mimeType}) → ${a.path}`);
          continue;
        }
        manifestLines.push(
          `  - image (${formatBytes(a.bytes)}, ${a.mimeType}, NOT inlined) → ${a.path}  ` +
          `[read with rondel_read_file if you need to look at the bytes]`,
        );
        continue;
      }
      manifestLines.push(`  - ${describeAttachmentKind(a)} (${formatBytes(a.bytes)}, ${a.mimeType}) → ${a.path}`);
    }

    const header = text ? `${text}\n\n` : "";
    const composed =
      `${header}[Rondel: the user sent ${attachments.length} attachment(s) with this message]\n` +
      manifestLines.join("\n") + "\n\n" +
      `Paths above are absolute and readable via Read / rondel_read_file ` +
      `(the per-conversation attachments directory is mounted via --add-dir). ` +
      `Inlined images are already visible in this turn's content; you do not need to read them again.`;

    return {
      role: "user",
      content: [
        { type: "text", text: composed },
        ...imageBlocks,
      ],
    };
  }

  /**
   * Path-traversal guard for attachment paths. A `ChannelAttachment` is
   * normally constructed by an adapter that stages bytes through
   * `AttachmentStore`, which sanitises the per-conversation segments —
   * but queued messages persist `attachments[]` to disk and are
   * replayed on startup, so a hostile actor with write access to the
   * queue file could in principle inject a path that points outside
   * `state/attachments/{agent}/{chatId}/`. We refuse those rather than
   * happily base64-inlining `/etc/passwd`.
   *
   * Returns `true` when no `conversationAttachmentsDir` is configured
   * (no media support → no path-traversal surface either) or when the
   * given path resolves under that directory.
   */
  private isPathInsideAttachmentsDir(p: string): boolean {
    if (!this.conversationAttachmentsDir) return true;
    if (!isAbsolute(p)) return false;
    const root = resolve(this.conversationAttachmentsDir);
    const target = resolve(p);
    const rel = relative(root, target);
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  }

  /**
   * Read an image attachment off disk and return a base64 content block
   * if its size fits inside `budget` and its MIME is in Claude's image
   * allowlist. Returns `null` to signal "skip inlining, manifest-only".
   *
   * Uses `fs/promises` so the daemon event loop keeps moving while we
   * pull megabytes off disk — otherwise every other conversation
   * stalls until this one's photo finishes encoding.
   */
  private async tryInlineImage(a: ChannelAttachment, budget: number): Promise<{ block: ImageContentBlock; rawBytes: number } | null> {
    const normalisedMime = a.mimeType.toLowerCase();
    if (!CLAUDE_IMAGE_MIME_ALLOWLIST.has(normalisedMime)) {
      this.log.debug(`Skipping inline of ${a.path}: MIME ${a.mimeType} outside Claude image allowlist`);
      return null;
    }
    // Cheap pre-check so we don't read megabytes of bytes we'll throw away.
    let sizeOnDisk: number;
    try {
      sizeOnDisk = (await stat(a.path)).size;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn(`stat() failed for attachment ${a.path}: ${message}`);
      return null;
    }
    if (sizeOnDisk > budget) {
      this.log.debug(
        `Skipping inline of ${a.path}: ${sizeOnDisk}B > remaining budget ${budget}B`,
      );
      return null;
    }
    let buf: Buffer;
    try {
      buf = await readFile(a.path);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn(`readFile failed for attachment ${a.path}: ${message}`);
      return null;
    }
    return {
      block: {
        type: "image",
        source: {
          type: "base64",
          media_type: normalisedMime,
          data: buf.toString("base64"),
        },
      },
      rawBytes: buf.byteLength,
    };
  }

  /**
   * Send SIGTERM and resolve when the process has fully exited.
   *
   * The synchronous side-effects (setState("stopped"), SIGTERM, null the
   * `process` reference, clean up the MCP config) happen on the same tick
   * the caller invokes — preserving the Router invariant documented on
   * `restart()`. The returned promise then resolves once the kernel
   * confirms exit via the child's `exit` event.
   *
   * If SIGTERM doesn't take effect within `STOP_TIMEOUT_MS`, we escalate
   * to SIGKILL. That path is logged as a warning — a graceful Claude CLI
   * shutdown should never need it.
   *
   * Callers that don't care about ordering can fire-and-forget; existing
   * sites that historically called `stop()` synchronously continue to
   * work because the meaningful state transitions are still synchronous.
   */
  stop(): Promise<void> {
    // Set state BEFORE killing so handleExit knows this was intentional.
    this.setState("stopped");

    const child = this.process;
    if (!child) {
      this.cleanupMcpConfigFile();
      // No live process — nothing to wait for. Return any in-flight
      // exit waiter (set by a previous still-pending stop) or resolve
      // immediately.
      return this.exitWaiter ?? Promise.resolve();
    }

    this.log.info("Stopping agent process...");
    this.process = null;
    this.cleanupMcpConfigFile();

    const waiter = this.exitWaiter ?? Promise.resolve();

    // SIGKILL escalation — a side-effect, not part of the returned
    // promise. The timer is cancelled the moment `waiter` resolves (the
    // process actually exited), so a clean SIGTERM shutdown leaves no
    // pending SIGKILL. We don't gate the returned promise on the timer
    // because exit is the only signal that matters; SIGKILL is just our
    // way of guaranteeing exit eventually happens.
    //
    // The closure deliberately captures `child` (the local), not
    // `this.process` — by the time the timer fires, `this.process` may
    // have been replaced by a new spawn from a subsequent restart(), and
    // we must only ever signal the original process this stop() targeted.
    const escalationTimer = setTimeout(() => {
      this.log.warn(
        `SIGTERM did not exit within ${STOP_TIMEOUT_MS}ms — escalating to SIGKILL`,
      );
      child.kill("SIGKILL");
    }, STOP_TIMEOUT_MS);
    void waiter.finally(() => clearTimeout(escalationTimer));

    child.kill("SIGTERM");
    return waiter;
  }

  /**
   * Kill the current process and start a fresh one.
   *
   * Awaits actual exit (via the `stop()` exit handshake) before respawning
   * — replaces the old hardcoded 1s `setTimeout` that lost a race with
   * SIGTERM cleanup and produced the "Session ID is already in use"
   * crash loop documented in DEVLOG.
   *
   * Router invariant (consumePendingRestart → drainQueue skipping):
   * `stop()` sets state to "stopped" *synchronously* before its returned
   * promise resolves, and `handleExit()` early-returns on state=="stopped",
   * so no "idle" transition can leak between stop and the respawn below.
   * The Router is safe to return from its idle handler without draining
   * — the fresh process will emit its own idle when it's ready.
   *
   * Session continuity is handled by the `system init` handler, which
   * flips sessionOptions into resume mode the first time the CLI confirms
   * the session exists on disk. `restart()` doesn't need to touch
   * sessionOptions itself.
   *
   * Returns a promise that resolves once the new process has been spawned
   * (idle state). Callers that want fire-and-forget semantics can ignore
   * the promise; existing void-call sites work unchanged.
   */
  async restart(): Promise<void> {
    this.log.info("Restarting agent...");
    await this.stop();
    this.start();
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

    // Resolve the exit handshake (set up in start()). Anything awaiting
    // stop() — chiefly restart() — unblocks here. Doing this first keeps
    // the handshake honest even if a downstream branch throws.
    const resolveExit = this.resolveExitWaiter;
    this.resolveExitWaiter = null;
    if (resolveExit) resolveExit();

    // If stop() was called, state is already "stopped" — don't enter crash recovery.
    if (this.state === "stopped") {
      return;
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

    const delay = CRASH_BACKOFF_MS[Math.min(this.crashesToday - 1, CRASH_BACKOFF_MS.length - 1)]!;
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

// ---------------------------------------------------------------------------
// Stream-JSON user message shapes (subset Rondel emits)
// ---------------------------------------------------------------------------

interface TextContentBlock {
  readonly type: "text";
  readonly text: string;
}

interface ImageContentBlock {
  readonly type: "image";
  readonly source: {
    readonly type: "base64";
    readonly media_type: string;
    readonly data: string;
  };
}

type ContentBlock = TextContentBlock | ImageContentBlock;

interface UserMessagePayload {
  readonly role: "user";
  readonly content: string | readonly ContentBlock[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractTextFromContentBlocks(blocks: readonly ContentBlock[]): string {
  for (const b of blocks) {
    if (b.type === "text") return b.text;
  }
  return "";
}

/**
 * Trim the in-memory base64 payload out of a `ChannelAttachment` before
 * appending to the JSONL transcript — the transcript carries metadata
 * only; bytes live on disk and can be re-read from `path`.
 *
 * (Today `ChannelAttachment` never carries bytes inline, but exposing
 * the helper now keeps any future per-message ephemeral fields out of
 * the on-disk log automatically.)
 */
function stripBytesForTranscript(a: ChannelAttachment): ChannelAttachment {
  return {
    kind: a.kind,
    path: a.path,
    mimeType: a.mimeType,
    bytes: a.bytes,
    originalName: a.originalName,
    width: a.width,
    height: a.height,
    durationSec: a.durationSec,
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function describeAttachmentKind(a: ChannelAttachment): string {
  // Human-readable label that captures kind + key metadata.
  const dims = a.width && a.height ? ` ${a.width}×${a.height}` : "";
  const dur = a.durationSec ? ` ${a.durationSec}s` : "";
  const name = a.originalName ? ` "${a.originalName}"` : "";
  return `${a.kind}${name}${dims}${dur}`;
}
