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

export interface ChannelAdapter {
  /** Channel type identifier (e.g., "telegram", "slack"). */
  readonly id: string;

  /**
   * Register an account with this adapter using a raw credential.
   * The adapter knows how to interpret the credential for its platform
   * (e.g., Telegram treats it as a bot token, Slack as an OAuth token).
   */
  addAccount(accountId: string, credential: string): void;

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
   */
  startTypingIndicator(accountId: string, chatId: string): void;

  /**
   * Stop the typing indicator for a chat.
   * Clears any internal refresh timer. Idempotent.
   */
  stopTypingIndicator(accountId: string, chatId: string): void;
}

