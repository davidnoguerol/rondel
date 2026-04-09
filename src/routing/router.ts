import type { AgentManager } from "../agents/agent-manager.js";
import type { AgentProcess } from "../agents/agent-process.js";
import type { ChannelMessage } from "../channels/channel.js";
import type { QueuedMessage, ConversationKey, AgentMailReplyTo } from "../shared/types/index.js";
import { conversationKey, AGENT_MAIL_CHAT_ID, INTERNAL_CHANNEL_TYPE } from "../shared/types/index.js";
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
    const registry = this.agentManager.getChannelRegistry();
    registry.onMessage((msg) => this.handleInboundMessage(msg));
    this.log.info("Router started");
  }

  /**
   * Send a message to a conversation, respecting busy state.
   * If the agent is idle, sends immediately. If busy, queues for delivery
   * when the agent becomes idle. Used by hook listeners for subagent result
   * delivery, inter-agent message delivery, and any other internal injection.
   */
  sendOrQueue(agentName: string, channelType: string, chatId: string, text: string, replyTo?: AgentMailReplyTo): void {
    const process = this.agentManager.getConversation(agentName, channelType, chatId);
    if (!process) {
      this.log.warn(`sendOrQueue: no conversation for ${agentName}:${channelType}:${chatId}`);
      return;
    }

    // Ensure process is wired so queue drain works
    const accountId = this.agentManager.getAccountForAgent(agentName) ?? agentName;
    this.wireProcess(agentName, channelType, accountId, chatId, process);

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
      const queue = this.getQueue(agentName, channelType, chatId);
      if (queue.length >= MAX_QUEUE_SIZE) {
        this.log.warn(`[${agentName}:${channelType}:${chatId}] Queue full (${MAX_QUEUE_SIZE}) — internal message dropped`);
        return;
      }
      queue.push({ agentName, channelType, accountId, chatId, text, queuedAt: Date.now(), agentMailReplyTo: replyTo });
      this.log.info(`[${agentName}:${channelType}:${chatId}] Message queued (agent is ${state}, queue size: ${queue.length})`);
    }
  }

  /**
   * Deliver an inter-agent message to the recipient's agent-mail conversation.
   * Spawns the agent-mail process if it doesn't exist yet.
   */
  deliverAgentMail(agentName: string, text: string, replyTo: AgentMailReplyTo): void {
    // Ensure the agent-mail conversation process exists (lazy spawn)
    const process = this.agentManager.getOrSpawnConversation(agentName, INTERNAL_CHANNEL_TYPE, AGENT_MAIL_CHAT_ID);
    if (!process) {
      this.log.error(`deliverAgentMail: failed to spawn agent-mail for ${agentName}`);
      return;
    }

    // Wire with agent-mail-specific handlers (idempotent)
    const accountId = this.agentManager.getAccountForAgent(agentName) ?? agentName;
    this.wireProcess(agentName, INTERNAL_CHANNEL_TYPE, accountId, AGENT_MAIL_CHAT_ID, process);

    // Deliver via sendOrQueue (respects busy state)
    this.sendOrQueue(agentName, INTERNAL_CHANNEL_TYPE, AGENT_MAIL_CHAT_ID, text, replyTo);
  }

  private getQueue(agentName: string, channelType: string, chatId: string): QueuedMessage[] {
    const key = conversationKey(agentName, channelType, chatId);
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

    process.on("response", async (text) => {
      this.hooks?.emit("conversation:response", { agentName, chatId, text });
      try {
        await registry.sendText(channelType, accountId, chatId, text);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.log.error(`[${agentName}:${channelType}:${chatId}] Failed to send response: ${message}`);
      }
    });

    process.on("stateChange", async (state) => {
      // Stop typing whenever agent is no longer busy
      if (state !== "busy") {
        registry.stopTypingIndicator(channelType, accountId, chatId);
      }

      if (state === "idle") {
        this.drainQueue(agentName, channelType, chatId, accountId, process);
      }

      if (state === "crashed") {
        await registry.sendText(channelType, accountId, chatId, `\u26a0\ufe0f Agent crashed \u2014 restarting...`);
      } else if (state === "halted") {
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

        // Drain next queued message (same pattern as user conversations)
        this.drainQueue(agentName, INTERNAL_CHANNEL_TYPE, AGENT_MAIL_CHAT_ID, agentName, process);
      }

      if (state === "crashed") {
        this.log.warn(`[${agentName}:${INTERNAL_CHANNEL_TYPE}:${AGENT_MAIL_CHAT_ID}] Agent-mail process crashed — restarting...`);
        // Clear any pending reply-to (response is lost)
        this.agentMailReplyTo.delete(agentName);
        this.agentMailResponseBuffer.delete(agentName);
      } else if (state === "halted") {
        this.log.error(`[${agentName}:${INTERNAL_CHANNEL_TYPE}:${AGENT_MAIL_CHAT_ID}] Agent-mail process halted`);
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

    // Route back to the sender's original conversation
    // We need the sender's channelType — resolve from their primary channel
    const senderPrimary = this.agentManager.getPrimaryChannel(replyTo.senderAgent);
    const senderChannelType = senderPrimary?.channelType ?? "telegram";
    this.sendOrQueue(replyTo.senderAgent, senderChannelType, replyTo.senderChatId, wrappedReply);
  }

  /**
   * Drain the next message from a conversation's queue.
   * Shared by both user and agent-mail conversations.
   */
  private drainQueue(agentName: string, channelType: string, chatId: string, accountId: string, process: AgentProcess): void {
    const key = conversationKey(agentName, channelType, chatId);
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

    const agentState = process.getState();

    if (agentState === "idle") {
      this.hooks?.emit("conversation:message_in", { agentName, chatId: msg.chatId, text, senderId: msg.senderId, senderName: msg.senderName });
      registry.startTypingIndicator(msg.channelType, msg.accountId, msg.chatId);
      process.sendMessage(text, { senderId: msg.senderId, senderName: msg.senderName });
      this.log.info(`[${agentName}:${msg.channelType}:${msg.chatId}] "${text.slice(0, 80)}"`);
    } else if (agentState === "busy") {
      const queue = this.getQueue(agentName, msg.channelType, msg.chatId);
      if (queue.length >= MAX_QUEUE_SIZE) {
        await registry.sendText(msg.channelType, msg.accountId, msg.chatId, `Queue full (${MAX_QUEUE_SIZE} messages). Try again later.`);
        return;
      }
      this.hooks?.emit("conversation:message_in", { agentName, chatId: msg.chatId, text, senderId: msg.senderId, senderName: msg.senderName });
      queue.push({
        agentName,
        channelType: msg.channelType,
        accountId: msg.accountId,
        chatId: msg.chatId,
        text,
        queuedAt: Date.now(),
      });
      await registry.sendText(msg.channelType, msg.accountId, msg.chatId, `\u23f3 Agent is busy \u2014 message queued (position ${queue.length})`);
    } else {
      await registry.sendText(msg.channelType, msg.accountId, msg.chatId, `Agent is ${agentState}. Use /restart to restart it.`);
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
          this.queues.delete(conversationKey(agentName, msg.channelType, msg.chatId));
          await registry.sendText(msg.channelType, msg.accountId, msg.chatId, `Restarting *${agentName}* in this chat...`);
        } else {
          await registry.sendText(msg.channelType, msg.accountId, msg.chatId, "No active conversation to restart. Send a message to start one.");
        }
        return true;
      }

      case "/cancel": {
        const process = this.agentManager.getConversation(agentName, msg.channelType, msg.chatId);
        if (!process) {
          await registry.sendText(msg.channelType, msg.accountId, msg.chatId, "No active conversation.");
          return true;
        }
        if (process.getState() === "busy") {
          await registry.sendText(msg.channelType, msg.accountId, msg.chatId, "Cancelling current turn and restarting...");
          this.agentManager.restartConversation(agentName, msg.channelType, msg.chatId);
        } else {
          await registry.sendText(msg.channelType, msg.accountId, msg.chatId, "Agent is not currently busy.");
        }
        return true;
      }

      case "/new": {
        this.queues.delete(conversationKey(agentName, msg.channelType, msg.chatId));
        this.agentManager.resetSession(agentName, msg.channelType, msg.chatId);
        await registry.sendText(msg.channelType, msg.accountId, msg.chatId, `Session reset. Send a message to start a fresh conversation with *${agentName}*.`);
        return true;
      }

      case "/help":
        await registry.sendText(msg.channelType, msg.accountId, msg.chatId, [
          "*Rondel Commands*",
          "`/status` \u2014 Show agent state in this chat",
          "`/restart` \u2014 Restart the agent in this chat",
          "`/cancel` \u2014 Cancel current turn",
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
