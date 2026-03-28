import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import { writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import type { AgentConfig, AgentEvent, AgentState, McpServerEntry } from "./types.js";
import type { Logger } from "./logger.js";

const MAX_CRASHES_PER_DAY = 5;
const RESTART_DELAY_MS = 5_000;

/**
 * Built-in Claude CLI tools that FlowClaw always disallows because it
 * supersedes them with managed MCP equivalents.
 *
 * - Agent: FlowClaw owns delegation via flowclaw_spawn_subagent. The built-in
 *   Agent tool is untracked — FlowClaw can't monitor, kill, or budget it.
 *
 * This list is a framework invariant, not a per-agent config choice.
 * User-configured disallowedTools in agent.json are merged on top.
 */
const FRAMEWORK_DISALLOWED_TOOLS: readonly string[] = ["Agent"];

/**
 * Complete MCP config passed to Claude CLI via --mcp-config.
 * Maps server names to their launch configs.
 * FlowClaw's own server is merged with any user-defined servers from agent.json.
 */
export type McpConfigMap = Readonly<Record<string, McpServerEntry>>;

interface AgentProcessEvents {
  stateChange: [state: AgentState];
  response: [text: string];
  turnComplete: [result: AgentEvent];
  error: [error: Error];
}

export class AgentProcess extends EventEmitter<AgentProcessEvents> {
  private process: ChildProcess | null = null;
  private sessionId: string = "";
  private state: AgentState = "stopped";
  private crashesToday = 0;
  private crashCountResetDate: string = "";
  private readonly log: Logger;
  private responseBuffer: string[] = [];
  private mcpConfigPath: string | null = null;

  constructor(
    private readonly agentConfig: AgentConfig,
    private readonly systemPrompt: string,
    log: Logger,
    private readonly mcpConfig?: McpConfigMap,
  ) {
    super();
    this.log = log.child(agentConfig.agentName);
  }

  getState(): AgentState {
    return this.state;
  }

  getSessionId(): string {
    return this.sessionId;
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

    this.log.info("Spawning claude process...");
    this.log.debug(`Args: claude ${args.join(" ")}`);

    const child = spawn("claude", args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: this.agentConfig.workingDirectory ?? undefined,
      env: process.env,
    });

    this.process = child;

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
  sendMessage(text: string): void {
    if (!this.process?.stdin?.writable) {
      this.log.error("Cannot send message — agent process not running");
      return;
    }

    this.setState("busy");
    this.responseBuffer = [];

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
  }

  /** Kill the agent process. */
  stop(): void {
    if (this.process) {
      this.log.info("Stopping agent process...");
      this.process.kill("SIGTERM");
      this.process = null;
      this.setState("stopped");
    }
    this.cleanupMcpConfigFile();
  }

  /** Kill and restart the agent. */
  restart(): void {
    this.log.info("Restarting agent...");
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

    const eventType = raw.type as string | undefined;

    switch (eventType) {
      case "system":
        if (raw.subtype === "init" && typeof raw.session_id === "string") {
          this.sessionId = raw.session_id;
          this.log.info(`Session established: ${this.sessionId}`);
        }
        break;

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
        if (fullResponse) {
          this.emit("response", fullResponse);
        }
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

  private handleExit(code: number | null, signal: string | null): void {
    this.process = null;
    this.log.warn(`Agent process exited — code: ${code}, signal: ${signal}`);

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
    this.log.info(`Scheduling restart in ${RESTART_DELAY_MS}ms (crash ${this.crashesToday}/${MAX_CRASHES_PER_DAY} today)`);
    setTimeout(() => {
      if (this.state === "crashed") {
        this.start();
      }
    }, RESTART_DELAY_MS);
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

    const dir = join(tmpdir(), "flowclaw-mcp");
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
