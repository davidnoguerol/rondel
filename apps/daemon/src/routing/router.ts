import type { AgentManager } from "../agents/agent-manager.js";
import type { AgentProcess } from "../agents/agent-process.js";
import type { ChannelMessage } from "../channels/core/index.js";
import type { QueuedMessage, ConversationKey, AgentMailReplyTo } from "../shared/types/index.js";
import { conversationKey, parseConversationKey, AGENT_MAIL_CHAT_ID, INTERNAL_CHANNEL_TYPE } from "../shared/types/index.js";
import { AsyncLock } from "../shared/async-lock.js";
import { QueueStore } from "./queue-store.js";
import type { RondelHooks } from "../shared/hooks.js";
import type { Logger } from "../shared/logger.js";

/**
 * Max queued messages per conversation. Each queued message becomes a full
 * agent turn (API call + tool use + response), so a queue of 200 means hours
 * of sequential processing. The cap provides backpressure — the agent still
 * processes all accepted messages, but rejects new ones until it catches up.
 */
const MAX_QUEUE_SIZE = 50;

/**
 * Wires channel messages to per-conversation agent processes.
 *
 * Each unique (agent, channelType, chatId) triple gets its own Claude process.
 * First message to a new chat spawns the process.
 * Responses route back through the originating channel + account + chat.
 *
 * Also handles inter-agent messaging via the "agent-mail" conversation:
 * messages from other agents are delivered to a synthetic conversation,
 * and responses are automatically routed back to the sender.
 */
export class Router {
  private readonly queues = new Map<ConversationKey, QueuedMessage[]>(); // conversationKey → queue
  private readonly wiredProcesses = new Set<AgentProcess>();     // track which processes we've wired
  private readonly log: Logger;

  /**
   * Per-conversation serial lock.
   *
   * Every path that inspects the process state and decides whether to send
   * immediately or enqueue must hold this lock for the conversation in
   * question. Without it, two concurrent callers (e.g. a hook listener
   * firing while an inbound message arrives) can both observe `idle`,
   * both call `process.sendMessage`, and produce out-of-order delivery.
   * AgentProcess serializes stdin but not the decision of what to send
   * next — this lock closes that TOCTOU window.
   */
  private readonly conversationLock = new AsyncLock();

  // --- Inter-agent messaging state ---
  /** Reply-to info for the currently-processing agent-mail message, keyed by agent name. */
  private readonly agentMailReplyTo = new Map<string, AgentMailReplyTo>();
  /** Buffered response text from agent-mail processes, keyed by agent name. */
  private readonly agentMailResponseBuffer = new Map<string, string[]>();

  constructor(
    private readonly agentManager: AgentManager,
    log: Logger,
    private readonly queueStore: QueueStore,
    private readonly hooks?: RondelHooks,
  ) {
    this.log = log.child("router");
  }

  /** Start listening for channel messages. */
  start(): void {
    const registry = this.agentManager.getChannelRegistry();
    registry.onMessage((msg) => this.handleInboundMessage(msg));
    this.log.info("Router started");
  }

  /**
   * Rebuild in-memory queues from disk and rewire the underlying processes
   * so drain fires naturally on the next idle transition.
   *
   * Called once at startup, after `ensureDir` on the queue store and after
   * the agent manager has loaded its templates, but before `start()`.
   *
   * For each persisted (key → messages) entry:
   *   1. Parse the key. Malformed keys are logged and their disk entry
   *      cleared (already quarantined by `readAll` if invalid JSON).
   *   2. Resolve the agent. If it no longer exists (config change, agent
   *      deleted), the queue is orphaned — log and clear the disk entry.
   *   3. `getOrSpawnConversation` instantiates the process so the Router
   *      has something to wire and drain against.
   *   4. `wireProcess` installs response/state listeners (idempotent).
   *   5. Populate `this.queues` so the next idle transition drains them
   *      via `drainQueue`.
   *
   * At-least-once delivery: a message that was dispatched but whose
   * `removeFirst` hadn't completed before the crash will be replayed here.
   */
  async recoverQueues(): Promise<void> {
    const persisted = await this.queueStore.readAll();
    if (persisted.size === 0) {
      this.log.info("Queue recovery: no persisted queues");
      return;
    }

    let recovered = 0;
    let orphaned = 0;
    let totalMessages = 0;

    for (const [key, messages] of persisted) {
      let agentName: string;
      let channelType: string;
      let chatId: string;
      try {
        [agentName, channelType, chatId] = parseConversationKey(key);
      } catch (err) {
        this.log.warn(`Queue recovery: skipping malformed key ${JSON.stringify(key)}: ${err instanceof Error ? err.message : String(err)}`);
        await this.queueStore.clear(key).catch(() => {});
        continue;
      }

      const process = this.agentManager.getOrSpawnConversation(agentName, channelType, chatId);
      if (!process) {
        this.log.warn(`Queue recovery: orphaned queue for unknown agent "${agentName}" (${messages.length} messages) — clearing`);
        await this.queueStore.clear(key).catch(() => {});
        orphaned++;
        continue;
      }

      const accountId = this.agentManager.getPrimaryChannel(agentName)?.accountId ?? agentName;
      this.wireProcess(agentName, channelType, accountId, chatId, process);

      // Populate in-memory queue. Drain fires on the next idle transition.
      const target = this.getQueueForKey(key);
      target.push(...messages);

      recovered++;
      totalMessages += messages.length;
    }

    this.log.info(`Queue recovery: ${recovered} conversation(s), ${totalMessages} message(s) (${orphaned} orphaned)`);
  }

  /**
   * Send a message to a conversation, respecting busy state.
   * If the agent is idle, sends immediately. If busy, queues for delivery
   * when the agent becomes idle. Used by hook listeners for subagent result
   * delivery, inter-agent message delivery, and any other internal injection.
   *
   * Serialized per-conversation via `conversationLock` — the state check and
   * the send/enqueue decision are atomic from any concurrent caller's view.
   */
  async sendOrQueue(agentName: string, channelType: string, chatId: string, text: string, replyTo?: AgentMailReplyTo): Promise<void> {
    const process = this.agentManager.getConversation(agentName, channelType, chatId);
    if (!process) {
      this.log.warn(`sendOrQueue: no conversation for ${agentName}:${channelType}:${chatId}`);
      return;
    }

    // Ensure process is wired so queue drain works. Wiring is idempotent
    // (guarded by wiredProcesses) and does not need lock protection — the
    // set operation itself is synchronous.
    const accountId = this.agentManager.getPrimaryChannel(agentName)?.accountId ?? agentName;
    this.wireProcess(agentName, channelType, accountId, chatId, process);

    const key = conversationKey(agentName, channelType, chatId);
    await this.conversationLock.withLock(key, async () => {
      const state = process.getState();
      if (state === "idle") {
        // Set reply-to tracking before sending (for agent-mail responses)
        if (replyTo) {
          this.agentMailReplyTo.set(agentName, replyTo);
        }
        // Start typing indicator for user conversations when injecting internal messages
        // (subagent results, inter-agent replies). Without this, the user sees silence
        // while the agent processes the injected message.
        if (chatId !== AGENT_MAIL_CHAT_ID) {
          const registry = this.agentManager.getChannelRegistry();
          registry.startTypingIndicator(channelType, accountId, chatId);
        }
        process.sendMessage(text);
      } else {
        await this.enqueue({
          agentName,
          channelType,
          accountId,
          chatId,
          text,
          queuedAt: Date.now(),
          agentMailReplyTo: replyTo,
        }, state);
      }
    });
  }

  /**
   * Push a message onto a conversation's queue, respecting MAX_QUEUE_SIZE.
   *
   * Caller must already hold `conversationLock` for the message's key.
   * Used by both `sendOrQueue` (internal injection path) and
   * `handleInboundMessage` (external user-message path) so both paths
   * enforce the same backpressure and disk-persistence discipline.
   *
   * Persistence order: disk first, memory second. If the disk write
   * throws, we never push to memory — the caller's `await` sees the
   * error and can surface it. Accepting a message into memory without
   * persisting it would break the at-least-once guarantee.
   */
  private async enqueue(msg: QueuedMessage, observedState: string): Promise<void> {
    const key = conversationKey(msg.agentName, msg.channelType, msg.chatId);
    const queue = this.getQueueForKey(key);
    if (queue.length >= MAX_QUEUE_SIZE) {
      this.log.warn(`[${key}] Queue full (${MAX_QUEUE_SIZE}) — message dropped`);
      return;
    }
    await this.queueStore.append(key, msg);
    queue.push(msg);
    this.log.info(`[${key}] Message queued (agent is ${observedState}, queue size: ${queue.length})`);
  }

  /**
   * Deliver an inter-agent message to the recipient's agent-mail conversation.
   * Spawns the agent-mail process if it doesn't exist yet.
   */
  async deliverAgentMail(agentName: string, text: string, replyTo: AgentMailReplyTo): Promise<void> {
    // Ensure the agent-mail conversation process exists (lazy spawn)
    const process = this.agentManager.getOrSpawnConversation(agentName, INTERNAL_CHANNEL_TYPE, AGENT_MAIL_CHAT_ID);
    if (!process) {
      this.log.error(`deliverAgentMail: failed to spawn agent-mail for ${agentName}`);
      return;
    }

    // Wire with agent-mail-specific handlers (idempotent)
    const accountId = this.agentManager.getPrimaryChannel(agentName)?.accountId ?? agentName;
    this.wireProcess(agentName, INTERNAL_CHANNEL_TYPE, accountId, AGENT_MAIL_CHAT_ID, process);

    // Deliver via sendOrQueue (respects busy state)
    await this.sendOrQueue(agentName, INTERNAL_CHANNEL_TYPE, AGENT_MAIL_CHAT_ID, text, replyTo);
  }

  private getQueue(agentName: string, channelType: string, chatId: string): QueuedMessage[] {
    return this.getQueueForKey(conversationKey(agentName, channelType, chatId));
  }

  private getQueueForKey(key: ConversationKey): QueuedMessage[] {
    let queue = this.queues.get(key);
    if (!queue) {
      queue = [];
      this.queues.set(key, queue);
    }
    return queue;
  }

  /**
   * Wipe a conversation's queue in both memory and on disk.
   *
   * Acquires `conversationLock` so it can't race a concurrent enqueue for
   * the same key — otherwise an in-flight `enqueue` could land its disk
   * write after our clear, leaving a stale file that would replay on the
   * next startup. Used by `/stop`, `/restart`, `/new`.
   */
  private async clearConversationQueue(key: ConversationKey): Promise<void> {
    await this.conversationLock.withLock(key, async () => {
      this.queues.delete(key);
      await this.queueStore.clear(key);
    });
  }

  /**
   * Wire response and state events for a conversation process.
   * Called once per process — tracked via wiredProcesses set.
   *
   * For agent-mail conversations (chatId === AGENT_MAIL_CHAT_ID), installs
   * different handlers: responses are buffered and routed back to the sender
   * instead of going to the channel.
   */
  private wireProcess(agentName: string, channelType: string, accountId: string, chatId: string, process: AgentProcess): void {
    if (this.wiredProcesses.has(process)) return;
    this.wiredProcesses.add(process);

    if (chatId === AGENT_MAIL_CHAT_ID) {
      this.wireAgentMailProcess(agentName, process);
    } else {
      this.wireUserProcess(agentName, channelType, accountId, chatId, process);
    }
  }

  /**
   * Wire a user-facing conversation process (sends responses to the originating channel).
   */
  private wireUserProcess(agentName: string, channelType: string, accountId: string, chatId: string, process: AgentProcess): void {
    const registry = this.agentManager.getChannelRegistry();

    process.on("response", async (text, blockId) => {
      this.hooks?.emit("conversation:response", { agentName, channelType, chatId, text, blockId });
      try {
        await registry.sendText(channelType, accountId, chatId, text);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.log.error(`[${agentName}:${channelType}:${chatId}] Failed to send response: ${message}`);
      }
    });

    // Streaming deltas: emit the hook but DO NOT fan out to the channel.
    // Chat-channel adapters (Telegram) can't edit messages fast enough for
    // token-level streaming, and sending one message per delta would spam.
    // Only hook subscribers that explicitly opt in (the web conversation
    // stream) consume deltas.
    process.on("response_delta", (blockId, chunk) => {
      this.hooks?.emit("conversation:response_delta", { agentName, channelType, chatId, blockId, chunk });
    });

    process.on("stateChange", async (state) => {
      // Stop typing whenever agent is no longer busy
      if (state !== "busy") {
        registry.stopTypingIndicator(channelType, accountId, chatId);
      }

      if (state === "idle") {
        // Post-turn restart (e.g. skill reload) must fire before drain —
        // restarting after drain would kill the next queued message mid-turn.
        // The fresh process will fire its own idle event and drain naturally.
        if (this.consumePendingRestart(agentName, channelType, chatId, process)) {
          return;
        }
        // Fire-and-forget from the event handler; surface unexpected failures
        // instead of letting them become unhandled promise rejections.
        this.drainQueue(agentName, channelType, chatId, accountId, process).catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          this.log.error(`[${agentName}:${channelType}:${chatId}] drain failed: ${message}`);
        });
      }

      if (state === "crashed") {
        // Crash recovery will reload skills anyway — no need for the scheduled restart.
        this.clearPendingRestart(agentName, channelType, chatId);
        await registry.sendText(channelType, accountId, chatId, `\u26a0\ufe0f Agent crashed \u2014 restarting...`);
      } else if (state === "halted") {
        this.clearPendingRestart(agentName, channelType, chatId);
        await registry.sendText(channelType, accountId, chatId, `\ud83d\uded1 Agent halted after too many crashes. Use /restart to try again.`);
      }
    });
  }

  /**
   * Wire an agent-mail conversation process.
   * Responses are buffered and routed back to the sender, not to any channel.
   */
  private wireAgentMailProcess(agentName: string, process: AgentProcess): void {
    // Buffer response text blocks (instead of sending to a channel)
    process.on("response", (text) => {
      let buffer = this.agentMailResponseBuffer.get(agentName);
      if (!buffer) {
        buffer = [];
        this.agentMailResponseBuffer.set(agentName, buffer);
      }
      buffer.push(text);
    });

    process.on("stateChange", (state) => {
      if (state === "idle") {
        // Flush buffered response as a reply to the sender
        this.flushAgentMailResponse(agentName);

        // Post-turn restart (see wireUserProcess for rationale).
        if (this.consumePendingRestart(agentName, INTERNAL_CHANNEL_TYPE, AGENT_MAIL_CHAT_ID, process)) {
          return;
        }

        // Drain next queued message (same pattern as user conversations)
        this.drainQueue(agentName, INTERNAL_CHANNEL_TYPE, AGENT_MAIL_CHAT_ID, agentName, process).catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          this.log.error(`[${agentName}:agent-mail] drain failed: ${message}`);
        });
      }

      if (state === "crashed") {
        this.log.warn(`[${agentName}:${INTERNAL_CHANNEL_TYPE}:${AGENT_MAIL_CHAT_ID}] Agent-mail process crashed — restarting...`);
        this.clearPendingRestart(agentName, INTERNAL_CHANNEL_TYPE, AGENT_MAIL_CHAT_ID);
        // Clear any pending reply-to (response is lost)
        this.agentMailReplyTo.delete(agentName);
        this.agentMailResponseBuffer.delete(agentName);
      } else if (state === "halted") {
        this.log.error(`[${agentName}:${INTERNAL_CHANNEL_TYPE}:${AGENT_MAIL_CHAT_ID}] Agent-mail process halted`);
        this.clearPendingRestart(agentName, INTERNAL_CHANNEL_TYPE, AGENT_MAIL_CHAT_ID);
        this.agentMailReplyTo.delete(agentName);
        this.agentMailResponseBuffer.delete(agentName);
      }
    });
  }

  /**
   * Flush the buffered agent-mail response and deliver it back to the sender.
   */
  private flushAgentMailResponse(agentName: string): void {
    const replyTo = this.agentMailReplyTo.get(agentName);
    const buffer = this.agentMailResponseBuffer.get(agentName);

    // Clean up state regardless
    this.agentMailReplyTo.delete(agentName);
    this.agentMailResponseBuffer.delete(agentName);

    if (!replyTo || !buffer || buffer.length === 0) return;

    const responseText = buffer.join("\n\n");
    const wrappedReply =
      `${agentName} replied to your earlier question:\n\n` +
      `${responseText}\n\n` +
      `Communicate this to the user naturally in your own voice. Do not quote it as a block or use "From ${agentName}:" headers.`;

    this.log.info(`[${agentName}] Routing agent-mail reply back to ${replyTo.senderAgent}:${replyTo.senderChatId}`);

    this.hooks?.emit("message:reply", {
      inReplyTo: replyTo.messageId,
      from: agentName,
      to: replyTo.senderAgent,
      content: responseText,
      repliedAt: new Date().toISOString(),
    });

    // Route back to the sender's original conversation using the channel they sent from.
    // Fire-and-forget — we're inside an event handler and nothing awaits us.
    // Surface any failure rather than silently swallowing it.
    this.sendOrQueue(replyTo.senderAgent, replyTo.senderChannelType, replyTo.senderChatId, wrappedReply)
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        this.log.error(`Failed to route agent-mail reply from ${agentName} to ${replyTo.senderAgent}: ${message}`);
      });
  }

  /**
   * Consume any pending post-turn restart for this conversation.
   *
   * Called at the start of an idle transition, before drain. If a restart
   * was scheduled (typically by `rondel_reload_skills` during the just-
   * completed turn), clear the flag, restart the process, and return
   * true so the caller skips the drain — the fresh process will fire its
   * own idle event and drain naturally.
   */
  private consumePendingRestart(
    agentName: string,
    channelType: string,
    chatId: string,
    process: AgentProcess,
  ): boolean {
    const key = conversationKey(agentName, channelType, chatId);
    if (!this.agentManager.conversations.hasPendingRestart(key)) return false;
    this.agentManager.conversations.clearPendingRestart(key);
    this.log.info(`[${agentName}:${channelType}:${chatId}] Firing post-turn restart (skill reload)`);
    // Fire-and-forget: restart() awaits stop()'s exit handshake. The
    // returned promise can't reject today, but logging any future
    // rejection here keeps an unhandled promise from crashing the daemon.
    process.restart().catch((err) => this.log.error(`Post-turn restart failed for ${key}: ${err instanceof Error ? err.message : String(err)}`));
    return true;
  }

  /** Clear any pending post-turn restart (used on crash/halt). */
  private clearPendingRestart(agentName: string, channelType: string, chatId: string): void {
    const key = conversationKey(agentName, channelType, chatId);
    this.agentManager.conversations.clearPendingRestart(key);
  }

  /**
   * Drain the next message from a conversation's queue.
   * Shared by both user and agent-mail conversations.
   *
   * Serialized via `conversationLock` — a concurrent `sendOrQueue` for the
   * same conversation must not start between our shift and our dispatch,
   * or it could see an empty queue and send its own message before ours.
   * (Also future-proofs Step 4's disk-remove step, which must not race
   * with an enqueue writing to the same file.)
   */
  private async drainQueue(agentName: string, channelType: string, chatId: string, accountId: string, process: AgentProcess): Promise<void> {
    const key = conversationKey(agentName, channelType, chatId);
    await this.conversationLock.withLock(key, async () => {
      const queue = this.queues.get(key);
      if (!queue || queue.length === 0) return;

      const next = queue.shift()!;
      if (queue.length === 0) this.queues.delete(key);
      this.log.info(`[${agentName}:${channelType}:${chatId}] Draining queue (${queue.length} remaining)`);

      // Restore reply-to tracking from queued message (for agent-mail)
      if (next.agentMailReplyTo) {
        this.agentMailReplyTo.set(agentName, next.agentMailReplyTo);
      }

      // Start typing indicator for user conversations only
      if (chatId !== AGENT_MAIL_CHAT_ID) {
        const registry = this.agentManager.getChannelRegistry();
        registry.startTypingIndicator(channelType, accountId, chatId);
      }

      process.sendMessage(next.text);

      // Remove from disk AFTER successful dispatch. A crash between
      // dispatch and this await replays the message on recovery — that's
      // the documented at-least-once contract. Loss (crash BEFORE dispatch)
      // would be worse, so never remove-before-dispatch. A failing remove
      // leaves the message on disk; it will replay on next startup.
      try {
        await this.queueStore.removeFirst(key);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.log.error(`[${key}] Failed to remove drained message from disk (will replay on next startup): ${message}`);
      }
    });
  }

  private async handleInboundMessage(msg: ChannelMessage): Promise<void> {
    const text = msg.text.trim();

    const agentName = this.agentManager.resolveAgentByChannel(msg.channelType, msg.accountId);
    if (!agentName) {
      this.log.warn(`No agent for ${msg.channelType}:${msg.accountId} — ignoring`);
      return;
    }

    // System commands
    if (text.startsWith("/")) {
      const handled = await this.handleSystemCommand(text, msg, agentName);
      if (handled) return;
    }

    const registry = this.agentManager.getChannelRegistry();

    // Get or spawn conversation process for this chat
    const process = this.agentManager.getOrSpawnConversation(agentName, msg.channelType, msg.chatId);
    if (!process) {
      await registry.sendText(msg.channelType, msg.accountId, msg.chatId, `Agent "${agentName}" not found.`);
      return;
    }

    // Wire events if this is a new process
    this.wireProcess(agentName, msg.channelType, msg.accountId, msg.chatId, process);

    // Decide the outcome under the per-conversation lock so a concurrent
    // `sendOrQueue` (e.g. a subagent result delivery firing simultaneously)
    // can't observe the same `idle` state and race with our `process.sendMessage`.
    // User-facing channel I/O (queue-full / queued-position messages) happens
    // after the lock is released — holding a lock during network I/O is
    // always the wrong move.
    type Outcome =
      | { kind: "sent" }
      | { kind: "queued"; position: number }
      | { kind: "full" }
      | { kind: "unavailable"; state: string };

    const key = conversationKey(agentName, msg.channelType, msg.chatId);
    const outcome: Outcome = await this.conversationLock.withLock(key, async () => {
      const agentState = process.getState();
      if (agentState === "idle") {
        this.hooks?.emit("conversation:message_in", { agentName, channelType: msg.channelType, chatId: msg.chatId, text, senderId: msg.senderId, senderName: msg.senderName });
        registry.startTypingIndicator(msg.channelType, msg.accountId, msg.chatId);
        process.sendMessage(text, { senderId: msg.senderId, senderName: msg.senderName });
        this.log.info(`[${agentName}:${msg.channelType}:${msg.chatId}] "${text.slice(0, 80)}"`);
        return { kind: "sent" };
      }
      if (agentState === "busy") {
        const queue = this.getQueueForKey(key);
        if (queue.length >= MAX_QUEUE_SIZE) {
          return { kind: "full" };
        }
        this.hooks?.emit("conversation:message_in", { agentName, channelType: msg.channelType, chatId: msg.chatId, text, senderId: msg.senderId, senderName: msg.senderName });
        await this.enqueue({
          agentName,
          channelType: msg.channelType,
          accountId: msg.accountId,
          chatId: msg.chatId,
          text,
          queuedAt: Date.now(),
        }, agentState);
        return { kind: "queued", position: queue.length };
      }
      return { kind: "unavailable", state: agentState };
    });

    if (outcome.kind === "full") {
      await registry.sendText(msg.channelType, msg.accountId, msg.chatId, `Queue full (${MAX_QUEUE_SIZE} messages). Try again later.`);
    } else if (outcome.kind === "queued") {
      await registry.sendText(msg.channelType, msg.accountId, msg.chatId, `\u23f3 Agent is busy \u2014 message queued (position ${outcome.position})`);
    } else if (outcome.kind === "unavailable") {
      await registry.sendText(msg.channelType, msg.accountId, msg.chatId, `Agent is ${outcome.state}. Use /restart to restart it.`);
    }
  }

  private async handleSystemCommand(text: string, msg: ChannelMessage, agentName: string): Promise<boolean> {
    const command = text.split(/\s+/)[0];
    const registry = this.agentManager.getChannelRegistry();

    switch (command) {
      case "/status": {
        const process = this.agentManager.getConversation(agentName, msg.channelType, msg.chatId);
        if (!process) {
          await registry.sendText(msg.channelType, msg.accountId, msg.chatId, `*${agentName}*: no active conversation in this chat yet.`);
          return true;
        }
        const state = process.getState();
        const sessionId = process.getSessionId();
        const queueLen = this.getQueue(agentName, msg.channelType, msg.chatId).length;
        const icon = state === "idle" ? "\ud83d\udfe2" : state === "busy" ? "\ud83d\udfe1" : "\ud83d\udd34";
        await registry.sendText(msg.channelType, msg.accountId, msg.chatId, [
          `${icon} *${agentName}*: ${state}`,
          `*Session*: \`${sessionId || "none"}\``,
          `*Queued*: ${queueLen}`,
        ].join("\n"));
        return true;
      }

      case "/restart": {
        const restarted = this.agentManager.restartConversation(agentName, msg.channelType, msg.chatId);
        if (restarted) {
          await this.clearConversationQueue(conversationKey(agentName, msg.channelType, msg.chatId));
          await registry.sendText(msg.channelType, msg.accountId, msg.chatId, `Restarting *${agentName}* in this chat...`);
        } else {
          await registry.sendText(msg.channelType, msg.accountId, msg.chatId, "No active conversation to restart. Send a message to start one.");
        }
        return true;
      }

      case "/stop": {
        const process = this.agentManager.getConversation(agentName, msg.channelType, msg.chatId);
        if (!process) {
          await registry.sendText(msg.channelType, msg.accountId, msg.chatId, "No active conversation.");
          return true;
        }
        if (process.getState() !== "busy") {
          await registry.sendText(msg.channelType, msg.accountId, msg.chatId, "Nothing to stop \u2014 agent is idle.");
          return true;
        }
        // Clear the queue before restarting — any messages that were waiting
        // behind the in-flight turn should be discarded, not drained into
        // the fresh process. /stop means "drop everything, including what's
        // pending."
        await this.clearConversationQueue(conversationKey(agentName, msg.channelType, msg.chatId));
        await registry.sendText(msg.channelType, msg.accountId, msg.chatId, "Stopping current turn and clearing queue...");
        this.agentManager.restartConversation(agentName, msg.channelType, msg.chatId);
        return true;
      }

      case "/new": {
        await this.clearConversationQueue(conversationKey(agentName, msg.channelType, msg.chatId));
        this.agentManager.resetSession(agentName, msg.channelType, msg.chatId);
        await registry.sendText(msg.channelType, msg.accountId, msg.chatId, `Session reset. Send a message to start a fresh conversation with *${agentName}*.`);
        return true;
      }

      case "/help":
        await registry.sendText(msg.channelType, msg.accountId, msg.chatId, [
          "*Rondel Commands*",
          "`/status` \u2014 Show agent state in this chat",
          "`/restart` \u2014 Restart the agent in this chat",
          "`/stop` \u2014 Stop the current turn and clear the queue",
          "`/new` \u2014 Start a fresh session (history preserved on disk)",
          "`/help` \u2014 Show this help",
        ].join("\n"));
        return true;

      case "/start":
        await registry.sendText(msg.channelType, msg.accountId, msg.chatId, `*${agentName}* is ready. Send a message to start a conversation.`);
        return true;

      default:
        return false;
    }
  }
}
