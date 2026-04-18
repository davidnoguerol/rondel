import type {
  ChannelAdapter,
  ChannelCredentials,
  ChannelMessage,
  InteractiveButton,
  InteractiveCallback,
} from "../core/channel.js";
import type { Logger } from "../../shared/logger.js";

const TELEGRAM_API = "https://api.telegram.org/bot";
const POLL_TIMEOUT_S = 30;
const MAX_MESSAGE_LENGTH = 4096;

/** Telegram's typing indicator expires after ~5s. Refresh before expiry. */
const TYPING_REFRESH_MS = 4_000;

/**
 * A single Telegram bot account — manages polling and API calls for one bot token.
 */
class TelegramAccount {
  private offset = 0;
  private polling = false;
  private abortController: AbortController | null = null;
  private readonly baseUrl: string;
  private readonly typingIntervals = new Map<string, ReturnType<typeof setInterval>>();

  constructor(
    readonly accountId: string,
    private readonly botToken: string,
    private readonly allowedUsers: ReadonlySet<string>,
    private readonly onMessage: (msg: ChannelMessage) => void,
    private readonly onInteractiveCallback: (cb: InteractiveCallback) => void,
    private readonly log: Logger,
  ) {
    this.baseUrl = `${TELEGRAM_API}${botToken}`;
  }

  startPolling(): void {
    if (this.polling) return;
    this.polling = true;
    this.log.info(`[${this.accountId}] Starting Telegram polling...`);
    this.pollLoop();
  }

  stopPolling(): void {
    this.polling = false;
    this.abortController?.abort();
    this.abortController = null;
    // Clear all typing intervals
    for (const interval of this.typingIntervals.values()) {
      clearInterval(interval);
    }
    this.typingIntervals.clear();
    this.log.info(`[${this.accountId}] Stopped Telegram polling`);
  }

  async sendText(chatId: string, text: string): Promise<void> {
    const chunks = chunkMessage(text);
    for (const chunk of chunks) {
      await this.apiCall("sendMessage", {
        chat_id: chatId,
        text: chunk,
        parse_mode: "Markdown",
      });
    }
  }

  /**
   * Send a message with an inline keyboard. Used by the approval flow
   * (Rondel callback_data prefix `rondel_appr_*`). Buttons render in a
   * single row; multi-row support can come later if needed.
   */
  async sendInteractive(chatId: string, text: string, buttons: readonly InteractiveButton[]): Promise<void> {
    const inlineKeyboard = [buttons.map((b) => ({ text: b.label, callback_data: b.callbackData }))];
    await this.apiCall("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: inlineKeyboard },
    });
  }

  /** Edit an existing message's text (used to mark approval cards as resolved). */
  async editMessageText(chatId: string, messageId: number, text: string): Promise<void> {
    await this.apiCall("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
    }).catch((err) => {
      // Best-effort — the card's text edit is cosmetic, not load-bearing.
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn(`[${this.accountId}] editMessageText failed: ${msg}`);
    });
  }

  /** Ack a callback_query so Telegram stops showing the spinner. */
  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    await this.apiCall("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      text,
    }).catch(() => {
      // Silent — ack is a courtesy, Telegram tolerates missing acks.
    });
  }

  /** Begin a typing indicator loop. Idempotent — no-op if already typing. */
  startTyping(chatId: string): void {
    if (this.typingIntervals.has(chatId)) return;

    // Send immediately, then refresh on interval
    this.sendTypingAction(chatId);
    const interval = setInterval(() => this.sendTypingAction(chatId), TYPING_REFRESH_MS);
    this.typingIntervals.set(chatId, interval);
  }

  /** Stop the typing indicator loop. Idempotent. */
  stopTyping(chatId: string): void {
    const interval = this.typingIntervals.get(chatId);
    if (interval) {
      clearInterval(interval);
      this.typingIntervals.delete(chatId);
    }
  }

  /** Fire-and-forget typing action. Errors are logged, never thrown. */
  private sendTypingAction(chatId: string): void {
    this.apiCall("sendChatAction", { chat_id: chatId, action: "typing" }).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn(`[${this.accountId}] Typing indicator failed: ${msg}`);
    });
  }

  private async pollLoop(): Promise<void> {
    while (this.polling) {
      try {
        this.abortController = new AbortController();
        const updates = await this.getUpdates();
        for (const update of updates) {
          this.handleUpdate(update);
        }
      } catch (err) {
        if (!this.polling) break;
        const message = err instanceof Error ? err.message : String(err);
        if (!message.includes("AbortError") && !message.includes("abort")) {
          this.log.error(`[${this.accountId}] Polling error: ${message}`);
        }
        await sleep(2_000);
      }
    }
  }

  private async getUpdates(): Promise<TelegramUpdate[]> {
    const body = {
      offset: this.offset,
      timeout: POLL_TIMEOUT_S,
      allowed_updates: ["message", "callback_query"],
    };

    const response = await fetch(`${this.baseUrl}/getUpdates`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: this.abortController?.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Telegram API error ${response.status}: ${text}`);
    }

    const data = (await response.json()) as TelegramResponse<TelegramUpdate[]>;
    if (!data.ok || !data.result) {
      throw new Error(`Telegram API returned ok=false: ${JSON.stringify(data)}`);
    }

    return data.result;
  }

  private handleUpdate(update: TelegramUpdate): void {
    this.offset = update.update_id + 1;

    // --- Callback query (button taps) ---
    // Handled before `message` because a single update can only carry
    // one of them, and routing is simpler with explicit early branches.
    if (update.callback_query) {
      const cb = update.callback_query;
      const senderId = cb.from ? String(cb.from.id) : "";
      if (!senderId || !this.allowedUsers.has(senderId)) {
        this.log.warn(`[${this.accountId}] Rejected callback_query from unauthorized user: ${senderId || "unknown"}`);
        return;
      }
      const chatId = cb.message?.chat?.id;
      if (chatId === undefined) {
        // Telegram can in theory send callback queries for inline-mode
        // messages without a chat context. We don't use inline mode —
        // skip and move on.
        return;
      }
      this.onInteractiveCallback({
        channelType: "telegram",
        accountId: this.accountId,
        chatId: String(chatId),
        senderId,
        callbackData: cb.data ?? "",
        messageId: cb.message?.message_id,
        callbackQueryId: cb.id,
      });
      return;
    }

    // --- Regular text message ---
    const msg = update.message;
    if (!msg?.text || !msg.from) return;

    const senderId = String(msg.from.id);

    if (!this.allowedUsers.has(senderId)) {
      this.log.warn(`[${this.accountId}] Rejected message from unauthorized user: ${senderId}`);
      return;
    }

    this.onMessage({
      channelType: "telegram",
      accountId: this.accountId,
      chatId: String(msg.chat.id),
      senderId,
      senderName: msg.from.first_name ?? msg.from.username ?? "Unknown",
      text: msg.text,
      messageId: msg.message_id,
    });
  }

  private async apiCall(method: string, params: Record<string, unknown>): Promise<unknown> {
    const response = await fetch(`${this.baseUrl}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });

    if (!response.ok) {
      const text = await response.text();
      if (response.status === 400 && text.includes("can't parse entities") && params.parse_mode) {
        this.log.warn(`[${this.accountId}] Markdown parse failed — retrying as plain text`);
        const { parse_mode: _, ...plainParams } = params;
        return this.apiCall(method, plainParams);
      }
      throw new Error(`Telegram ${method} error ${response.status}: ${text}`);
    }

    const data = (await response.json()) as TelegramResponse<unknown>;
    return data.result;
  }
}

/**
 * Telegram channel adapter.
 * Manages multiple bot accounts, each polling independently.
 * Implements the ChannelAdapter interface.
 */
export class TelegramAdapter implements ChannelAdapter {
  readonly id = "telegram";
  readonly supportsInteractive = true;
  private readonly accounts = new Map<string, TelegramAccount>();
  private readonly messageHandlers: ((msg: ChannelMessage) => void)[] = [];
  private readonly interactiveCallbackHandlers: ((cb: InteractiveCallback) => void)[] = [];
  private readonly allowedUsers: ReadonlySet<string>;
  private readonly log: Logger;

  constructor(allowedUsers: readonly string[], log: Logger) {
    this.allowedUsers = new Set(allowedUsers);
    this.log = log.child("telegram");
  }

  addAccount(accountId: string, credentials: ChannelCredentials): void {
    if (!credentials.primary) {
      throw new Error(`Telegram account "${accountId}": empty credential (bot token)`);
    }

    if (this.accounts.has(accountId)) {
      throw new Error(`Telegram account "${accountId}" already registered`);
    }

    const account = new TelegramAccount(
      accountId,
      credentials.primary,
      this.allowedUsers,
      (msg) => this.dispatchMessage(msg),
      (cb) => this.dispatchInteractiveCallback(cb),
      this.log,
    );

    this.accounts.set(accountId, account);
    this.log.info(`Registered account: ${accountId}`);
  }

  /** Start polling for a single account (used for hot-adding agents at runtime). */
  startAccount(accountId: string): void {
    const account = this.accounts.get(accountId);
    if (!account) throw new Error(`Cannot start unknown Telegram account: ${accountId}`);
    account.startPolling();
  }

  /** Stop polling and remove a single account (used for hot-removing agents at runtime). */
  removeAccount(accountId: string): void {
    const account = this.accounts.get(accountId);
    if (!account) return;
    account.stopPolling();
    this.accounts.delete(accountId);
    this.log.info(`Removed account: ${accountId}`);
  }

  start(): void {
    for (const account of this.accounts.values()) {
      account.startPolling();
    }
  }

  stop(): void {
    for (const account of this.accounts.values()) {
      account.stopPolling();
    }
  }

  onMessage(handler: (msg: ChannelMessage) => void): void {
    this.messageHandlers.push(handler);
  }

  onInteractiveCallback(handler: (cb: InteractiveCallback) => void): void {
    this.interactiveCallbackHandlers.push(handler);
  }

  async sendText(accountId: string, chatId: string, text: string): Promise<void> {
    const account = this.accounts.get(accountId);
    if (!account) throw new Error(`Unknown Telegram account: ${accountId}`);
    await account.sendText(chatId, text);
  }

  async sendInteractive(
    accountId: string,
    chatId: string,
    text: string,
    buttons: readonly InteractiveButton[],
  ): Promise<void> {
    const account = this.accounts.get(accountId);
    if (!account) throw new Error(`Unknown Telegram account: ${accountId}`);
    await account.sendInteractive(chatId, text, buttons);
  }

  /**
   * Edit an existing approval-card message (used by the approval-callback
   * handler to mark the card as resolved after the user taps a button).
   */
  async editMessageText(accountId: string, chatId: string, messageId: number, text: string): Promise<void> {
    const account = this.accounts.get(accountId);
    if (!account) return;
    await account.editMessageText(chatId, messageId, text);
  }

  /** Ack a callback_query. Best-effort, never throws. */
  async answerCallbackQuery(accountId: string, callbackQueryId: string, text?: string): Promise<void> {
    const account = this.accounts.get(accountId);
    if (!account) return;
    await account.answerCallbackQuery(callbackQueryId, text);
  }

  startTypingIndicator(accountId: string, chatId: string): void {
    const account = this.accounts.get(accountId);
    if (!account) return; // silent no-op for unknown accounts
    account.startTyping(chatId);
  }

  stopTypingIndicator(accountId: string, chatId: string): void {
    const account = this.accounts.get(accountId);
    if (!account) return;
    account.stopTyping(chatId);
  }

  private dispatchMessage(msg: ChannelMessage): void {
    for (const handler of this.messageHandlers) {
      handler(msg);
    }
  }

  private dispatchInteractiveCallback(cb: InteractiveCallback): void {
    for (const handler of this.interactiveCallbackHandlers) {
      try {
        handler(cb);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log.error(`Interactive callback handler threw: ${msg}`);
      }
    }
  }
}

// --- Helpers ---

function chunkMessage(text: string): string[] {
  if (text.length <= MAX_MESSAGE_LENGTH) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= MAX_MESSAGE_LENGTH) {
      chunks.push(remaining);
      break;
    }

    let breakPoint = remaining.lastIndexOf("\n", MAX_MESSAGE_LENGTH);
    if (breakPoint < MAX_MESSAGE_LENGTH * 0.5) {
      breakPoint = remaining.lastIndexOf(" ", MAX_MESSAGE_LENGTH);
    }
    if (breakPoint < MAX_MESSAGE_LENGTH * 0.5) {
      breakPoint = MAX_MESSAGE_LENGTH;
    }

    chunks.push(remaining.slice(0, breakPoint));
    remaining = remaining.slice(breakPoint).trimStart();
  }

  return chunks;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Telegram API types ---

interface TelegramResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from?: {
      id: number;
      first_name?: string;
      username?: string;
    };
    chat: {
      id: number;
    };
    text?: string;
  };
  callback_query?: {
    id: string;
    from?: {
      id: number;
      first_name?: string;
      username?: string;
    };
    message?: {
      message_id: number;
      chat: { id: number };
    };
    data?: string;
  };
}
