import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { FRAMEWORK_DISALLOWED_TOOLS, type McpConfigMap } from "./agent-process.js";
import type { SubagentState } from "../shared/types.js";
import type { Logger } from "../shared/logger.js";
import { appendTranscriptEntry } from "../shared/transcript.js";
import { resolveFrameworkSkillsDir } from "../shared/paths.js";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

const FRAMEWORK_SKILLS_DIR = resolveFrameworkSkillsDir();

export interface SubagentOptions {
  readonly id: string;
  readonly task: string;
  readonly systemPrompt: string;
  readonly model: string;
  readonly workingDirectory?: string;
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

/**
 * Ephemeral Claude CLI process for task execution.
 *
 * Unlike AgentProcess (persistent, stream-json bidirectional), SubagentProcess:
 * - Receives a single task, runs to completion, and exits
 * - Uses stream-json for structured result parsing (cost, error status)
 * - Has a timeout — killed if it takes too long
 * - No crash recovery — it either completes, fails, or times out
 */
export class SubagentProcess {
  private process: ChildProcess | null = null;
  private state: SubagentState = "running";
  private resultText: string | undefined;
  private errorText: string | undefined;
  private costUsd: number | undefined;
  private completedAt: string | undefined;
  private responseBuffer: string[] = [];
  private mcpConfigPath: string | null = null;
  private timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  private readonly log: Logger;

  /** Resolves when the subagent finishes (any terminal state). */
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

  /** Spawn the subagent and send the task. */
  start(): void {
    this.writeMcpConfigFile();

    const args = [
      "-p",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--model", this.options.model,
      "--system-prompt", this.options.systemPrompt,
      "--dangerously-skip-permissions",
    ];

    if (this.options.maxTurns !== undefined) {
      args.push("--max-turns", String(this.options.maxTurns));
    }

    if (this.options.allowedTools && this.options.allowedTools.length > 0) {
      args.push("--allowedTools", ...this.options.allowedTools);
    }

    // Merge framework-level disallowed tools (e.g. Agent) with user-provided ones.
    // Same invariant as AgentProcess: FlowClaw owns delegation, not the built-in Agent tool.
    const allDisallowed = new Set([...FRAMEWORK_DISALLOWED_TOOLS, ...(this.options.disallowedTools ?? [])]);
    if (allDisallowed.size > 0) {
      args.push("--disallowedTools", ...allDisallowed);
    }

    if (this.mcpConfigPath) {
      args.push("--mcp-config", this.mcpConfigPath);
    }

    // Framework skills discovery
    args.push("--add-dir", FRAMEWORK_SKILLS_DIR);

    this.log.info(`Spawning subagent — task: "${this.options.task.slice(0, 100)}..."`);

    const child = spawn("claude", args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: this.options.workingDirectory ?? undefined,
      env: process.env,
    });

    this.process = child;

    const rl = createInterface({ input: child.stdout! });
    rl.on("line", (line) => this.handleStdoutLine(line));

    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) this.log.warn(`stderr: ${text}`);
    });

    child.on("exit", (code, signal) => this.handleExit(code, signal));

    child.on("error", (err) => {
      this.log.error("Failed to spawn subagent:", err.message);
      this.finish("failed", undefined, err.message);
    });

    // Send the task as the first (and only) user message
    const message = JSON.stringify({
      type: "user",
      session_id: "",
      message: {
        role: "user",
        content: this.options.task,
      },
      parent_tool_use_id: null,
    });

    child.stdin!.write(message + "\n");

    // Append task as user entry to transcript
    if (this.options.transcriptPath) {
      appendTranscriptEntry(this.options.transcriptPath, {
        type: "user",
        text: this.options.task,
        timestamp: new Date().toISOString(),
      }, this.log);
    }

    // Start timeout
    const timeout = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.timeoutHandle = setTimeout(() => {
      if (this.state === "running") {
        this.log.warn(`Subagent timed out after ${timeout}ms`);
        this.kill("timeout");
      }
    }, timeout);
  }

  /** Kill the subagent process. */
  kill(reason: "killed" | "timeout" = "killed"): void {
    if (this.process) {
      this.process.kill("SIGTERM");
      this.process = null;
    }
    if (this.state === "running") {
      this.finish(reason, undefined, `Subagent ${reason}`);
    }
  }

  private handleStdoutLine(line: string): void {
    if (!line.trim()) return;

    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }

    // Append raw stream-json event to transcript
    if (this.options.transcriptPath) {
      appendTranscriptEntry(this.options.transcriptPath, raw, this.log);
    }

    const eventType = raw.type as string | undefined;

    switch (eventType) {
      case "assistant": {
        const message = raw.message as { content?: readonly { type: string; text?: string }[] } | undefined;
        if (message?.content) {
          for (const block of message.content) {
            if (block.type === "text" && block.text) {
              this.responseBuffer.push(block.text);
            }
          }
        }
        break;
      }

      case "result": {
        const fullResponse = this.responseBuffer.join("");
        this.responseBuffer = [];
        const isError = raw.is_error === true;
        const cost = typeof raw.total_cost_usd === "number" ? raw.total_cost_usd : undefined;

        if (isError) {
          this.finish("failed", undefined, fullResponse || (raw.result as string) || "Unknown error", cost);
        } else {
          this.finish("completed", fullResponse || (raw.result as string) || "", undefined, cost);
        }
        break;
      }
    }
  }

  private handleExit(code: number | null, signal: string | null): void {
    this.process = null;

    // If we already finished (result event came before exit), don't overwrite
    if (this.state !== "running") return;

    if (code === 0) {
      // Clean exit without a result event — unlikely but handle gracefully
      const text = this.responseBuffer.join("");
      this.finish("completed", text || "(no output)");
    } else {
      this.finish("failed", undefined, `Process exited with code ${code}, signal ${signal}`);
    }
  }

  private finish(
    state: SubagentState,
    result?: string,
    error?: string,
    costUsd?: number,
  ): void {
    if (this.state !== "running") return; // already finished

    this.state = state;
    this.resultText = result;
    this.errorText = error;
    this.costUsd = costUsd;
    this.completedAt = new Date().toISOString();

    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
    }

    this.cleanupMcpConfigFile();
    this.log.info(`Subagent finished — state: ${state}${costUsd !== undefined ? `, cost: $${costUsd}` : ""}`);
    this.resolveDone(this.getResult());
  }

  private writeMcpConfigFile(): void {
    if (!this.options.mcpConfig || Object.keys(this.options.mcpConfig).length === 0) {
      this.mcpConfigPath = null;
      return;
    }

    const dir = join(tmpdir(), "flowclaw-mcp");
    mkdirSync(dir, { recursive: true });

    const id = randomBytes(4).toString("hex");
    const filePath = join(dir, `mcp-sub-${this.options.id}-${id}.json`);

    writeFileSync(filePath, JSON.stringify({ mcpServers: this.options.mcpConfig }), "utf-8");
    this.mcpConfigPath = filePath;
  }

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
}
