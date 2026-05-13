import type {
  ChannelAdapter,
  ChannelCredentials,
  ChannelMessage,
  InteractiveButton,
  InteractiveCallback,
} from "../core/channel.js";
import type { AttachmentService, TelegramIngestInput } from "../../attachments/index.js";
import type { ChannelAttachment } from "../../shared/types/attachments.js";
import { AsyncLock } from "../../shared/async-lock.js";
import type { Logger } from "../../shared/logger.js";

const TELEGRAM_API = "https://api.telegram.org/bot";
const POLL_TIMEOUT_S = 30;
const MAX_MESSAGE_LENGTH = 4096;

/** Telegram's typing indicator expires after ~5s. Refresh before expiry. */
const TYPING_REFRESH_MS = 4_000;

/**
 * Buffer window for media-group albums. Telegram delivers each photo
 * in an album as its own update sharing the same `media_group_id`;
 * holding them for half a second lets the adapter assemble them into
 * one `ChannelMessage` with multiple attachments — same trick OpenClaw
 * uses (`extensions/telegram/src/bot-updates.ts:5`).
 */
const MEDIA_GROUP_FLUSH_MS = 500;

/** State for a single buffered media-group album. */
interface MediaGroupBucket {
  /** First update's parsed message. Carries the chat / sender info we keep. */
  primary: TelegramMessage;
  /** Subsequent siblings (same media_group_id) accumulated before flush. */
  siblings: TelegramMessage[];
  /** Pending flush timer. Reset each time a sibling lands. */
  timer: ReturnType<typeof setTimeout>;
}

/**
 * A single Telegram bot account — manages polling and API calls for one bot token.
 */
class TelegramAccount {
  private offset = 0;
  private polling = false;
  private abortController: AbortController | null = null;
  private readonly baseUrl: string;
  private readonly typingIntervals = new Map<string, ReturnType<typeof setInterval>>();
  /** Media-group buckets keyed by Telegram `media_group_id`. */
  private readonly mediaGroups = new Map<string, MediaGroupBucket>();
  /**
   * Per-chat serial lock. Every `onMessage` invocation for a given
   * chat is serialised so a media message's async download cannot be
   * overtaken by a following text update that arrives in the same
   * `getUpdates` batch. Without this, Telegram's natural update_id
   * ordering can flip at the adapter boundary because the text path is
   * synchronous to `onMessage` while the media path awaits a network
   * download first. The router's own `conversationLock` only sees
   * messages in the order this lock releases them — it cannot recover
   * an ordering that was lost upstream.
   */
  private readonly chatDispatchLock = new AsyncLock();

  constructor(
    readonly accountId: string,
    private readonly botToken: string,
    private readonly allowedUsers: ReadonlySet<string>,
    private readonly onMessage: (msg: ChannelMessage) => void,
    private readonly onInteractiveCallback: (cb: InteractiveCallback) => void,
    private readonly log: Logger,
    /**
     * Channel-wide attachment ingestion service. Optional — when absent
     * the adapter falls back to text-only behavior (drops media
     * updates with a log warning). Wired in by `AgentManager.initialize`
     * at daemon boot.
     */
    private readonly attachmentService: AttachmentService | undefined,
    /**
     * Resolve `accountId → agentName` so staged files land in the
     * agent-keyed subtree the spawned Claude CLI is given via
     * `--add-dir`. Optional with a sensible fallback to `accountId`
     * (Rondel guarantees 1:1 account↔agent for Telegram, so they're
     * usually the same string).
     */
    private readonly resolveAgentName: (accountId: string) => string | undefined,
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
    // Drop any in-flight media-group timers so a stop doesn't leave a
    // pending dispatch queued against a torn-down service.
    for (const bucket of this.mediaGroups.values()) {
      clearTimeout(bucket.timer);
    }
    this.mediaGroups.clear();
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

    // --- Regular message (text and/or media) ---
    const msg = update.message;
    if (!msg || !msg.from) return;

    const senderId = String(msg.from.id);
    if (!this.allowedUsers.has(senderId)) {
      this.log.warn(`[${this.accountId}] Rejected message from unauthorized user: ${senderId}`);
      return;
    }

    const hasMedia = messageHasMedia(msg);

    const chatKey = `${this.accountId}:${msg.chat.id}`;

    if (!hasMedia) {
      // Fast path: plain text. Same effective behavior as before, but
      // routed through the per-chat dispatch lock so a text update
      // that follows a still-downloading media update in the same
      // poll batch can't overtake it at the `onMessage` boundary.
      if (!msg.text) {
        // Unsupported payload (contact / location / poll / dice etc.) —
        // drop with a debug log so we can see it in `rondel logs -v`.
        this.log.debug(`[${this.accountId}] Dropping unsupported message (no text, no known media)`);
        return;
      }
      const textMsg: ChannelMessage = {
        channelType: "telegram",
        accountId: this.accountId,
        chatId: String(msg.chat.id),
        senderId,
        senderName: msg.from.first_name ?? msg.from.username ?? "Unknown",
        text: msg.text,
        messageId: msg.message_id,
      };
      void this.chatDispatchLock.withLock(chatKey, async () => {
        this.onMessage(textMsg);
      });
      return;
    }

    // Media path. Two sub-cases:
    //  - media_group_id present → buffer for MEDIA_GROUP_FLUSH_MS, then
    //    dispatch all siblings as one ChannelMessage.
    //  - otherwise → dispatch immediately (fire-and-forget async, but
    //    serialised behind anything already in flight for this chat).
    if (msg.media_group_id) {
      this.bufferMediaGroup(msg);
      return;
    }
    void this.chatDispatchLock.withLock(chatKey, async () => {
      await this.dispatchMediaMessage(msg, []);
    });
  }

  /**
   * Buffer a media-group sibling. Same `media_group_id` across updates
   * means they're one album from the user's perspective — Telegram
   * just sends them as separate updates. We hold until 500 ms of
   * silence elapses for that group, then dispatch all siblings as a
   * single ChannelMessage.
   */
  private bufferMediaGroup(msg: TelegramMessage): void {
    const groupId = msg.media_group_id!;
    const existing = this.mediaGroups.get(groupId);
    if (existing) {
      existing.siblings.push(msg);
      clearTimeout(existing.timer);
      existing.timer = setTimeout(() => this.flushMediaGroup(groupId), MEDIA_GROUP_FLUSH_MS);
      return;
    }
    const bucket: MediaGroupBucket = {
      primary: msg,
      siblings: [],
      timer: setTimeout(() => this.flushMediaGroup(groupId), MEDIA_GROUP_FLUSH_MS),
    };
    this.mediaGroups.set(groupId, bucket);
  }

  /**
   * Flush a buffered media-group. Picks the first sibling with a text
   * caption (matching OpenClaw's behavior) so a single caption Telegram
   * may have attached to any photo in the album travels with the
   * dispatched message.
   */
  private flushMediaGroup(groupId: string): void {
    const bucket = this.mediaGroups.get(groupId);
    if (!bucket) return;
    this.mediaGroups.delete(groupId);
    const all = [bucket.primary, ...bucket.siblings];
    // First message with text or caption wins. If none, the dispatched
    // message has empty text and the model just sees the attachments.
    const captionMsg = all.find((m) => (m.text ?? m.caption ?? "").length > 0) ?? all[0]!;
    const others = all.filter((m) => m !== captionMsg);
    const chatKey = `${this.accountId}:${captionMsg.chat.id}`;
    void this.chatDispatchLock.withLock(chatKey, async () => {
      await this.dispatchMediaMessage(captionMsg, others);
    });
  }

  /**
   * Download + stage every attachment on `primary` plus any
   * `extraSiblings` (media-group case), then emit one ChannelMessage.
   * Fire-and-forget — caller `void`s us so the poll loop keeps moving.
   */
  private async dispatchMediaMessage(primary: TelegramMessage, extraSiblings: TelegramMessage[]): Promise<void> {
    const chatId = String(primary.chat.id);
    const senderId = String(primary.from!.id);
    const senderName = primary.from!.first_name ?? primary.from!.username ?? "Unknown";

    if (!this.attachmentService) {
      // Defensive — should be wired at boot. If missing, we drop the
      // media silently rather than blast text-only to the agent (which
      // would confuse the user when "did you get my photo?" gets an
      // affirmative reply for a message that never carried bytes).
      this.log.warn(`[${this.accountId}] Media message dropped: AttachmentService not configured`);
      return;
    }

    const agentName = this.resolveAgentName(this.accountId) ?? this.accountId;
    const allMessages = [primary, ...extraSiblings];

    const attachments: ChannelAttachment[] = [];
    const rejectionLines: string[] = [];
    for (const m of allMessages) {
      const input = toIngestInput(m);
      if (!input) continue;
      try {
        const result = await this.attachmentService.ingestTelegramMessage(
          agentName,
          chatId,
          this.botToken,
          input,
        );
        attachments.push(...result.attachments);
        for (const r of result.rejections) rejectionLines.push(r.description);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.log.error(`[${this.accountId}] Attachment ingest failed: ${message}`);
        rejectionLines.push(`one attachment failed (${message})`);
      }
    }

    // Compose the user-visible text from the chosen caption-bearer.
    const text = primary.text ?? primary.caption ?? "";

    if (attachments.length === 0 && rejectionLines.length === 0 && !text) {
      // Everything got dropped (animated / video sticker with no text,
      // unsupported payload that slipped through). Logged at info so the
      // user can find it via `rondel logs -f` when they wonder why their
      // sticker-only message produced no reply.
      this.log.info(
        `[${this.accountId}] Inbound message produced nothing to dispatch ` +
        `(chat=${chatId}, message=${primary.message_id}) — likely an animated/video sticker`,
      );
      return;
    }

    // Surface rejection details to the user out-of-band so they know
    // why their 50 MB video didn't make it through. Best-effort; never
    // throws.
    if (rejectionLines.length > 0) {
      const reply = formatRejectionReply(rejectionLines);
      this.apiCall("sendMessage", { chat_id: primary.chat.id, text: reply }).catch(() => {
        // Rejection reply is courtesy, not load-bearing.
      });
    }

    if (attachments.length === 0 && !text) {
      // After rejections, nothing left to forward.
      return;
    }

    this.onMessage({
      channelType: "telegram",
      accountId: this.accountId,
      chatId,
      senderId,
      senderName,
      text,
      messageId: primary.message_id,
      attachments,
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
  private attachmentService: AttachmentService | undefined;
  private resolveAgentName: (accountId: string) => string | undefined = () => undefined;

  constructor(allowedUsers: readonly string[], log: Logger) {
    this.allowedUsers = new Set(allowedUsers);
    this.log = log.child("telegram");
  }

  /**
   * Inject the channel-agnostic attachment ingestion service plus a
   * resolver that maps `accountId → agentName`. Wired by
   * `AgentManager.initialize` so the adapter can stage inbound media
   * under the right per-agent subtree. Must be called before
   * `start()` — accounts registered after this point pick up the
   * latest values automatically.
   */
  setAttachmentService(service: AttachmentService, resolveAgentName: (accountId: string) => string | undefined): void {
    this.attachmentService = service;
    this.resolveAgentName = resolveAgentName;
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
      this.attachmentService,
      this.resolveAgentName,
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

/**
 * Subset of the Telegram `Message` we care about. Only fields the
 * adapter reads are listed — the API is huge and most of it
 * (forward_from, reply_to_message, entities, etc.) doesn't affect
 * routing yet. Add fields here when a new behavior needs them.
 */
interface TelegramMessage {
  message_id: number;
  media_group_id?: string;
  from?: {
    id: number;
    first_name?: string;
    username?: string;
  };
  chat: {
    id: number;
  };
  text?: string;
  caption?: string;
  photo?: TgPhotoSizeRaw[];
  document?: TgDocumentRaw;
  voice?: TgVoiceRaw;
  audio?: TgAudioRaw;
  video?: TgVideoRaw;
  video_note?: TgVideoNoteRaw;
  animation?: TgAnimationRaw;
  sticker?: TgStickerRaw;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
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

// Raw Telegram media shapes — declared locally so the adapter can keep
// its imports tight. The shape mirrors the service-facing `TgPhotoSize`
// etc. in `attachments/attachment-service.ts`, but kept structurally
// separate so adapter and service can evolve independently.
interface TgPhotoSizeRaw {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  width: number;
  height: number;
}
interface TgDocumentRaw {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}
interface TgVoiceRaw {
  file_id: string;
  file_unique_id: string;
  duration: number;
  mime_type?: string;
  file_size?: number;
}
interface TgAudioRaw {
  file_id: string;
  file_unique_id: string;
  duration: number;
  performer?: string;
  title?: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}
interface TgVideoRaw {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  duration: number;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}
interface TgVideoNoteRaw {
  file_id: string;
  file_unique_id: string;
  length: number;
  duration: number;
  file_size?: number;
}
interface TgAnimationRaw {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  duration: number;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}
interface TgStickerRaw {
  file_id: string;
  file_unique_id: string;
  type?: string;
  width: number;
  height: number;
  is_animated?: boolean;
  is_video?: boolean;
  mime_type?: string;
  file_size?: number;
}

// --- Media helpers ---

function messageHasMedia(msg: TelegramMessage): boolean {
  return !!(
    msg.photo ||
    msg.document ||
    msg.voice ||
    msg.audio ||
    msg.video ||
    msg.video_note ||
    msg.animation ||
    msg.sticker
  );
}

function toIngestInput(msg: TelegramMessage): TelegramIngestInput | null {
  if (!messageHasMedia(msg)) return null;
  return {
    messageId: msg.message_id,
    photo: msg.photo,
    document: msg.document,
    voice: msg.voice,
    audio: msg.audio,
    video: msg.video,
    video_note: msg.video_note,
    animation: msg.animation,
    sticker: msg.sticker,
  };
}

function formatRejectionReply(lines: readonly string[]): string {
  if (lines.length === 1) {
    return `I couldn't accept your attachment — ${lines[0]}. Telegram bots can only download files up to 20 MB.`;
  }
  return `I couldn't accept some of your attachments:\n` +
    lines.map((l) => `  • ${l}`).join("\n") +
    `\nTelegram bots can only download files up to 20 MB.`;
}
