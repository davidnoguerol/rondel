import { resolve } from "node:path";
import { createLogger } from "./logger.js";
import { loadFlowclawConfig } from "./config.js";
import { AgentManager } from "./agent-manager.js";
import { Router } from "./router.js";
import { Bridge } from "./bridge.js";
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

  // 4. Wire hook listeners — subagent lifecycle
  //
  // Follows OpenClaw's async model:
  // - Spawn returns immediately, parent's turn ends
  // - Subagent runs in background
  // - On completion, result is delivered to parent as a user message
  // - Parent processes the result in a new turn
  //
  // Telegram notifications keep the user informed at each stage.

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

    // 2. Deliver result to parent agent as a message — triggers a new turn
    const parentProcess = agentManager.getConversation(info.parentAgentName, info.parentChatId);
    if (parentProcess && info.result) {
      const deliveryMessage =
        `[Subagent result — ${info.id}]\n\n${info.result}\n\n` +
        `[End of subagent result. Summarize the findings for the user in your own voice.]`;
      parentProcess.sendMessage(deliveryMessage);
    }
  });

  hooks.on("subagent:failed", ({ info }) => {
    // 1. Notify user in Telegram
    const accountId = agentManager.getAccountForAgent(info.parentAgentName);
    if (accountId) {
      const reason = info.error ? `: ${info.error.slice(0, 200)}` : "";
      telegram.sendText(accountId, info.parentChatId, `Subagent ${info.state}${reason}`).catch(() => {});
    }

    // 2. Inform parent agent so it can respond appropriately
    const parentProcess = agentManager.getConversation(info.parentAgentName, info.parentChatId);
    if (parentProcess) {
      const deliveryMessage =
        `[Subagent ${info.state} — ${info.id}]\n` +
        (info.error ? `Error: ${info.error}\n` : "") +
        `[The subagent did not complete successfully. Inform the user.]`;
      parentProcess.sendMessage(deliveryMessage);
    }
  });

  // 5. Start the internal HTTP bridge (MCP server → FlowClaw core)
  const bridge = new Bridge(agentManager, log);
  const bridgePort = await bridge.start();
  agentManager.setBridgeUrl(bridge.getUrl());
  log.info(`Bridge ready on port ${bridgePort}`);

  // 6. Wire router and start channel adapter
  // Processes spawn lazily on first message to each chat.
  const router = new Router(agentManager, log);
  router.start();
  telegram.start();

  log.info(`FlowClaw is running — ${config.agents.length} agent templates. Processes spawn per conversation. Press Ctrl+C to stop.`);

  // 7. Clean shutdown
  const shutdown = () => {
    log.info("Shutting down...");
    telegram.stop();
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
