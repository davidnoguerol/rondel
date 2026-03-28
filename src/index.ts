import { createLogger, initLogFile } from "./shared/logger.js";
import { loadEnvFile } from "./config/env-loader.js";
import { resolveFlowclawHome, flowclawPaths, loadFlowclawConfig, discoverAgents } from "./config/config.js";
import { AgentManager } from "./agents/agent-manager.js";
import { Router } from "./routing/router.js";
import { Bridge } from "./bridge/bridge.js";
import { Scheduler } from "./scheduling/scheduler.js";
import { createHooks } from "./shared/hooks.js";
import { acquireInstanceLock, releaseInstanceLock, updateLockBridgeUrl } from "./system/instance-lock.js";
import { mkdir } from "node:fs/promises";

/**
 * Start the FlowClaw orchestrator.
 *
 * Loads config from ~/.flowclaw (or FLOWCLAW_HOME), discovers agents,
 * starts channel adapters, bridge, scheduler, and router.
 *
 * @param flowclawHome - Override the FlowClaw home directory (default: resolveFlowclawHome())
 */
export async function startOrchestrator(flowclawHome?: string): Promise<void> {
  const home = flowclawHome ?? resolveFlowclawHome();
  const paths = flowclawPaths(home);

  // 0. Load .env before anything that needs env vars (critical for service context)
  loadEnvFile(paths.env);

  // 0b. If running as daemon, set up file logging
  const isDaemon = process.env.FLOWCLAW_DAEMON === "1";
  if (isDaemon) {
    initLogFile(paths.log);
  }

  const log = createLogger("flowclaw");
  log.info("FlowClaw starting...");

  // 1. Load config
  const config = await loadFlowclawConfig(home);

  // 2. Discover agents from workspaces/
  const agents = await discoverAgents(home);
  if (agents.length === 0) {
    log.error("No agents found in workspaces/. Run 'flowclaw add agent' to create one.");
    process.exit(1);
  }
  log.info(`Discovered ${agents.length} agent(s): [${agents.map((a) => a.agentName).join(", ")}]`);

  // 3. Ensure state directory exists
  await mkdir(paths.state, { recursive: true });

  // 4. Acquire instance lock — prevents two FlowClaw processes running simultaneously
  await acquireInstanceLock(paths.state, log, isDaemon ? paths.log : undefined);

  // 5. Create lifecycle hooks
  const hooks = createHooks();

  // 6. Initialize agent templates + channel adapters (no processes spawned yet)
  const agentManager = new AgentManager(log, hooks);
  await agentManager.initialize(home, agents, config.allowedUsers);

  // 7. Load session index (conversation key → session ID mappings)
  await agentManager.loadSessionIndex();

  const telegram = agentManager.getTelegram();

  // 8. Create router (needed by hook listeners for queue-safe message delivery)
  const router = new Router(agentManager, log);

  // 9. Wire hook listeners — subagent lifecycle
  //
  // Follows OpenClaw's async model:
  // - Spawn returns immediately, parent's turn ends
  // - Subagent runs in background
  // - On completion, result is delivered to parent as a user message
  // - Parent processes the result in a new turn
  //
  // Result delivery uses router.sendOrQueue() to respect the parent's
  // busy/idle state — if the parent is mid-turn, the result is queued
  // and delivered when the parent becomes idle.

  hooks.on("subagent:spawning", ({ parentAgentName, parentChatId, task, template }) => {
    const accountId = agentManager.getAccountForAgent(parentAgentName);
    if (!accountId) return;
    const label = template ? `${template} subagent` : "subagent";
    const preview = task.length > 100 ? task.slice(0, 100) + "..." : task;
    telegram.sendText(accountId, parentChatId, `Delegating to ${label}:\n${preview}`).catch(() => {});
  });

  hooks.on("subagent:completed", ({ info }) => {
    // 1. Notify user in Telegram
    const accountId = agentManager.getAccountForAgent(info.parentAgentName);
    if (accountId) {
      const cost = info.costUsd !== undefined ? ` ($${info.costUsd.toFixed(4)})` : "";
      telegram.sendText(accountId, info.parentChatId, `Subagent completed${cost}`).catch(() => {});
    }

    // 2. Deliver result to parent agent — queue-safe (won't clobber in-flight turns)
    if (info.result) {
      const deliveryMessage =
        `[Subagent result — ${info.id}]\n\n${info.result}\n\n` +
        `[End of subagent result. Summarize the findings for the user in your own voice.]`;
      router.sendOrQueue(info.parentAgentName, info.parentChatId, deliveryMessage);
    }
  });

  hooks.on("subagent:failed", ({ info }) => {
    // 1. Notify user in Telegram
    const accountId = agentManager.getAccountForAgent(info.parentAgentName);
    if (accountId) {
      const reason = info.error ? `: ${info.error.slice(0, 200)}` : "";
      telegram.sendText(accountId, info.parentChatId, `Subagent ${info.state}${reason}`).catch(() => {});
    }

    // 2. Inform parent agent — queue-safe
    const deliveryMessage =
      `[Subagent ${info.state} — ${info.id}]\n` +
      (info.error ? `Error: ${info.error}\n` : "") +
      `[The subagent did not complete successfully. Inform the user.]`;
    router.sendOrQueue(info.parentAgentName, info.parentChatId, deliveryMessage);
  });

  // 10. Wire cron hook listeners — log completions/failures, keep user informed
  hooks.on("cron:completed", ({ agentName, job, result }) => {
    log.info(`Cron "${job.name}" (${agentName}) completed in ${result.durationMs}ms`);
  });

  hooks.on("cron:failed", ({ agentName, job, result, consecutiveErrors }) => {
    log.warn(`Cron "${job.name}" (${agentName}) failed (${consecutiveErrors} consecutive): ${result.error?.slice(0, 200)}`);
    // Notify user via Telegram if announce delivery is configured
    if (job.delivery?.mode === "announce") {
      const accountId = agentManager.getAccountForAgent(agentName);
      if (accountId) {
        const msg = `Cron "${job.name}" failed (attempt ${consecutiveErrors}): ${result.error?.slice(0, 200) ?? "unknown error"}`;
        telegram.sendText(accountId, job.delivery.chatId, msg).catch(() => {});
      }
    }
  });

  // 11. Start the internal HTTP bridge (MCP server → FlowClaw core)
  const bridge = new Bridge(agentManager, log, home);
  const bridgePort = await bridge.start();
  agentManager.setBridgeUrl(bridge.getUrl());
  await updateLockBridgeUrl(paths.state, bridge.getUrl());
  log.info(`Bridge ready on port ${bridgePort}`);

  // 12. Start scheduler (cron jobs from agent configs)
  const scheduler = new Scheduler(agentManager, agentManager.cronRunner, telegram, hooks, home, log);
  await scheduler.start();

  // 13. Start router and channel adapter
  // Processes spawn lazily on first message to each chat.
  router.start();
  telegram.start();

  log.info(`FlowClaw is running — ${agents.length} agent(s). Processes spawn per conversation.`);

  // 14. Clean shutdown
  const shutdown = async () => {
    log.info("Shutting down...");
    telegram.stop();
    await scheduler.stop();
    bridge.stop();
    agentManager.stopAll();
    await agentManager.persistSessionIndex();
    releaseInstanceLock(paths.state, log);
    log.info("Goodbye.");
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Safety net: release lock on unexpected exit (uncaught exception, etc.)
  process.on("exit", () => releaseInstanceLock(paths.state, log));
}

// Direct execution (backward compat with `node dist/index.js` or daemon mode)
const isDirectRun = process.argv[1]?.endsWith("index.js") && !process.argv[1]?.includes("cli");
if (isDirectRun) {
  startOrchestrator().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
