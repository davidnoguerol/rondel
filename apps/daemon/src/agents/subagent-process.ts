// SubagentProcess — an ephemeral, one-shot agent backed by the claude-wrap SDK
// (PTY, subscription, never an API key). Semantics: start() → send(task) once →
// the first turnComplete IS the result → stop(). This is the ONLY SubagentProcess
// implementation; there is no headless/stream-json path.
//
// Runaway protection is wall-clock only (setTimeout → kill). claude-wrap has no
// --max-turns under interactive PTY mode, so SubagentOptions.maxTurns is not
// plumbed — the timeout is the backstop (the isolated-cron path passed no
// maxTurns either).
import { AgentSession } from "claude-wrap";
import type { SessionOptions, TurnResult } from "claude-wrap";
import { FRAMEWORK_DISALLOWED_TOOLS, type McpConfigMap } from "./agent-process.js";
import { resolveFrameworkSkillsDir } from "../shared/paths.js";
import { appendTranscriptEntry } from "../shared/transcript.js";
import type { Logger } from "../shared/logger.js";
import type { SubagentState } from "../shared/types/index.js";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const FRAMEWORK_SKILLS_DIR = resolveFrameworkSkillsDir();

export interface SubagentOptions {
  readonly id: string;
  readonly task: string;
  readonly systemPrompt: string;
  readonly model: string;
  readonly workingDirectory?: string;
  /** Accepted for interface compatibility; not enforced (interactive PTY has no --max-turns). */
  readonly maxTurns?: number;
  readonly timeoutMs?: number;
  readonly allowedTools?: readonly string[];
  readonly disallowedTools?: readonly string[];
  readonly mcpConfig?: McpConfigMap;
  readonly transcriptPath?: string;
}

export interface SubagentResult {
  readonly state: SubagentState;
  readonly result?: string;
  readonly error?: string;
  readonly costUsd?: number;
  readonly completedAt?: string;
}

export class SubagentProcess {
  private session: AgentSession | null = null;
  private state: SubagentState = "running";
  private resultText: string | undefined;
  private errorText: string | undefined;
  private costUsd: number | undefined;
  private completedAt: string | undefined;
  private timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  private settled = false;
  private readonly log: Logger;

  /** Resolves (never rejects) when the subagent reaches any terminal state. */
  readonly done: Promise<SubagentResult>;
  private resolveDone!: (result: SubagentResult) => void;

  constructor(
    private readonly options: SubagentOptions,
    log: Logger,
  ) {
    this.log = log.child(`subagent:${options.id}`);
    this.done = new Promise((resolve) => {
      this.resolveDone = resolve;
    });
  }

  getId(): string {
    return this.options.id;
  }

  getState(): SubagentState {
    return this.state;
  }

  getResult(): SubagentResult {
    return {
      state: this.state,
      result: this.resultText,
      error: this.errorText,
      costUsd: this.costUsd,
      completedAt: this.completedAt,
    };
  }

  start(): void {
    const o = this.options;
    const cwOptions: SessionOptions = {
      provider: "claude-code",
      cwd: o.workingDirectory ?? process.cwd(),
      model: o.model,
      systemPrompt: o.systemPrompt,
      allowedTools: o.allowedTools && o.allowedTools.length > 0 ? [...o.allowedTools] : undefined,
      // Union with the framework block list — preserves legacy semantics.
      disallowedTools: [...new Set([...FRAMEWORK_DISALLOWED_TOOLS, ...(o.disallowedTools ?? [])])],
      addDirs: [FRAMEWORK_SKILLS_DIR],
      // claude-wrap writes its own temp mcp-config from this map (preserving each
      // server's command/args/env, incl. the RONDEL_* bridge vars).
      mcpConfig: o.mcpConfig as SessionOptions["mcpConfig"],
      // == legacy --dangerously-skip-permissions (no user to approve tool calls).
      permission: { mode: "bypassPermissions" },
    };

    try {
      const session = new AgentSession(cwOptions);
      this.session = session;

      const tp = o.transcriptPath;
      if (tp) {
        appendTranscriptEntry(tp, { type: "user", text: o.task, timestamp: new Date().toISOString() }, this.log);
        session.on("text", (e) =>
          appendTranscriptEntry(
            tp,
            { type: "assistant", message: { content: [{ type: "text", text: e.text }] }, timestamp: new Date().toISOString() },
            this.log,
          ),
        );
      }

      // `exit`/`error` fire BEFORE the adapter's final turnComplete (it drains
      // for up to ~1.5s after the PTY exits). Give that richer result a grace
      // window before settling on a generic failure — but never let `done` hang.
      let exitGraceTimer: ReturnType<typeof setTimeout> | null = null;
      const settleAfterGrace = (msg: string) => {
        if (this.settled || exitGraceTimer) return;
        const t = setTimeout(() => {
          exitGraceTimer = null;
          if (!this.settled) this.finish("failed", undefined, msg);
        }, 1700);
        t.unref?.();
        exitGraceTimer = t;
      };

      // One send ⇒ exactly one turnComplete (regardless of tool-call count). That
      // single turn IS the subagent's result.
      session.once("turnComplete", (tr: TurnResult) => {
        if (exitGraceTimer) {
          clearTimeout(exitGraceTimer);
          exitGraceTimer = null;
        }
        if (tr.isError) this.finish("failed", undefined, tr.text || "Unknown error", tr.costUsd);
        else this.finish("completed", tr.text || "", undefined, tr.costUsd);
      });
      // Guards so `done` can never hang if no turnComplete arrives.
      session.on("error", (e) => {
        if (e.fatal) settleAfterGrace(e.message);
      });
      session.on("exit", () => settleAfterGrace("session exited before result"));

      session
        .start()
        .then(() => session.send(o.task))
        .catch((err: unknown) => this.finish("failed", undefined, err instanceof Error ? err.message : String(err)));

      const timeout = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      this.timeoutHandle = setTimeout(() => {
        if (this.state === "running") {
          this.log.warn(`Subagent timed out after ${timeout}ms`);
          this.kill("timeout");
        }
      }, timeout);
    } catch (err) {
      // A synchronous failure constructing/wiring the session must still resolve
      // `done` (contract: never hang, never reject).
      this.finish("failed", undefined, err instanceof Error ? err.message : String(err));
    }
  }

  kill(reason: "killed" | "timeout" = "killed"): void {
    if (this.state === "running") {
      this.finish(reason, undefined, `Subagent ${reason}`);
    } else {
      void this.session?.stop().catch(() => {
        /* already gone */
      });
    }
  }

  // Single-fire; tears the session down BEFORE resolving `done` (preserves the
  // orphan-process guarantee the legacy provided).
  private finish(state: SubagentState, result?: string, error?: string, costUsd?: number): void {
    if (this.settled) return;
    this.settled = true;
    this.state = state;
    this.resultText = result;
    this.errorText = error;
    this.costUsd = costUsd;
    this.completedAt = new Date().toISOString();
    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
    }
    this.log.info(`Subagent finished — state: ${state}${costUsd !== undefined ? `, cost: ~$${costUsd}` : ""}`);
    const s = this.session;
    this.session = null;
    void (s ? s.stop().catch(() => {}) : Promise.resolve()).then(() => this.resolveDone(this.getResult()));
  }
}
