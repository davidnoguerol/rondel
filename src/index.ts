import { createLogger, initLogFile } from "./shared/logger.js";
import { loadEnvFile } from "./config/env-loader.js";
import { resolveRondelHome, rondelPaths, loadRondelConfig, discoverAll } from "./config/config.js";
import { AgentManager } from "./agents/agent-manager.js";
import { Router } from "./routing/router.js";
import { Bridge } from "./bridge/bridge.js";
import { Scheduler } from "./scheduling/scheduler.js";
import { createHooks } from "./shared/hooks.js";
import { ensureInboxDir, readAllInboxes, removeFromInbox } from "./messaging/inbox.js";
import { LedgerWriter } from "./ledger/index.js";
import { acquireInstanceLock, releaseInstanceLock, updateLockBridgeUrl } from "./system/instance-lock.js";
import { mkdir } from "node:fs/promises";

/**
 * Start the Rondel orchestrator.
 *
 * Loads config from ~/.rondel (or RONDEL_HOME), discovers agents,
 * starts channel adapters, bridge, scheduler, and router.
 *
 * @param rondelHome - Override the Rondel home directory (default: resolveRondelHome())
 */
export async function startOrchestrator(rondelHome?: string): Promise<void> {
  const home = rondelHome ?? resolveRondelHome();
  const paths = rondelPaths(home);

  // 0. Load .env before anything that needs env vars (critical for service context)
  loadEnvFile(paths.env);

  // 0b. If running as daemon, set up file logging
  const isDaemon = process.env.RONDEL_DAEMON === "1";
  if (isDaemon) {
    initLogFile(paths.log);
  }

  const log = createLogger("rondel");
  log.info("Rondel starting...");

  // 1. Load config
  const config = await loadRondelConfig(home);

  // 2. Discover orgs and agents from workspaces/
  const { orgs, agents } = await discoverAll(home);
  if (agents.length === 0) {
    log.error("No agents found in workspaces/. Run 'rondel add agent' to create one.");
    process.exit(1);
  }
  if (orgs.length > 0) {
    log.info(`Discovered ${orgs.length} org(s): [${orgs.map((o) => o.orgName).join(", ")}]`);
  }
  log.info(`Discovered ${agents.length} agent(s): [${agents.map((a) => a.agentName).join(", ")}]`);

  // 3. Ensure state directory exists
  await mkdir(paths.state, { recursive: true });

  // 4. Acquire instance lock — prevents two Rondel processes running simultaneously
  await acquireInstanceLock(paths.state, log, isDaemon ? paths.log : undefined);

  // 5. Create lifecycle hooks
  const hooks = createHooks();

  // 5b. Start conversation ledger (subscribes to hooks, writes state/ledger/*.jsonl)
  new LedgerWriter(paths.state, hooks);

  // 6. Initialize agent templates + channel adapters (no processes spawned yet)
  const agentManager = new AgentManager(log, hooks);
  await agentManager.initialize(home, agents, config.allowedUsers, orgs);

  // 7. Load session index (conversation key → session ID mappings)
  await agentManager.loadSessionIndex();

  const channelRegistry = agentManager.getChannelRegistry();

  // 8. Create router (needed by hook listeners for queue-safe message delivery)
  const router = new Router(agentManager, log, hooks);

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
    const primary = agentManager.getPrimaryChannel(parentAgentName);
    if (!primary) return;
    const label = template ? `${template} subagent` : "subagent";
    const preview = task.length > 100 ? task.slice(0, 100) + "..." : task;
    channelRegistry.sendText(primary.channelType, primary.accountId, parentChatId, `Delegating to ${label}:\n${preview}`).catch(() => {});
  });

  hooks.on("subagent:completed", ({ info }) => {
    // 1. Notify user on the originating channel
    const primary = agentManager.getPrimaryChannel(info.parentAgentName);
    if (primary) {
      const cost = info.costUsd !== undefined ? ` ($${info.costUsd.toFixed(4)})` : "";
      channelRegistry.sendText(info.parentChannelType, primary.accountId, info.parentChatId, `Subagent completed${cost}`).catch(() => {});
    }

    // 2. Deliver result to parent agent via the originating channel
    if (info.result) {
      const deliveryMessage =
        `[Subagent result — ${info.id}]\n\n${info.result}\n\n` +
        `[End of subagent result. Summarize the findings for the user in your own voice.]`;
      router.sendOrQueue(info.parentAgentName, info.parentChannelType, info.parentChatId, deliveryMessage);
    }
  });

  hooks.on("subagent:failed", ({ info }) => {
    // 1. Notify user on the originating channel
    const primary = agentManager.getPrimaryChannel(info.parentAgentName);
    if (primary) {
      const reason = info.error ? `: ${info.error.slice(0, 200)}` : "";
      channelRegistry.sendText(info.parentChannelType, primary.accountId, info.parentChatId, `Subagent ${info.state}${reason}`).catch(() => {});
    }

    // 2. Inform parent agent via the originating channel
    const deliveryMessage =
      `[Subagent ${info.state} — ${info.id}]\n` +
      (info.error ? `Error: ${info.error}\n` : "") +
      `[The subagent did not complete successfully. Inform the user.]`;
    router.sendOrQueue(info.parentAgentName, info.parentChannelType, info.parentChatId, deliveryMessage);
  });

  // 10. Wire cron hook listeners — log completions/failures, keep user informed
  hooks.on("cron:completed", ({ agentName, job, result }) => {
    log.info(`Cron "${job.name}" (${agentName}) completed in ${result.durationMs}ms`);
  });

  hooks.on("cron:failed", ({ agentName, job, result, consecutiveErrors }) => {
    log.warn(`Cron "${job.name}" (${agentName}) failed (${consecutiveErrors} consecutive): ${result.error?.slice(0, 200)}`);
    // Notify user via primary channel if announce delivery is configured
    if (job.delivery?.mode === "announce") {
      const primary = agentManager.getPrimaryChannel(agentName);
      if (primary) {
        const msg = `Cron "${job.name}" failed (attempt ${consecutiveErrors}): ${result.error?.slice(0, 200) ?? "unknown error"}`;
        channelRegistry.sendText(primary.channelType, primary.accountId, job.delivery.chatId, msg).catch(() => {});
      }
    }
  });

  // 10b. Wire hook listeners — inter-agent messaging (console logging only;
  //      structured JSONL is now handled by the LedgerWriter)
  hooks.on("message:sent", ({ message }) => {
    log.info(`Agent message: ${message.from} → ${message.to} (${message.id})`);
  });

  hooks.on("message:reply", ({ inReplyTo, from, to }) => {
    log.info(`Agent reply: ${from} → ${to} (re: ${inReplyTo})`);
  });

  // 11. Start the internal HTTP bridge (MCP server → Rondel core)
  const bridge = new Bridge(agentManager, log, home, hooks, router);
  const bridgePort = await bridge.start();
  agentManager.setBridgeUrl(bridge.getUrl());
  await updateLockBridgeUrl(paths.state, bridge.getUrl());
  log.info(`Bridge ready on port ${bridgePort}`);

  // 11b. Recover any pending inter-agent messages from inbox files
  //      (messages persisted to disk but not yet delivered — e.g. crash during delivery)
  await ensureInboxDir(paths.state);
  const pending = await readAllInboxes(paths.state);
  if (pending.length > 0) {
    log.info(`Recovering ${pending.length} pending inter-agent message(s) from inbox`);
    for (const message of pending) {
      const wrappedContent =
        `[Message from ${message.from} — ${message.id}]\n\n` +
        `${message.content}\n\n` +
        `[End of message. Respond naturally — your response will be delivered back to them.]`;

      const senderPrimary = agentManager.getPrimaryChannel(message.from);
      if (!senderPrimary) {
        log.error(`Cannot recover inter-agent message ${message.id}: no channel binding for sender "${message.from}"`);
        removeFromInbox(paths.state, message.to, message.id).catch(() => {});
        continue;
      }
      router.deliverAgentMail(message.to, wrappedContent, {
        senderAgent: message.from,
        senderChannelType: senderPrimary.channelType,
        senderChatId: message.replyToChatId,
        messageId: message.id,
      });

      removeFromInbox(paths.state, message.to, message.id).catch(() => {});
    }
  }

  // 12. Start scheduler (cron jobs from agent configs)
  const scheduler = new Scheduler(agentManager, agentManager.cronRunner, channelRegistry, hooks, home, log);
  await scheduler.start();

  // 13. Start router and channel adapters
  // Processes spawn lazily on first message to each chat.
  router.start();
  channelRegistry.startAll();

  log.info(`Rondel is running — ${agents.length} agent(s). Processes spawn per conversation.`);

  // 14. Clean shutdown
  const shutdown = async () => {
    log.info("Shutting down...");
    channelRegistry.stopAll();
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
