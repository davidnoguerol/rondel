import type {
  ChannelAdapter,
  ChannelCredentials,
  ChannelMessage,
  InteractiveButton,
  InteractiveCallback,
} from "../core/channel.js";
import type { Logger } from "../../shared/logger.js";

/**
 * Web channel adapter.
 *
 * In-process, loopback-only channel. Unlike Telegram (which polls an external
 * API), the web adapter is driven entirely by the HTTP bridge:
 *   - POST /web/messages/send calls `ingestUserMessage()`, which normalizes
 *     the HTTP request to a `ChannelMessage` and dispatches it through the
 *     same handler pipeline Telegram uses (Router → sendOrQueue → agent).
 *   - GET /conversations/.../tail subscribes to per-conversation frames
 *     published by `sendText()` / typing indicators. Subscriptions are fan-out
 *     across multiple browser tabs watching the same conversation.
 *
 * Accounts are a synthetic artifact here: one account per agent, with
 * accountId === agentName. This lets the existing `resolveAgentByChannel`
 * lookup in AgentManager work unchanged for web traffic.
 *
 * Each conversation has a bounded ring buffer of recent frames so a tab that
 * opens mid-turn replays the last few events before going live.
 */

/** Frame kinds fan-out to subscribers. */
export type WebChannelFrame =
  | { readonly kind: "agent_response"; readonly text: string; readonly ts: string }
  | { readonly kind: "typing_start"; readonly ts: string }
  | { readonly kind: "typing_stop"; readonly ts: string };

/** Size of the per-conversation ring buffer. Keeps replay cheap but useful. */
const RING_BUFFER_SIZE = 20;

type FrameListener = (frame: WebChannelFrame) => void;

interface ConversationBuffer {
  readonly listeners: Set<FrameListener>;
  readonly frames: WebChannelFrame[];
}

/**
 * Key for the per-conversation buffer map. We don't use `ConversationKey`
 * here because the adapter doesn't know the agentName — the `accountId` is
 * the agent. The key is just `${accountId}:${chatId}`.
 */
function bufferKey(accountId: string, chatId: string): string {
  return `${accountId}:${chatId}`;
}

export class WebChannelAdapter implements ChannelAdapter {
  readonly id = "web";
  // Approvals for web conversations are surfaced via the dedicated
  // /approvals page in the web UI, not as inline buttons in the chat
  // thread. `false` here makes ApprovalService skip the channel fan-out
  // and fall through to the web-UI-only path. See the "Web UI" fallback
  // section in apps/daemon/src/approvals/approval-service.ts.
  readonly supportsInteractive = false;

  private readonly accounts = new Set<string>();
  private readonly messageHandlers: ((msg: ChannelMessage) => void)[] = [];
  private readonly buffers = new Map<string, ConversationBuffer>();
  private readonly log: Logger;

  constructor(log: Logger) {
    this.log = log.child("web-channel");
  }

  // ---------------------------------------------------------------------------
  // ChannelAdapter — account lifecycle
  // ---------------------------------------------------------------------------

  addAccount(accountId: string, _credentials: ChannelCredentials): void {
    if (this.accounts.has(accountId)) {
      throw new Error(`Web account "${accountId}" already registered`);
    }
    this.accounts.add(accountId);
    this.log.info(`Registered account: ${accountId}`);
  }

  startAccount(_accountId: string): void {
    // No-op — the web channel is driven by inbound HTTP requests, not a
    // polling loop. There's nothing to "start".
  }

  removeAccount(accountId: string): void {
    if (!this.accounts.delete(accountId)) return;

    // Drop any per-conversation buffers scoped to this account. Listeners
    // that were mid-subscription get their sets emptied; they will see no
    // further frames, which is the correct end state for a removed account.
    for (const key of [...this.buffers.keys()]) {
      if (key.startsWith(`${accountId}:`)) {
        const buffer = this.buffers.get(key);
        if (buffer) buffer.listeners.clear();
        this.buffers.delete(key);
      }
    }

    this.log.info(`Removed account: ${accountId}`);
  }

  start(): void {
    // No-op — the adapter becomes "live" as soon as bridge endpoints attach.
  }

  stop(): void {
    // Drop all subscribers — outstanding SSE requests will notice the
    // unsubscribe from their side via req.close.
    for (const buffer of this.buffers.values()) {
      buffer.listeners.clear();
    }
    this.buffers.clear();
  }

  // ---------------------------------------------------------------------------
  // ChannelAdapter — inbound
  // ---------------------------------------------------------------------------

  onMessage(handler: (msg: ChannelMessage) => void): void {
    this.messageHandlers.push(handler);
  }

  // ---------------------------------------------------------------------------
  // ChannelAdapter — outbound
  // ---------------------------------------------------------------------------

  // eslint-disable-next-line @typescript-eslint/require-await
  async sendText(accountId: string, chatId: string, text: string): Promise<void> {
    if (!this.accounts.has(accountId)) {
      throw new Error(`Unknown web account: ${accountId}`);
    }
    this.dispatchFrame(accountId, chatId, {
      kind: "agent_response",
      text,
      ts: new Date().toISOString(),
    });
  }

  startTypingIndicator(accountId: string, chatId: string): void {
    if (!this.accounts.has(accountId)) return;
    this.dispatchFrame(accountId, chatId, {
      kind: "typing_start",
      ts: new Date().toISOString(),
    });
  }

  stopTypingIndicator(accountId: string, chatId: string): void {
    if (!this.accounts.has(accountId)) return;
    this.dispatchFrame(accountId, chatId, {
      kind: "typing_stop",
      ts: new Date().toISOString(),
    });
  }

  /**
   * Not supported — the web adapter has no inline-button surface. Approvals
   * for web conversations are routed through the dedicated /approvals page.
   */
  async sendInteractive(
    _accountId: string,
    _chatId: string,
    _text: string,
    _buttons: readonly InteractiveButton[],
  ): Promise<void> {
    throw new Error("WebChannelAdapter.sendInteractive is not supported — use the /approvals page");
  }

  /** No-op — web approvals don't come in as interactive callbacks. */
  onInteractiveCallback(_handler: (cb: InteractiveCallback) => void): void {
    // Intentionally empty. See comment on `supportsInteractive`.
  }

  // ---------------------------------------------------------------------------
  // Web-specific API — called by the bridge
  // ---------------------------------------------------------------------------

  /**
   * Inject a user message from an HTTP request, as if it had arrived on a
   * real channel. Dispatches to the same `onMessage` handlers Router registers
   * for Telegram, so the Router → sendOrQueue → AgentProcess pipeline is reused
   * verbatim.
   *
   * The adapter is tolerant of unknown accounts here — it constructs the
   * ChannelMessage and dispatches it anyway. The Router will call
   * `resolveAgentByChannel("web", accountId)` and fail closed if no agent
   * owns this account, producing the same log path Telegram unknown-account
   * messages take.
   */
  ingestUserMessage(params: {
    readonly accountId: string;
    readonly chatId: string;
    readonly text: string;
    readonly senderId?: string;
    readonly senderName?: string;
    readonly messageId?: number;
  }): void {
    const msg: ChannelMessage = {
      channelType: this.id,
      accountId: params.accountId,
      chatId: params.chatId,
      senderId: params.senderId ?? "web-user",
      senderName: params.senderName ?? "Web",
      text: params.text,
      messageId: params.messageId ?? Date.now(),
    };
    this.dispatchMessage(msg);
  }

  /**
   * Subscribe to frames for a single (accountId, chatId). Returns an
   * unsubscribe function. The bridge's SSE handler uses this to wire browser
   * clients to the per-conversation fan-out.
   */
  subscribeConversation(
    accountId: string,
    chatId: string,
    listener: FrameListener,
  ): () => void {
    const buffer = this.ensureBuffer(accountId, chatId);
    buffer.listeners.add(listener);
    return () => {
      buffer.listeners.delete(listener);
    };
  }

  /**
   * Return a copy of the ring buffer's current frames for a conversation.
   * Used by the SSE handler to replay recent context to a tab that opens
   * mid-stream. The returned array is a shallow copy — safe to iterate after
   * further frames are published.
   */
  getRingBuffer(accountId: string, chatId: string): readonly WebChannelFrame[] {
    const buffer = this.buffers.get(bufferKey(accountId, chatId));
    if (!buffer) return [];
    return [...buffer.frames];
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private dispatchMessage(msg: ChannelMessage): void {
    for (const handler of this.messageHandlers) {
      try {
        handler(msg);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.log.warn(`Message handler threw: ${message}`);
      }
    }
  }

  private ensureBuffer(accountId: string, chatId: string): ConversationBuffer {
    const key = bufferKey(accountId, chatId);
    let buffer = this.buffers.get(key);
    if (!buffer) {
      buffer = { listeners: new Set(), frames: [] };
      this.buffers.set(key, buffer);
    }
    return buffer;
  }

  private dispatchFrame(accountId: string, chatId: string, frame: WebChannelFrame): void {
    const buffer = this.ensureBuffer(accountId, chatId);

    // Append to ring buffer first, then fan-out. Replay on a fresh subscribe
    // is served from this buffer, so publishing before dispatch ensures a
    // racing subscriber that attaches between these two lines still sees
    // the frame — once via the buffer on its own replay, once via fan-out.
    // The SSE handler dedupes via subscribe-before-replay ordering.
    buffer.frames.push(frame);
    if (buffer.frames.length > RING_BUFFER_SIZE) {
      buffer.frames.splice(0, buffer.frames.length - RING_BUFFER_SIZE);
    }

    // Snapshot the listener set before iterating — unsubscribes during
    // fan-out (e.g. a tab closing mid-stream) must not invalidate the
    // iterator for siblings.
    for (const listener of [...buffer.listeners]) {
      try {
        listener(frame);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.log.warn(`Frame listener threw: ${message}`);
      }
    }
  }
}
