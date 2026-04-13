import type { ChannelAdapter, ChannelCredentials, ChannelMessage } from "./channel.js";
import type { Logger } from "../../shared/logger.js";

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
  private readonly log: Logger;

  constructor(log: Logger) {
    this.log = log.child("channels");
  }

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
  addAccount(channelType: string, accountId: string, credentials: ChannelCredentials): void {
    const adapter = this.requireAdapter(channelType);
    adapter.addAccount(accountId, credentials);
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
   * Call once — multiple calls register duplicate handlers on each adapter.
   */
  onMessage(handler: (msg: ChannelMessage) => void): void {
    this.messageHandlers.push(handler);
    for (const adapter of this.adapters.values()) {
      adapter.onMessage(handler);
    }
  }

  /**
   * Start all registered adapters.
   *
   * Per-adapter failures are logged and skipped — one bad adapter must
   * never prevent others from starting. Mirrors the log-and-continue
   * policy used by AgentManager.registerChannelBindings().
   */
  startAll(): void {
    for (const [id, adapter] of this.adapters.entries()) {
      try {
        adapter.start();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log.error(`Failed to start channel adapter "${id}" — ${msg}. Other adapters will continue.`);
      }
    }
  }

  /**
   * Stop all registered adapters.
   *
   * Per-adapter failures are logged and skipped so that a throw from
   * one adapter does not abort the orchestrator's shutdown sequence
   * (scheduler stop, bridge stop, session index persist, lock release).
   */
  stopAll(): void {
    for (const [id, adapter] of this.adapters.entries()) {
      try {
        adapter.stop();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log.error(`Failed to stop channel adapter "${id}" — ${msg}`);
      }
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
