/**
 * Channel adapter interface.
 *
 * A channel is a messaging platform (Telegram, Slack, Discord, etc.).
 * Each channel adapter manages one or more accounts (e.g., multiple Telegram bots)
 * and normalizes inbound messages into a common format.
 *
 * Modeled after OpenClaw's ChannelPlugin pattern:
 * - Multi-account: one adapter instance manages N accounts
 * - Composable: channels implement a common interface
 * - Normalized: inbound messages carry (accountId, chatId) for routing
 */

export interface ChannelMessage {
  readonly channelType: string;  // which channel this came from (e.g., "telegram", "slack")
  readonly accountId: string;    // which account received this (e.g., bot identifier)
  readonly chatId: string;       // conversation ID within the channel
  readonly senderId: string;
  readonly senderName: string;
  readonly text: string;
  readonly messageId: number;
}

/**
 * Credentials passed to `ChannelAdapter.addAccount`.
 *
 * `primary` is the main secret — a Telegram bot token, a Slack bot token,
 * etc. `extra` carries any additional secrets a channel needs (Slack's
 * app-level token, WhatsApp session directory path, etc.).
 *
 * Adapters that only need one secret ignore `extra`.
 */
export interface ChannelCredentials {
  readonly primary: string;
  readonly extra: Readonly<Record<string, string>>;
}

/**
 * A single button in an interactive message (e.g., Telegram inline
 * keyboard). `callbackData` is an opaque identifier the adapter will
 * send back via `onInteractiveCallback` when the user taps the button.
 *
 * Rondel uses the prefix `rondel_appr_<allow|deny>_<id>` for approval
 * buttons — adapters don't interpret the data, they just echo it.
 */
export interface InteractiveButton {
  readonly label: string;
  readonly callbackData: string;
}

/**
 * A button tap or equivalent callback from a user. The adapter
 * normalises platform-specific callback payloads into this shape
 * before firing `onInteractiveCallback`.
 */
export interface InteractiveCallback {
  readonly channelType: string;
  readonly accountId: string;
  readonly chatId: string;
  readonly senderId: string;
  readonly callbackData: string;
  /** Platform message id of the card the button was attached to, if any. */
  readonly messageId?: number;
  /**
   * Platform-specific callback query id. On Telegram this is the id the
   * adapter passes back to `answerCallbackQuery` to stop the button's
   * loading spinner. Other channels may leave this undefined.
   */
  readonly callbackQueryId?: string;
}

export interface ChannelAdapter {
  /** Channel type identifier (e.g., "telegram", "slack"). */
  readonly id: string;

  /**
   * Whether this adapter supports interactive buttons / inline keyboards.
   * Consumers check this before calling `sendInteractive`. Channels that
   * cannot render buttons (plain SMS, raw email) set this to `false` and
   * throw from `sendInteractive`. Callers must have a fallback path (e.g.,
   * routing approvals through the web UI only).
   */
  readonly supportsInteractive: boolean;

  /**
   * Register an account with this adapter.
   *
   * The adapter knows how to interpret the credentials for its platform.
   * Single-secret channels (Telegram) read `credentials.primary` and ignore
   * `credentials.extra`. Multi-secret channels (Slack, WhatsApp) read from
   * `credentials.extra` for their additional secrets.
   */
  addAccount(accountId: string, credentials: ChannelCredentials): void;

  /** Start all registered accounts (begin listening for messages). */
  start(): void;

  /** Stop all accounts (stop listening, clean up). */
  stop(): void;

  /** Start a specific account (for hot-adding at runtime). */
  startAccount(accountId: string): void;

  /** Stop and remove a specific account (for hot-removing at runtime / workflow cleanup). */
  removeAccount(accountId: string): void;

  /** Register a handler for inbound messages from any account. */
  onMessage(handler: (msg: ChannelMessage) => void): void;

  /** Send a text message through a specific account. */
  sendText(accountId: string, chatId: string, text: string): Promise<void>;

  /**
   * Begin showing a typing/activity indicator in a chat.
   * The adapter manages refresh internally (e.g., Telegram's indicator
   * expires after ~5s, so the adapter re-sends it on a timer).
   * Idempotent — calling while already typing is a no-op.
   * Fire-and-forget: void return, errors logged internally.
   *
   * Channels without a typing-indicator concept (Slack Socket Mode) may
   * implement this as a no-op.
   */
  startTypingIndicator(accountId: string, chatId: string): void;

  /**
   * Stop the typing indicator for a chat.
   * Clears any internal refresh timer. Idempotent.
   */
  stopTypingIndicator(accountId: string, chatId: string): void;

  /**
   * Send an interactive message with clickable buttons.
   * Only valid when `supportsInteractive` is true — adapters that
   * don't support it throw. The returned promise resolves once the
   * platform has accepted the message (not when the user taps).
   */
  sendInteractive(
    accountId: string,
    chatId: string,
    text: string,
    buttons: readonly InteractiveButton[],
  ): Promise<void>;

  /**
   * Register a handler for button-tap callbacks. The adapter dedupes
   * handlers identically to `onMessage` — register once at startup.
   * Handlers run in order of registration.
   */
  onInteractiveCallback(handler: (cb: InteractiveCallback) => void): void;
}
