import type { AgentManager } from "../agents/agent-manager.js";
import type { AgentProcess } from "../agents/agent-process.js";
import type { ChannelMessage } from "../channels/channel.js";
import type { QueuedMessage, ConversationKey } from "../shared/types/index.js";
import { conversationKey } from "../shared/types/index.js";
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
 */
export class Router {
  private readonly queues = new Map<ConversationKey, QueuedMessage[]>(); // conversationKey → queue
  private readonly wiredProcesses = new Set<AgentProcess>();     // track which processes we've wired
  private readonly log: Logger;

  constructor(
    private readonly agentManager: AgentManager,
    log: Logger,
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
   * delivery and any other internal message injection.
   */
  sendOrQueue(agentName: string, chatId: string, text: string): void {
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
      process.sendMessage(text);
    } else {
      const queue = this.getQueue(agentName, chatId);
      if (queue.length >= MAX_QUEUE_SIZE) {
        this.log.warn(`[${agentName}:${chatId}] Queue full (${MAX_QUEUE_SIZE}) — internal message dropped`);
        return;
      }
      queue.push({ agentName, accountId, chatId, text, queuedAt: Date.now() });
      this.log.info(`[${agentName}:${chatId}] Message queued (agent is ${state}, queue size: ${queue.length})`);
    }
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
   */
  private wireProcess(agentName: string, accountId: string, chatId: string, process: AgentProcess): void {
    if (this.wiredProcesses.has(process)) return;
    this.wiredProcesses.add(process);

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
        const key = conversationKey(agentName, chatId);
        const queue = this.queues.get(key);
        if (queue && queue.length > 0) {
          const next = queue.shift()!;
          if (queue.length === 0) this.queues.delete(key);
          this.log.info(`[${agentName}:${chatId}] Draining queue (${queue.length} remaining)`);
          telegram.startTypingIndicator(accountId, chatId);
          process.sendMessage(next.text);
        }
      }

      if (state === "crashed") {
        await telegram.sendText(accountId, chatId, `\u26a0\ufe0f Agent crashed \u2014 restarting...`);
      } else if (state === "halted") {
        await telegram.sendText(accountId, chatId, `\ud83d\uded1 Agent halted after too many crashes. Use /restart to try again.`);
      }
    });
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
