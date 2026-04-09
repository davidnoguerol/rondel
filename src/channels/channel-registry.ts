import type { ChannelAdapter, ChannelMessage } from "./channel.js";

/**
 * Central registry for all channel adapters.
 *
 * Components interact with channels through this registry instead of
 * referencing concrete adapters (TelegramAdapter, SlackAdapter, etc.).
 * This decouples the core from any specific channel implementation.
 */
export class ChannelRegistry {
  private readonly adapters = new Map<string, ChannelAdapter>();
  private readonly messageHandlers: Array<(msg: ChannelMessage) => void> = [];

  /** Register a channel adapter. The adapter's `id` is used as the key. */
  register(adapter: ChannelAdapter): void {
    if (this.adapters.has(adapter.id)) {
      throw new Error(`Channel adapter "${adapter.id}" already registered`);
    }
    this.adapters.set(adapter.id, adapter);
    // Replay existing message handlers to the new adapter
    for (const handler of this.messageHandlers) {
      adapter.onMessage(handler);
    }
  }

  /** Get a specific adapter by channel type. */
  get(channelType: string): ChannelAdapter | undefined {
    return this.adapters.get(channelType);
  }

  /** Register an account with a specific channel adapter. */
  addAccount(channelType: string, accountId: string, credential: string): void {
    const adapter = this.requireAdapter(channelType);
    adapter.addAccount(accountId, credential);
  }

  /** Start a specific account on a specific adapter (hot-add). */
  startAccount(channelType: string, accountId: string): void {
    const adapter = this.requireAdapter(channelType);
    adapter.startAccount(accountId);
  }

  /** Stop and remove a specific account from a specific adapter. */
  removeAccount(channelType: string, accountId: string): void {
    const adapter = this.requireAdapter(channelType);
    adapter.removeAccount(accountId);
  }

  /** Send text through the correct adapter. */
  async sendText(channelType: string, accountId: string, chatId: string, text: string): Promise<void> {
    const adapter = this.requireAdapter(channelType);
    await adapter.sendText(accountId, chatId, text);
  }

  /** Start typing indicator. */
  startTypingIndicator(channelType: string, accountId: string, chatId: string): void {
    const adapter = this.requireAdapter(channelType);
    adapter.startTypingIndicator(accountId, chatId);
  }

  /** Stop typing indicator. */
  stopTypingIndicator(channelType: string, accountId: string, chatId: string): void {
    const adapter = this.requireAdapter(channelType);
    adapter.stopTypingIndicator(accountId, chatId);
  }

  /**
   * Register a message handler across all current AND future adapters.
   * Handlers are stored and replayed when new adapters are registered.
   */
  onMessage(handler: (msg: ChannelMessage) => void): void {
    this.messageHandlers.push(handler);
    for (const adapter of this.adapters.values()) {
      adapter.onMessage(handler);
    }
  }

  /** Start all registered adapters. */
  startAll(): void {
    for (const adapter of this.adapters.values()) {
      adapter.start();
    }
  }

  /** Stop all registered adapters. */
  stopAll(): void {
    for (const adapter of this.adapters.values()) {
      adapter.stop();
    }
  }

  /** Get all registered channel type IDs. */
  getChannelTypes(): string[] {
    return [...this.adapters.keys()];
  }

  private requireAdapter(channelType: string): ChannelAdapter {
    const adapter = this.adapters.get(channelType);
    if (!adapter) {
      throw new Error(`No channel adapter registered for type "${channelType}"`);
    }
    return adapter;
  }
}
