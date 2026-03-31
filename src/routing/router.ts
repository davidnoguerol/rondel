import type { AgentManager } from "../agents/agent-manager.js";
import type { AgentProcess } from "../agents/agent-process.js";
import type { ChannelMessage } from "../channels/channel.js";
import type { QueuedMessage, ConversationKey, AgentMailReplyTo } from "../shared/types/index.js";
import { conversationKey, AGENT_MAIL_CHAT_ID } from "../shared/types/index.js";
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
 * Each unique (agent, chatId) pair gets its own Claude process.
 * First message to a new chat spawns the process.
 * Responses route back through the originating account + chat.
 *
 * Also handles inter-agent messaging via the "agent-mail" conversation:
 * messages from other agents are delivered to a synthetic conversation,
 * and responses are automatically routed back to the sender.
 */
export class Router {
  private readonly queues = new Map<ConversationKey, QueuedMessage[]>(); // conversationKey → queue
  private readonly wiredProcesses = new Set<AgentProcess>();     // track which processes we've wired
  private readonly log: Logger;

  // --- Inter-agent messaging state ---
  /** Reply-to info for the currently-processing agent-mail message, keyed by agent name. */
  private readonly agentMailReplyTo = new Map<string, AgentMailReplyTo>();
  /** Buffered response text from agent-mail processes, keyed by agent name. */
  private readonly agentMailResponseBuffer = new Map<string, string[]>();

  constructor(
    private readonly agentManager: AgentManager,
    log: Logger,
    private readonly hooks?: RondelHooks,
  ) {
    this.log = log.child("router");
  }

  /** Start listening for channel messages. */
  start(): void {
    const telegram = this.agentManager.getTelegram();
    telegram.onMessage((msg) => this.handleInboundMessage(msg));
    this.log.info("Router started");
  }

  /**
   * Send a message to a conversation, respecting busy state.
   * If the agent is idle, sends immediately. If busy, queues for delivery
   * when the agent becomes idle. Used by hook listeners for subagent result
   * delivery, inter-agent message delivery, and any other internal injection.
   */
  sendOrQueue(agentName: string, chatId: string, text: string, replyTo?: AgentMailReplyTo): void {
    const process = this.agentManager.getConversation(agentName, chatId);
    if (!process) {
      this.log.warn(`sendOrQueue: no conversation for ${agentName}:${chatId}`);
      return;
    }

    // Ensure process is wired so queue drain works
    const accountId = this.agentManager.getAccountForAgent(agentName) ?? agentName;
    this.wireProcess(agentName, accountId, chatId, process);

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
        const telegram = this.agentManager.getTelegram();
        telegram.startTypingIndicator(accountId, chatId);
      }
      process.sendMessage(text);
    } else {
      const queue = this.getQueue(agentName, chatId);
      if (queue.length >= MAX_QUEUE_SIZE) {
        this.log.warn(`[${agentName}:${chatId}] Queue full (${MAX_QUEUE_SIZE}) — internal message dropped`);
        return;
      }
      queue.push({ agentName, accountId, chatId, text, queuedAt: Date.now(), agentMailReplyTo: replyTo });
      this.log.info(`[${agentName}:${chatId}] Message queued (agent is ${state}, queue size: ${queue.length})`);
    }
  }

  /**
   * Deliver an inter-agent message to the recipient's agent-mail conversation.
   * Spawns the agent-mail process if it doesn't exist yet.
   */
  deliverAgentMail(agentName: string, text: string, replyTo: AgentMailReplyTo): void {
    // Ensure the agent-mail conversation process exists (lazy spawn)
    const process = this.agentManager.getOrSpawnConversation(agentName, AGENT_MAIL_CHAT_ID);
    if (!process) {
      this.log.error(`deliverAgentMail: failed to spawn agent-mail for ${agentName}`);
      return;
    }

    // Wire with agent-mail-specific handlers (idempotent)
    const accountId = this.agentManager.getAccountForAgent(agentName) ?? agentName;
    this.wireProcess(agentName, accountId, AGENT_MAIL_CHAT_ID, process);

    // Deliver via sendOrQueue (respects busy state)
    this.sendOrQueue(agentName, AGENT_MAIL_CHAT_ID, text, replyTo);
  }

  private getQueue(agentName: string, chatId: string): QueuedMessage[] {
    const key = conversationKey(agentName, chatId);
    let queue = this.queues.get(key);
    if (!queue) {
      queue = [];
      this.queues.set(key, queue);
    }
    return queue;
  }

  /**
   * Wire response and state events for a conversation process.
   * Called once per process — tracked via wiredProcesses set.
   *
   * For agent-mail conversations (chatId === AGENT_MAIL_CHAT_ID), installs
   * different handlers: responses are buffered and routed back to the sender
   * instead of going to Telegram.
   */
  private wireProcess(agentName: string, accountId: string, chatId: string, process: AgentProcess): void {
    if (this.wiredProcesses.has(process)) return;
    this.wiredProcesses.add(process);

    if (chatId === AGENT_MAIL_CHAT_ID) {
      this.wireAgentMailProcess(agentName, process);
    } else {
      this.wireUserProcess(agentName, accountId, chatId, process);
    }
  }

  /**
   * Wire a user-facing conversation process (sends responses to Telegram).
   */
  private wireUserProcess(agentName: string, accountId: string, chatId: string, process: AgentProcess): void {
    const telegram = this.agentManager.getTelegram();

    process.on("response", async (text) => {
      try {
        await telegram.sendText(accountId, chatId, text);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.log.error(`[${agentName}:${chatId}] Failed to send response: ${message}`);
      }
    });

    process.on("stateChange", async (state) => {
      // Stop typing whenever agent is no longer busy
      if (state !== "busy") {
        telegram.stopTypingIndicator(accountId, chatId);
      }

      if (state === "idle") {
        this.drainQueue(agentName, chatId, accountId, process);
      }

      if (state === "crashed") {
        await telegram.sendText(accountId, chatId, `\u26a0\ufe0f Agent crashed \u2014 restarting...`);
      } else if (state === "halted") {
        await telegram.sendText(accountId, chatId, `\ud83d\uded1 Agent halted after too many crashes. Use /restart to try again.`);
      }
    });
  }

  /**
   * Wire an agent-mail conversation process.
   * Responses are buffered and routed back to the sender, not to Telegram.
   */
  private wireAgentMailProcess(agentName: string, process: AgentProcess): void {
    // Buffer response text blocks (instead of sending to Telegram)
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

        // Drain next queued message (same pattern as user conversations)
        this.drainQueue(agentName, AGENT_MAIL_CHAT_ID, agentName, process);
      }

      if (state === "crashed") {
        this.log.warn(`[${agentName}:${AGENT_MAIL_CHAT_ID}] Agent-mail process crashed — restarting...`);
        // Clear any pending reply-to (response is lost)
        this.agentMailReplyTo.delete(agentName);
        this.agentMailResponseBuffer.delete(agentName);
      } else if (state === "halted") {
        this.log.error(`[${agentName}:${AGENT_MAIL_CHAT_ID}] Agent-mail process halted`);
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

    this.sendOrQueue(replyTo.senderAgent, replyTo.senderChatId, wrappedReply);
  }

  /**
   * Drain the next message from a conversation's queue.
   * Shared by both user and agent-mail conversations.
   */
  private drainQueue(agentName: string, chatId: string, accountId: string, process: AgentProcess): void {
    const key = conversationKey(agentName, chatId);
    const queue = this.queues.get(key);
    if (!queue || queue.length === 0) return;

    const next = queue.shift()!;
    if (queue.length === 0) this.queues.delete(key);
    this.log.info(`[${agentName}:${chatId}] Draining queue (${queue.length} remaining)`);

    // Restore reply-to tracking from queued message (for agent-mail)
    if (next.agentMailReplyTo) {
      this.agentMailReplyTo.set(agentName, next.agentMailReplyTo);
    }

    // Start typing indicator for user conversations only
    if (chatId !== AGENT_MAIL_CHAT_ID) {
      const telegram = this.agentManager.getTelegram();
      telegram.startTypingIndicator(accountId, chatId);
    }

    process.sendMessage(next.text);
  }

  private async handleInboundMessage(msg: ChannelMessage): Promise<void> {
    const text = msg.text.trim();

    const agentName = this.agentManager.resolveAgentByAccount(msg.accountId);
    if (!agentName) {
      this.log.warn(`No agent for account ${msg.accountId} — ignoring`);
      return;
    }

    // System commands
    if (text.startsWith("/")) {
      const handled = await this.handleSystemCommand(text, msg, agentName);
      if (handled) return;
    }

    const telegram = this.agentManager.getTelegram();

    // Get or spawn conversation process for this chat
    const process = this.agentManager.getOrSpawnConversation(agentName, msg.chatId);
    if (!process) {
      await telegram.sendText(msg.accountId, msg.chatId, `Agent "${agentName}" not found.`);
      return;
    }

    // Wire events if this is a new process
    this.wireProcess(agentName, msg.accountId, msg.chatId, process);

    const agentState = process.getState();

    if (agentState === "idle") {
      telegram.startTypingIndicator(msg.accountId, msg.chatId);
      process.sendMessage(text, { senderId: msg.senderId, senderName: msg.senderName });
      this.log.info(`[${agentName}:${msg.chatId}] "${text.slice(0, 80)}"`);
    } else if (agentState === "busy") {
      const queue = this.getQueue(agentName, msg.chatId);
      if (queue.length >= MAX_QUEUE_SIZE) {
        await telegram.sendText(msg.accountId, msg.chatId, `Queue full (${MAX_QUEUE_SIZE} messages). Try again later.`);
        return;
      }
      queue.push({
        agentName,
        accountId: msg.accountId,
        chatId: msg.chatId,
        text,
        queuedAt: Date.now(),
      });
      await telegram.sendText(msg.accountId, msg.chatId, `\u23f3 Agent is busy \u2014 message queued (position ${queue.length})`);
    } else {
      await telegram.sendText(msg.accountId, msg.chatId, `Agent is ${agentState}. Use /restart to restart it.`);
    }
  }

  private async handleSystemCommand(text: string, msg: ChannelMessage, agentName: string): Promise<boolean> {
    const command = text.split(/\s+/)[0];
    const telegram = this.agentManager.getTelegram();

    switch (command) {
      case "/status": {
        const process = this.agentManager.getConversation(agentName, msg.chatId);
        if (!process) {
          await telegram.sendText(msg.accountId, msg.chatId, `*${agentName}*: no active conversation in this chat yet.`);
          return true;
        }
        const state = process.getState();
        const sessionId = process.getSessionId();
        const queueLen = this.getQueue(agentName, msg.chatId).length;
        const icon = state === "idle" ? "\ud83d\udfe2" : state === "busy" ? "\ud83d\udfe1" : "\ud83d\udd34";
        await telegram.sendText(msg.accountId, msg.chatId, [
          `${icon} *${agentName}*: ${state}`,
          `*Session*: \`${sessionId || "none"}\``,
          `*Queued*: ${queueLen}`,
        ].join("\n"));
        return true;
      }

      case "/restart": {
        const restarted = this.agentManager.restartConversation(agentName, msg.chatId);
        if (restarted) {
          this.queues.delete(conversationKey(agentName, msg.chatId));
          await telegram.sendText(msg.accountId, msg.chatId, `Restarting *${agentName}* in this chat...`);
        } else {
          await telegram.sendText(msg.accountId, msg.chatId, "No active conversation to restart. Send a message to start one.");
        }
        return true;
      }

      case "/cancel": {
        const process = this.agentManager.getConversation(agentName, msg.chatId);
        if (!process) {
          await telegram.sendText(msg.accountId, msg.chatId, "No active conversation.");
          return true;
        }
        if (process.getState() === "busy") {
          await telegram.sendText(msg.accountId, msg.chatId, "Cancelling current turn and restarting...");
          this.agentManager.restartConversation(agentName, msg.chatId);
        } else {
          await telegram.sendText(msg.accountId, msg.chatId, "Agent is not currently busy.");
        }
        return true;
      }

      case "/new": {
        this.queues.delete(conversationKey(agentName, msg.chatId));
        this.agentManager.resetSession(agentName, msg.chatId);
        await telegram.sendText(msg.accountId, msg.chatId, `Session reset. Send a message to start a fresh conversation with *${agentName}*.`);
        return true;
      }

      case "/help":
        await telegram.sendText(msg.accountId, msg.chatId, [
          "*Rondel Commands*",
          "`/status` \u2014 Show agent state in this chat",
          "`/restart` \u2014 Restart the agent in this chat",
          "`/cancel` \u2014 Cancel current turn",
          "`/new` \u2014 Start a fresh session (history preserved on disk)",
          "`/help` \u2014 Show this help",
        ].join("\n"));
        return true;

      case "/start":
        await telegram.sendText(msg.accountId, msg.chatId, `*${agentName}* is ready. Send a message to start a conversation.`);
        return true;

      default:
        return false;
    }
  }
}
