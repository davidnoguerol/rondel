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
  readonly accountId: string;  // which account received this (e.g., bot identifier)
  readonly chatId: string;     // conversation ID within the channel
  readonly senderId: string;
  readonly senderName: string;
  readonly text: string;
  readonly messageId: number;
}

export interface ChannelAdapter {
  /** Channel type identifier (e.g., "telegram", "slack"). */
  readonly id: string;

  /**
   * Register an account with this adapter.
   * For Telegram, an account is a bot (identified by its token).
   * The accountId is a human-readable label used for routing.
   */
  addAccount(accountId: string, config: AccountConfig): void;

  /** Start all registered accounts (begin listening for messages). */
  start(): void;

  /** Stop all accounts (stop listening, clean up). */
  stop(): void;

  /** Register a handler for inbound messages from any account. */
  onMessage(handler: (msg: ChannelMessage) => void): void;

  /** Send a text message through a specific account. */
  sendText(accountId: string, chatId: string, text: string): Promise<void>;

  /** Send a typing indicator through a specific account. */
  sendTypingIndicator(accountId: string, chatId: string): Promise<void>;
}

/**
 * Account config — channel-specific.
 * Each channel type defines what it needs.
 */
export interface AccountConfig {
  readonly [key: string]: unknown;
}

export interface TelegramAccountConfig extends AccountConfig {
  readonly botToken: string;
}
