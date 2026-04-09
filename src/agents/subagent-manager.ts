/**
 * Subagent lifecycle manager.
 *
 * Owns the spawning, tracking, and garbage collection of ephemeral subagent
 * processes. Subagents are short-lived Claude CLI processes that execute a
 * single task, return a result, and exit. They're spawned by parent agents
 * via the rondel_spawn_subagent MCP tool.
 *
 * Follows OpenClaw's async model:
 * - Spawn returns immediately with a subagent ID (non-blocking)
 * - The subagent runs in the background
 * - On completion, lifecycle hooks fire so listeners can deliver the result
 *   back to the parent agent as a user message (push-based, not polling)
 *
 * Result retention: completed subagent results are kept in memory for 1 hour
 * (for late status checks), then pruned by a background timer.
 */

import { SubagentProcess, type SubagentOptions } from "./subagent-process.js";
import type { McpConfigMap } from "./agent-process.js";
import { loadTemplateConfig } from "../config/config.js";
import { assembleTemplateContext } from "../config/context-assembler.js";
import { resolveTranscriptPath, createTranscript } from "../shared/transcript.js";
import type { AgentConfig, SubagentSpawnRequest, SubagentInfo } from "../shared/types/index.js";
import { buildChannelMcpEnv } from "../shared/channels.js";
import type { RondelHooks } from "../shared/hooks.js";
import type { Logger } from "../shared/logger.js";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** How long to keep completed subagent results before pruning from memory. */
const SUBAGENT_RESULT_TTL_MS = 60 * 60 * 1000; // 1 hour

/** How often to check for stale results to prune. */
const SUBAGENT_PRUNE_INTERVAL_MS = 5 * 60 * 1000; // every 5 minutes

// ---------------------------------------------------------------------------
// Internal tracking entry
// ---------------------------------------------------------------------------

interface SubagentEntry {
  readonly process: SubagentProcess;
  readonly info: SubagentInfo;
  readonly startedAt: number;
}

// ---------------------------------------------------------------------------
// SubagentManager
// ---------------------------------------------------------------------------

export class SubagentManager {
  /** Active and recently-completed subagents: subagentId → entry. */
  private readonly subagents = new Map<string, SubagentEntry>();

  /** Background timer for pruning old results. */
  private readonly pruneTimer: ReturnType<typeof setInterval>;

  private readonly log: Logger;

  constructor(
    private readonly rondelHome: string,
    private readonly transcriptsBaseDir: string,
    private readonly mcpServerPath: string,
    private readonly bridgeUrl: () => string,
    private readonly getTemplate: (name: string) => { config: AgentConfig; systemPrompt: string } | undefined,
    private readonly hooks: RondelHooks | undefined,
    log: Logger,
  ) {
    this.log = log.child("subagents");
    this.pruneTimer = setInterval(() => this.prune(), SUBAGENT_PRUNE_INTERVAL_MS);
  }

  // -------------------------------------------------------------------------
  // Spawn
  // -------------------------------------------------------------------------

  /**
   * Spawn an ephemeral subagent to execute a task.
   *
   * Returns immediately with the subagent info (state: "running"). The
   * subagent runs in the background. When it finishes, lifecycle hooks fire
   * so listeners (wired in index.ts) can deliver the result back to the
   * parent agent as a user message.
   *
   * @param request - What to run, where, and on behalf of whom
   * @returns SubagentInfo with id and state "running"
   * @throws If neither template nor system_prompt is provided, or template not found
   */
  async spawn(request: SubagentSpawnRequest): Promise<SubagentInfo> {
    const id = `sub_${Date.now()}_${randomBytes(3).toString("hex")}`;
    const parentTemplate = this.getTemplate(request.parentAgentName);

    // --- Resolve system prompt: explicit > template > error ---
    let systemPrompt: string;
    let model: string;
    let allowedTools = request.allowedTools;
    let disallowedTools = request.disallowedTools;
    let mcpServers: Readonly<Record<string, import("../shared/types/index.js").McpServerEntry>> | undefined;

    if (request.systemPrompt) {
      systemPrompt = request.systemPrompt;
      model = request.model ?? parentTemplate?.config.model ?? "sonnet";
    } else if (request.template) {
      const templateConfig = await loadTemplateConfig(this.rondelHome, request.template);
      const templateContext = await assembleTemplateContext(this.rondelHome, request.template, this.log);

      if (!templateContext) {
        throw new Error(`Template "${request.template}" not found — missing templates/${request.template}/SYSTEM.md`);
      }

      systemPrompt = templateContext;
      model = request.model ?? templateConfig?.model ?? parentTemplate?.config.model ?? "sonnet";

      // Inherit tool policy from template if not explicitly provided
      if (!allowedTools && templateConfig?.tools?.allowed?.length) {
        allowedTools = templateConfig.tools.allowed;
      }
      if (!disallowedTools && templateConfig?.tools?.disallowed?.length) {
        disallowedTools = templateConfig.tools.disallowed;
      }

      mcpServers = templateConfig?.mcp?.servers;
    } else {
      throw new Error("Either 'template' or 'system_prompt' must be provided");
    }

    const workingDirectory = request.workingDirectory ?? parentTemplate?.config.workingDirectory ?? undefined;

    // --- Build MCP config (inherits parent's channel credentials + bridge URL) ---
    const mcpConfig: McpConfigMap = {
      rondel: {
        command: "node",
        args: [this.mcpServerPath],
        env: {
          ...(parentTemplate ? buildChannelMcpEnv(parentTemplate.config) : {}),
          RONDEL_BRIDGE_URL: this.bridgeUrl(),
          RONDEL_PARENT_AGENT: request.parentAgentName,
          RONDEL_PARENT_CHAT_ID: request.parentChatId,
        },
      },
      ...mcpServers,
    };

    // --- Create transcript (stored under parent agent's directory) ---
    const transcriptPath = resolveTranscriptPath(this.transcriptsBaseDir, request.parentAgentName, id);
    createTranscript(transcriptPath, {
      type: "session_start",
      sessionId: id,
      agentName: `${request.parentAgentName}/${request.template ?? "subagent"}`,
      chatId: request.parentChatId,
      model,
      timestamp: new Date().toISOString(),
    }, this.log).catch(() => {});

    // --- Build options and spawn ---
    const options: SubagentOptions = {
      id,
      task: request.task,
      systemPrompt,
      model,
      workingDirectory,
      maxTurns: request.maxTurns,
      timeoutMs: request.timeoutMs,
      allowedTools: allowedTools as string[] | undefined,
      disallowedTools: disallowedTools as string[] | undefined,
      mcpConfig,
      transcriptPath,
    };

    const subProcess = new SubagentProcess(options, this.log);

    const info: SubagentInfo = {
      id,
      parentAgentName: request.parentAgentName,
      parentChannelType: request.parentChannelType,
      parentChatId: request.parentChatId,
      task: request.task,
      state: "running",
      startedAt: new Date().toISOString(),
    };

    this.subagents.set(id, { process: subProcess, info, startedAt: Date.now() });

    // Emit spawning hook — listeners send Telegram notification to user
    this.hooks?.emit("subagent:spawning", {
      id,
      parentAgentName: request.parentAgentName,
      parentChatId: request.parentChatId,
      task: request.task,
      template: request.template,
    });

    subProcess.start();
    this.log.info(`Subagent spawned: ${id} (parent: ${request.parentAgentName}, task: "${request.task.slice(0, 80)}")`);

    // --- Watch in background (don't block the caller) ---
    // When the subagent finishes, emit hooks so listeners can deliver the result.
    subProcess.done.then((result) => {
      const finalInfo: SubagentInfo = {
        ...info,
        state: result.state,
        result: result.result,
        error: result.error,
        costUsd: result.costUsd,
        completedAt: result.completedAt,
      };

      if (result.state === "completed") {
        this.hooks?.emit("subagent:completed", { info: finalInfo });
      } else {
        this.hooks?.emit("subagent:failed", { info: finalInfo });
      }
    });

    return info;
  }

  // -------------------------------------------------------------------------
  // Query & control
  // -------------------------------------------------------------------------

  /** Get current state of a subagent by ID. */
  get(id: string): SubagentInfo | undefined {
    const entry = this.subagents.get(id);
    if (!entry) return undefined;

    // Merge live process state with the stored info snapshot
    const result = entry.process.getResult();
    return {
      ...entry.info,
      state: result.state,
      result: result.result,
      error: result.error,
      costUsd: result.costUsd,
      completedAt: result.completedAt,
    };
  }

  /** Kill a running subagent. Returns false if not found or already finished. */
  kill(id: string): boolean {
    const entry = this.subagents.get(id);
    if (!entry) return false;
    if (entry.process.getState() !== "running") return false;

    entry.process.kill("killed");
    this.log.info(`Subagent killed: ${id}`);
    return true;
  }

  /** List subagents, optionally filtered by parent agent name. */
  list(parentAgentName?: string): SubagentInfo[] {
    const results: SubagentInfo[] = [];
    for (const [, entry] of this.subagents) {
      if (parentAgentName && entry.info.parentAgentName !== parentAgentName) continue;
      const result = entry.process.getResult();
      results.push({
        ...entry.info,
        state: result.state,
        result: result.result,
        error: result.error,
        costUsd: result.costUsd,
        completedAt: result.completedAt,
      });
    }
    return results;
  }

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------

  /** Remove completed subagent results older than the TTL. */
  private prune(): void {
    const now = Date.now();
    for (const [id, entry] of this.subagents) {
      if (entry.process.getState() === "running") continue;
      if (now - entry.startedAt > SUBAGENT_RESULT_TTL_MS) {
        this.subagents.delete(id);
        this.log.debug(`Pruned subagent result: ${id}`);
      }
    }
  }

  /** Stop the background prune timer. Called during shutdown. */
  stopPruning(): void {
    clearInterval(this.pruneTimer);
  }
}
