/**
 * Cron job execution engine.
 *
 * Handles the actual spawning of processes for cron jobs. Separated from
 * the Scheduler (which owns timing, backoff, and state persistence) and
 * from AgentManager (which owns templates).
 *
 * Supports two execution modes:
 * - Isolated: fresh SubagentProcess per run (default — no prior context)
 * - Named session: persistent AgentProcess keyed as {agentName}:cron:{name}
 *   that maintains context across runs
 *
 * Cron runs reuse SubagentProcess — structurally identical to subagent
 * execution (ephemeral process, single task, collect result).
 */

import { SubagentProcess, type SubagentOptions } from "../agents/subagent-process.js";
import type { McpConfigMap } from "../agents/agent-process.js";
import { assembleContext } from "../config/context-assembler.js";
import { resolveTranscriptPath, createTranscript } from "../shared/transcript.js";
import type { AgentConfig, CronJob, SubagentState } from "../shared/types/index.js";
import type { ConversationManager, AgentTemplate } from "../agents/conversation-manager.js";
import type { Logger } from "../shared/logger.js";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/** The outcome of a single cron job execution. */
export interface CronRunOutcome {
  readonly result?: string;
  readonly error?: string;
  readonly costUsd?: number;
  readonly state: SubagentState;
}

// ---------------------------------------------------------------------------
// CronRunner
// ---------------------------------------------------------------------------

export class CronRunner {
  private readonly log: Logger;

  constructor(
    private readonly rondelHome: string,
    private readonly transcriptsBaseDir: string,
    private readonly mcpServerPath: string,
    private readonly bridgeUrl: () => string,
    private readonly getTemplate: (name: string) => AgentTemplate | undefined,
    private readonly conversationManager: ConversationManager,
    log: Logger,
  ) {
    this.log = log.child("cron-runner");
  }

  /**
   * Spawn an ephemeral process to execute a cron job in isolation.
   *
   * Reuses the agent's template (model, tools, MCP config) but runs in
   * a fresh process with no prior context. Returns a promise that resolves
   * when the run completes.
   */
  async runIsolated(agentName: string, job: CronJob): Promise<CronRunOutcome> {
    const template = this.getTemplate(agentName);
    if (!template) throw new Error(`Unknown agent: ${agentName}`);

    const id = `cron_${job.id}_${Date.now()}_${randomBytes(3).toString("hex")}`;

    // Assemble context without MEMORY.md/USER.md/BOOTSTRAP.md for ephemeral cron runs
    const systemPrompt = await assembleContext(template.agentDir, this.log, { isEphemeral: true });

    // Build MCP config from agent template
    const mcpConfig: McpConfigMap = {
      rondel: {
        command: "node",
        args: [this.mcpServerPath],
        env: {
          RONDEL_BOT_TOKEN: resolveTelegramToken(template.config) ?? "",
          RONDEL_BRIDGE_URL: this.bridgeUrl(),
          RONDEL_PARENT_AGENT: agentName,
          RONDEL_PARENT_CHAT_ID: "", // no parent chat for cron runs
        },
      },
      ...template.config.mcp?.servers,
    };

    // Create transcript for cron run
    const transcriptPath = resolveTranscriptPath(this.transcriptsBaseDir, agentName, id);
    await createTranscript(transcriptPath, {
      type: "session_start",
      sessionId: id,
      agentName,
      chatId: `cron:${job.id}`,
      model: job.model ?? template.config.model,
      timestamp: new Date().toISOString(),
    }, this.log);

    const options: SubagentOptions = {
      id,
      task: job.prompt,
      systemPrompt,
      model: job.model ?? template.config.model,
      workingDirectory: template.config.workingDirectory ?? undefined,
      allowedTools: template.config.tools.allowed as string[] | undefined,
      disallowedTools: template.config.tools.disallowed as string[] | undefined,
      timeoutMs: job.timeoutMs,
      mcpConfig,
      transcriptPath,
    };

    const subProcess = new SubagentProcess(options, this.log);
    subProcess.start();

    this.log.info(`Cron run started: ${id} (agent: ${agentName}, job: ${job.id})`);

    const result = await subProcess.done;
    this.log.info(`Cron run finished: ${id} (state: ${result.state})`);
    return result;
  }

  /**
   * Execute a cron job in a named persistent session.
   *
   * Uses a conversation keyed as {agentName}:cron:{sessionName}. The process
   * persists between runs, so each run sees the context of previous ones.
   * Useful for workflows needing continuity ("compare today to yesterday").
   *
   * Delegates to ConversationManager for process lifecycle.
   */
  getOrSpawnNamedSession(agentName: string, sessionName: string): import("../agents/agent-process.js").AgentProcess | undefined {
    const template = this.getTemplate(agentName);
    if (!template) return undefined;

    const chatId = `cron:${sessionName}`;
    return this.conversationManager.getOrSpawn(template, "internal", chatId);
  }
}

/** Resolve Telegram bot token from an agent's channel bindings. */
function resolveTelegramToken(config: AgentConfig): string | undefined {
  const binding = config.channels.find((b) => b.channelType === "telegram");
  if (!binding) return undefined;
  return process.env[binding.credentials];
}
