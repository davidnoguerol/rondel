import { createLogger, initLogFile } from "./shared/logger.js";
import { loadEnvFile } from "./config/env-loader.js";
import { resolveRondelHome, rondelPaths, loadRondelConfig, discoverAll } from "./config/config.js";
import { AgentManager } from "./agents/agent-manager.js";
import { Router } from "./routing/router.js";
import { QueueStore } from "./routing/queue-store.js";
import { Bridge } from "./bridge/bridge.js";
import { Scheduler } from "./scheduling/scheduler.js";
import { createHooks } from "./shared/hooks.js";
import { ensureInboxDir, readAllInboxes, removeFromInbox } from "./messaging/inbox.js";
import { LedgerWriter } from "./ledger/index.js";
import { LedgerStreamSource, AgentStateStreamSource, ApprovalStreamSource, ScheduleStreamSource, HeartbeatStreamSource, TaskStreamSource, MultiplexStreamSource } from "./streams/index.js";
import { acquireInstanceLock, releaseInstanceLock, updateLockBridgeUrl } from "./system/instance-lock.js";
import { ApprovalService } from "./approvals/index.js";
import { ReadFileStateStore, FileHistoryStore } from "./filesystem/index.js";
import { AttachmentStore, AttachmentService } from "./attachments/index.js";
import { ScheduleStore, ScheduleService, ScheduleWatchdog } from "./scheduling/index.js";
import { HeartbeatService } from "./heartbeats/index.js";
import { PendingApprovalStore, TaskService } from "./tasks/index.js";
import { parseInterval } from "./scheduling/index.js";
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
  const ledgerWriter = new LedgerWriter(paths.state, hooks);

  // 5c. Live ledger stream — fans new ledger events out to SSE clients.
  //     Subscribes to ledgerWriter.onAppended; one shared instance for the
  //     daemon's lifetime, disposed in shutdown() after the bridge stops.
  const ledgerStream = new LedgerStreamSource(ledgerWriter);

  // 5d. Inbound attachment plumbing.
  //     The store owns per-conversation staging under state/attachments/;
  //     the service downloads bytes from Telegram and classifies kind.
  //     Both are created before AgentManager.initialize so the channel
  //     adapters and ConversationManager can be wired up with them in a
  //     single pass.
  const attachmentStore = new AttachmentStore(paths.attachments, log);
  const attachmentService = new AttachmentService(attachmentStore, log);

  // 6. Initialize agent templates + channel adapters (no processes spawned yet)
  const agentManager = new AgentManager(log, hooks);
  await agentManager.initialize(home, agents, config.allowedUsers, orgs, {
    store: attachmentStore,
    service: attachmentService,
  });

  // 7. Load session index (conversation key → session ID mappings)
  await agentManager.loadSessionIndex();

  const channelRegistry = agentManager.getChannelRegistry();

  // 8. Create router with its disk-backed queue store.
  //    Queue recovery happens after inbox recovery (step 11), before the
  //    router starts consuming inbound channel messages.
  const queueStore = new QueueStore(paths.state);
  await queueStore.ensureDir();
  const router = new Router(agentManager, log, queueStore, hooks);

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

  hooks.on("subagent:spawning", ({ parentChannelType, parentAccountId, parentChatId, task }) => {
    const preview = task.length > 100 ? task.slice(0, 100) + "..." : task;
    channelRegistry.sendText(parentChannelType, parentAccountId, parentChatId, `Delegating to subagent:\n${preview}`).catch(() => {});
  });

  hooks.on("subagent:completed", ({ info }) => {
    // 1. Notify user on the originating channel+account
    const cost = info.costUsd !== undefined ? ` ($${info.costUsd.toFixed(4)})` : "";
    channelRegistry.sendText(info.parentChannelType, info.parentAccountId, info.parentChatId, `Subagent completed${cost}`).catch(() => {});

    // 2. Deliver result to parent agent via the originating channel.
    // sendOrQueue is async (serialized per-conversation); fire-and-forget
    // from this listener, but log a rejection instead of swallowing silently.
    if (info.result) {
      const deliveryMessage =
        `[Subagent result — ${info.id}]\n\n${info.result}\n\n` +
        `[End of subagent result. Summarize the findings for the user in your own voice.]`;
      router.sendOrQueue(info.parentAgentName, info.parentChannelType, info.parentChatId, deliveryMessage)
        .catch((err) => log.error(`Failed to deliver subagent result ${info.id}: ${err instanceof Error ? err.message : String(err)}`));
    }
  });

  hooks.on("subagent:failed", ({ info }) => {
    // 1. Notify user on the originating channel+account
    const reason = info.error ? `: ${info.error.slice(0, 200)}` : "";
    channelRegistry.sendText(info.parentChannelType, info.parentAccountId, info.parentChatId, `Subagent ${info.state}${reason}`).catch(() => {});

    // 2. Inform parent agent via the originating channel
    const deliveryMessage =
      `[Subagent ${info.state} — ${info.id}]\n` +
      (info.error ? `Error: ${info.error}\n` : "") +
      `[The subagent did not complete successfully. Inform the user.]`;
    router.sendOrQueue(info.parentAgentName, info.parentChannelType, info.parentChatId, deliveryMessage)
      .catch((err) => log.error(`Failed to deliver subagent failure ${info.id}: ${err instanceof Error ? err.message : String(err)}`));
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

  // 10c. Live agent-state stream — snapshot + delta updates of every
  //      conversation's state. Subscribes to ConversationManager (which
  //      only exists after agentManager.initialize()). Disposed in
  //      shutdown() after the bridge stops.
  const agentStateStream = new AgentStateStreamSource(agentManager.conversations);

  // 10d. HITL approvals — PreToolUse hook escalation + web UI resolution.
  //      Built with `channels` + a template-based accountId resolver so
  //      approval cards route back to the exact conversation that caused
  //      the tool call. Recovered BEFORE agents spawn so orphan pending
  //      records from a crashed run get auto-denied and won't be
  //      mistakenly delivered to a fresh process.
  const approvals = new ApprovalService({
    paths: {
      pendingDir: paths.approvalsPending,
      resolvedDir: paths.approvalsResolved,
    },
    hooks,
    channels: channelRegistry,
    resolveAccountId: (agentName, channelType) => {
      const template = agentManager.getTemplate(agentName);
      if (!template) return undefined;
      const binding = template.config.channels.find((c) => c.channelType === channelType);
      return binding?.accountId;
    },
    log,
  });
  await approvals.init();
  await approvals.recoverPending();

  //      Live approval stream — fans `approval:requested`/`approval:resolved`
  //      hook events out to the web `/approvals` SSE tail. Constructed after
  //      the approval service so hook subscribers see the same record shape
  //      the service just persisted. Disposed in shutdown() after the bridge
  //      stops accepting connections.
  const approvalStream = new ApprovalStreamSource(hooks);

  // 10e. Wire the interactive callback from channels → approval resolution.
  //      Any adapter that supports buttons (Telegram today; Slack/Discord
  //      tomorrow) fires `onInteractiveCallback` with the raw callback_data
  //      string. Rondel-approval buttons use the prefix `rondel_appr_` —
  //      anything else is ignored here so other subsystems can share the
  //      same callback seat later.
  channelRegistry.onInteractiveCallback((cb) => {
    // Tool-use approval (Approve/Deny on a permission card).
    const apprMatch = cb.callbackData.match(/^rondel_appr_(allow|deny)_(.+)$/);
    if (apprMatch) {
      const decision = apprMatch[1] === "allow" ? "allow" : "deny";
      const requestId = apprMatch[2];
      approvals.resolve(requestId, decision, `${cb.channelType}:${cb.senderId}`).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`Approval callback resolve failed for ${requestId}: ${msg}`);
      });

      // Cosmetic: edit the card to show the resolution, ack the button.
      // Telegram-specific for now — per-adapter callback acking is not
      // yet part of the generic ChannelAdapter interface. The adapter's
      // own methods handle missing accounts gracefully.
      if (cb.channelType === "telegram") {
        const adapter = channelRegistry.get("telegram") as
          | { answerCallbackQuery?: (accountId: string, id: string, text?: string) => Promise<void>;
              editMessageText?: (accountId: string, chatId: string, messageId: number, text: string) => Promise<void>; }
          | undefined;
        if (adapter?.answerCallbackQuery && cb.callbackQueryId) {
          adapter.answerCallbackQuery(cb.accountId, cb.callbackQueryId, "Got it").catch(() => {});
        }
        if (adapter?.editMessageText && cb.messageId !== undefined) {
          const label = decision === "allow" ? "Approved ✅" : "Denied ❌";
          adapter.editMessageText(cb.accountId, cb.chatId, cb.messageId, label).catch(() => {});
        }
      }
      return;
    }

    // Ask-user prompt (rondel_ask_user) — operator tapped an option
    // button. Route to the bridge's in-memory store so the polling MCP
    // tool sees the resolution on its next GET.
    const aqMatch = cb.callbackData.match(/^rondel_aq_(askuser_\d+_[a-f0-9]+)_(\d+)$/);
    if (aqMatch) {
      const requestId = aqMatch[1];
      const optionIndex = Number.parseInt(aqMatch[2], 10);
      bridge.resolveAskUser(requestId, optionIndex, `${cb.channelType}:${cb.senderId}`);

      if (cb.channelType === "telegram") {
        const adapter = channelRegistry.get("telegram") as
          | { answerCallbackQuery?: (accountId: string, id: string, text?: string) => Promise<void>;
              editMessageText?: (accountId: string, chatId: string, messageId: number, text: string) => Promise<void>; }
          | undefined;
        if (adapter?.answerCallbackQuery && cb.callbackQueryId) {
          adapter.answerCallbackQuery(cb.accountId, cb.callbackQueryId, "Got it").catch(() => {});
        }
        // We don't edit the message text here — the selected-label UX is
        // left to the agent's own follow-up response. Keeping the
        // keyboard message intact also preserves the log for the user.
      }
      return;
    }
  });

  // 10f. Filesystem state for the first-class tool suite (Phase 3).
  //      - ReadFileStateStore: in-memory session-scoped read hashes so
  //        rondel_write_file / rondel_edit_file can enforce the "you must
  //        have read this file first" invariant. Hooked to session:crash/halt
  //        on first use so stale records drop on conversation failure.
  //      - FileHistoryStore: disk-backed pre-image backups before every
  //        overwrite, rooted at state/file-history/. Retention: 7 days.
  const readFileState = new ReadFileStateStore(hooks);
  const fileHistory = new FileHistoryStore(paths.state, log);
  // Prune old backups at startup + once per day. .unref() so the timer
  // doesn't keep the daemon alive after a normal shutdown.
  fileHistory.cleanup().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`Initial file-history cleanup failed: ${msg}`);
  });
  // Inbound attachments share the same 24 h cadence — initial prune
  // catches anything left over from a previous run, then daily passes
  // hold the directory size bounded for chatty conversations. Per-save
  // opportunistic pruning inside AttachmentStore covers the within-day
  // burst case.
  attachmentStore.cleanup().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`Initial attachments cleanup failed: ${msg}`);
  });
  const cleanupInterval = setInterval(() => {
    fileHistory.cleanup().catch(() => {});
    attachmentStore.cleanup().catch(() => {});
  }, 24 * 60 * 60 * 1000);
  cleanupInterval.unref();

  // 10g. Runtime scheduling — file-backed store for schedules created at
  //      runtime via rondel_schedule_*. Must load before the scheduler so
  //      the scheduler can merge declarative (agent.json) + runtime
  //      sources on its first pass. Scheduler is constructed (no I/O) now,
  //      started after the bridge URL is set.
  const scheduleStore = new ScheduleStore(paths.schedulesFile, log);
  await scheduleStore.init();
  const scheduler = new Scheduler(
    agentManager,
    agentManager.cronRunner,
    channelRegistry,
    hooks,
    home,
    scheduleStore,
    log,
  );
  const scheduleService = new ScheduleService({
    store: scheduleStore,
    scheduler,
    hooks,
    log,
    orgLookup: (name) => {
      if (!agentManager.getTemplate(name)) return { status: "unknown" };
      const org = agentManager.getAgentOrg(name);
      return org ? { status: "org", orgName: org.orgName } : { status: "global" };
    },
    isKnownAgent: (name) => agentManager.getTemplate(name) !== undefined,
  });

  // Live schedule stream — fans `schedule:{created,updated,deleted,ran}`
  // hook events out to the web `/schedules/tail` SSE endpoint. The
  // scheduler doubles as the snapshot lookup for non-`ran` frames, since
  // it carries the authoritative nextRun/lastRun state.
  const scheduleStream = new ScheduleStreamSource(hooks, scheduler);

  // 10h. Per-agent heartbeats — liveness records written by each agent on
  //      its scheduled discipline turn (see rondel-heartbeat skill). One
  //      JSON file per agent under state/heartbeats/, plus a ledger event
  //      and an SSE delta on every write. `resolveIntervalMs` reads the
  //      agent's current heartbeat cron entry so the record carries the
  //      right "expected next" cadence.
  const HEARTBEAT_DEFAULT_INTERVAL_MS = 4 * 60 * 60 * 1000;
  const heartbeatService = new HeartbeatService({
    paths: { dir: paths.heartbeats },
    hooks,
    log,
    orgLookup: (name) => {
      if (!agentManager.getTemplate(name)) return { status: "unknown" };
      const org = agentManager.getAgentOrg(name);
      return org ? { status: "org", orgName: org.orgName } : { status: "global" };
    },
    isKnownAgent: (name) => agentManager.getTemplate(name) !== undefined,
    listAllAgents: () => agentManager.getAgentNames(),
    resolveIntervalMs: (agentName) => {
      const template = agentManager.getTemplate(agentName);
      const cron = template?.config.crons?.find(
        (c) => c.id === "heartbeat" || c.name === "heartbeat",
      );
      if (!cron || cron.schedule.kind !== "every") return HEARTBEAT_DEFAULT_INTERVAL_MS;
      try {
        return parseInterval(cron.schedule.interval);
      } catch {
        return HEARTBEAT_DEFAULT_INTERVAL_MS;
      }
    },
  });
  await heartbeatService.init();
  const heartbeatStream = new HeartbeatStreamSource(hooks, heartbeatService);

  // 10i. Task board — per-org JSON + O_EXCL claim + audit + approval
  //      gating for externalAction tasks. MUST init AFTER
  //      approvals.recoverPending() so pending-approval reconciliation
  //      sees the final approval state, not pending orphans that are
  //      about to be auto-denied.
  const taskPaths = { rootDir: paths.tasks };
  const pendingApprovalStore = new PendingApprovalStore(taskPaths, log);
  const taskService = new TaskService({
    paths: taskPaths,
    hooks,
    log,
    orgLookup: (name) => {
      if (!agentManager.getTemplate(name)) return { status: "unknown" };
      const org = agentManager.getAgentOrg(name);
      return org ? { status: "org", orgName: org.orgName } : { status: "global" };
    },
    isKnownAgent: (name) => agentManager.getTemplate(name) !== undefined,
    pendingApprovals: pendingApprovalStore,
    approvals,
  });
  await taskService.init();
  const taskStream = new TaskStreamSource(hooks, taskService);

  // 10j. Multiplexed event stream — one physical SSE connection carrying
  //      approvals / agents-state / tasks / ledger / schedules / heartbeats
  //      topics. Replaces the per-topic /tail endpoints (removed in v17)
  //      so the web dashboard doesn't burn one browser connection slot
  //      per live topic and saturate the HTTP/1.1 per-origin cap.
  //
  //      The multiplex holds references to the component sources —
  //      construct AFTER all six so subscription wiring lands on live
  //      instances. Dispose BEFORE the components in shutdown() so it
  //      releases its listeners before they tear down.
  const multiplexStream = new MultiplexStreamSource({
    approvals: approvalStream,
    agentsState: agentStateStream,
    tasks: taskStream,
    ledger: ledgerStream,
    schedules: scheduleStream,
    heartbeats: heartbeatStream,
  });

  // 11. Start the internal HTTP bridge (MCP server → Rondel core)
  const bridge = new Bridge(
    agentManager,
    log,
    home,
    hooks,
    router,
    approvals,
    readFileState,
    fileHistory,
    scheduleService,
    heartbeatService,
    taskService,
    multiplexStream,
  );
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
      await router.deliverAgentMail(message.to, wrappedContent, {
        senderAgent: message.from,
        senderChannelType: senderPrimary.channelType,
        senderChatId: message.replyToChatId,
        messageId: message.id,
      });

      removeFromInbox(paths.state, message.to, message.id).catch(() => {});
    }
  }

  // 12. Start scheduler (cron jobs from agent configs + runtime store)
  await scheduler.start();

  // 12b. Schedule watchdog — detects silent scheduling failures (timer drift
  //      from OS sleep, stuck-in-backoff jobs, never-fired startup bugs) and
  //      emits `schedule:overdue` / `schedule:recovered` hook events that the
  //      LedgerWriter persists. Observation-only by default; self-heal is
  //      off until we have ledger signal showing real drift in production.
  const watchdog = new ScheduleWatchdog({
    scheduler,
    hooks,
    log,
    selfHeal: false,
  });
  watchdog.start();

  // 13. Recover any queues persisted from the previous run (messages that
  //     had been accepted by the Router but hadn't drained before the
  //     daemon stopped). Must run after agent templates are loaded and
  //     before the Router starts consuming new inbound messages.
  await router.recoverQueues();

  // 14. Start router and channel adapters
  // Processes spawn lazily on first message to each chat.
  router.start();
  channelRegistry.startAll();

  log.info(`Rondel is running — ${agents.length} agent(s). Processes spawn per conversation.`);

  // 14. Clean shutdown
  const shutdown = async () => {
    log.info("Shutting down...");
    clearInterval(cleanupInterval);
    watchdog.stop();
    channelRegistry.stopAll();
    await scheduler.stop();
    bridge.stop();
    // Dispose stream sources after the bridge stops accepting new
    // connections — by this point no new SSE clients can attach, and
    // disposing here ensures upstream subscriptions (LedgerWriter,
    // ConversationManager) are released before agentManager.stopAll()
    // tears down the conversation processes those listeners observe.
    //
    // Multiplex disposes FIRST so it releases its subscriptions on the
    // component sources before those sources tear down. (Disposing the
    // components first is harmless — the multiplex's unsubscribe is a
    // Set.delete — but this ordering is what the design intent is and
    // keeps the dependency direction explicit.)
    multiplexStream.dispose();
    ledgerStream.dispose();
    agentStateStream.dispose();
    approvalStream.dispose();
    scheduleStream.dispose();
    heartbeatStream.dispose();
    taskStream.dispose();
    taskService.dispose();
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
