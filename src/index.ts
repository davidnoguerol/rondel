import { resolve } from "node:path";
import { createLogger } from "./logger.js";
import { loadFlowclawConfig } from "./config.js";
import { AgentManager } from "./agent-manager.js";
import { Router } from "./router.js";
import { Bridge } from "./bridge.js";
import { Scheduler } from "./scheduler.js";
import { createHooks } from "./hooks.js";

const PROJECT_DIR = resolve(".");

async function main(): Promise<void> {
  const log = createLogger("flowclaw");
  log.info("FlowClaw starting...");

  // 1. Load config
  const config = await loadFlowclawConfig(PROJECT_DIR);
  log.info(`Project: ${config.projectId}, agents: [${config.agents.join(", ")}]`);

  // 2. Create lifecycle hooks
  const hooks = createHooks();

  // 3. Initialize agent templates + channel adapters (no processes spawned yet)
  const agentManager = new AgentManager(log, hooks);
  await agentManager.initialize(PROJECT_DIR, config.agents, config.allowedUsers);

  const telegram = agentManager.getTelegram();

  // 4. Create router (needed by hook listeners for queue-safe message delivery)
  const router = new Router(agentManager, log);

  // 5. Wire hook listeners — subagent lifecycle
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

  // 6. Wire cron hook listeners — log completions/failures, keep user informed
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

  // 7. Start the internal HTTP bridge (MCP server → FlowClaw core)
  const bridge = new Bridge(agentManager, log);
  const bridgePort = await bridge.start();
  agentManager.setBridgeUrl(bridge.getUrl());
  log.info(`Bridge ready on port ${bridgePort}`);

  // 8. Start scheduler (cron jobs from agent configs)
  const scheduler = new Scheduler(agentManager, telegram, hooks, config.projectId, PROJECT_DIR, log);
  await scheduler.start();

  // 9. Start router and channel adapter
  // Processes spawn lazily on first message to each chat.
  router.start();
  telegram.start();

  log.info(`FlowClaw is running — ${config.agents.length} agent templates. Processes spawn per conversation. Press Ctrl+C to stop.`);

  // 9. Clean shutdown
  const shutdown = async () => {
    log.info("Shutting down...");
    telegram.stop();
    await scheduler.stop();
    bridge.stop();
    agentManager.stopAll();
    log.info("Goodbye.");
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
