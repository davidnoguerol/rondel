/**
 * Threads inbound attachments through the Router on both the idle and busy
 * paths.
 *
 * Why both:
 *
 *   - **Idle path** is the common case — a user sends a photo to a quiet
 *     agent and the bytes must reach `process.sendMessage`'s `attachments`
 *     option in the same tick.
 *
 *   - **Busy path** is the failure mode we care about most. A user can send
 *     a photo while the agent is mid-turn, which forces an `enqueue` →
 *     `drainQueue` round-trip. If attachments aren't persisted in the
 *     QueuedMessage and forwarded on drain, the agent silently loses the
 *     bytes and replies to text-only content. Worse, a daemon crash between
 *     accept and drain replays the queue from disk on recovery — at-least-
 *     once delivery for the text, but a regression here would silently drop
 *     attachments on replay because they wouldn't have been serialised.
 *
 * Uses inline FakeAgentProcess in the style of
 * `router-queue-persistence.integration.test.ts`. We capture the full
 * `sendMessage` options (text + attachments) so the assertions verify the
 * wire to AgentProcess, not just the text.
 */

import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { Router } from "./router.js";
import { QueueStore } from "./queue-store.js";
import type { AgentProcess } from "../agents/agent-process.js";
import type { AgentManager } from "../agents/agent-manager.js";
import type { ChannelAttachment } from "../shared/types/attachments.js";
import type { ChannelMessage } from "../channels/core/channel.js";
import { conversationKey } from "../shared/types/index.js";
import { withTmpRondel } from "../../../../tests/helpers/tmp.js";

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

const silentLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => silentLog,
} as const;

type FakeState = "idle" | "busy" | "starting" | "crashed" | "halted";

interface CapturedSend {
  readonly text: string;
  readonly attachments?: readonly ChannelAttachment[];
}

class FakeAgentProcess extends EventEmitter {
  readonly sent: CapturedSend[] = [];
  private _state: FakeState;

  constructor(initial: FakeState = "idle") {
    super();
    this._state = initial;
  }

  getState(): FakeState {
    return this._state;
  }
  getSessionId(): string {
    return "stub-session";
  }
  /**
   * Match AgentProcess's real signature so the Router's call site
   * `process.sendMessage(text, { senderId, senderName, attachments })`
   * compiles when cast. We only care about `text` and `attachments` for
   * these assertions — senderId/senderName are dropped silently.
   */
  sendMessage(text: string, options?: { attachments?: readonly ChannelAttachment[] }): void {
    this.sent.push({ text, attachments: options?.attachments });
  }

  transitionTo(state: FakeState): void {
    this._state = state;
    this.emit("stateChange", state);
  }
}

/**
 * Minimal channel registry that captures the Router's inbound `onMessage`
 * handler so tests can fire synthetic `ChannelMessage`s — same trick as
 * the real ChannelRegistry, just without any adapters underneath.
 */
class StubChannelRegistry {
  private inboundHandler: ((msg: ChannelMessage) => void) | undefined;
  startTypingIndicator(): void {}
  stopTypingIndicator(): void {}
  async sendText(): Promise<void> {}
  onMessage(handler: (msg: ChannelMessage) => void): void {
    this.inboundHandler = handler;
  }
  /** Test-only: deliver a synthetic inbound message through the stored handler. */
  deliver(msg: ChannelMessage): void {
    if (!this.inboundHandler) throw new Error("Router did not register an onMessage handler yet");
    this.inboundHandler(msg);
  }
}

function makeStubManager(process: FakeAgentProcess, registry: StubChannelRegistry) {
  return {
    conversations: {
      hasPendingRestart: () => false,
      clearPendingRestart: () => {},
    },
    resolveAgentByChannel: () => "bot1",
    getConversation: () => process as unknown as AgentProcess,
    getOrSpawnConversation: () => process as unknown as AgentProcess,
    getPrimaryChannel: () => ({ channelType: "telegram", accountId: "bot1" }),
    getChannelRegistry: () => registry,
  };
}

function makeAttachment(overrides?: Partial<ChannelAttachment>): ChannelAttachment {
  return {
    kind: "image",
    path: "/tmp/rondel-test/photo.jpg",
    mimeType: "image/jpeg",
    bytes: 1024,
    ...overrides,
  };
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise<void>((r) => setTimeout(r, 5));
  }
  throw new Error(`Timeout after ${timeoutMs}ms waiting for condition`);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Router — inbound attachments (idle path)", () => {
  it("forwards attachments to process.sendMessage in the same tick", async () => {
    const tmp = withTmpRondel();
    const process = new FakeAgentProcess("idle");
    const registry = new StubChannelRegistry();
    const mgr = makeStubManager(process, registry);
    const store = new QueueStore(tmp.stateDir);
    await store.ensureDir();
    const router = new Router(mgr as unknown as AgentManager, silentLog as never, store);
    router.start(); // installs the onMessage handler on our stub registry

    const attachment = makeAttachment({ path: "/tmp/photo-1.jpg" });
    registry.deliver({
      channelType: "telegram",
      accountId: "bot1",
      chatId: "chat1",
      senderId: "user1",
      senderName: "user",
      text: "look at this",
      messageId: 1,
      attachments: [attachment],
    });

    // handleInboundMessage is async — give the microtask queue a tick.
    await waitFor(() => process.sent.length >= 1);

    expect(process.sent).toHaveLength(1);
    expect(process.sent[0].text).toBe("look at this");
    expect(process.sent[0].attachments).toEqual([attachment]);
  });
});

describe("Router — inbound attachments (busy enqueue → drain path)", () => {
  it("persists attachments with the queued message and forwards them on drain", async () => {
    const tmp = withTmpRondel();
    const process = new FakeAgentProcess("busy");
    const registry = new StubChannelRegistry();
    const mgr = makeStubManager(process, registry);
    const store = new QueueStore(tmp.stateDir);
    await store.ensureDir();
    const router = new Router(mgr as unknown as AgentManager, silentLog as never, store);
    router.start();

    const attachment = makeAttachment({ path: "/tmp/photo-busy.jpg", bytes: 2048 });
    registry.deliver({
      channelType: "telegram",
      accountId: "bot1",
      chatId: "chat1",
      senderId: "user1",
      senderName: "user",
      text: "queue me",
      messageId: 1,
      attachments: [attachment],
    });

    // Nothing dispatched yet — agent is busy.
    await waitFor(async () => {
      const persisted = await store.readAll();
      return persisted.has(conversationKey("bot1", "telegram", "chat1"));
    });
    expect(process.sent).toEqual([]);

    // Disk-side: the QueueStore round-tripped the attachments field.
    // This is the crash-recovery invariant — without it, a daemon
    // restart between accept and drain would replay the text but lose
    // the bytes silently.
    const persisted = await store.readAll();
    const queued = persisted.get(conversationKey("bot1", "telegram", "chat1"))!;
    expect(queued).toHaveLength(1);
    expect(queued[0].text).toBe("queue me");
    expect(queued[0].attachments).toEqual([attachment]);

    // Now the agent finishes its turn — drain fires and dispatches the
    // queued message with attachments still attached.
    process.transitionTo("idle");
    await waitFor(() => process.sent.length >= 1);

    expect(process.sent).toHaveLength(1);
    expect(process.sent[0].text).toBe("queue me");
    expect(process.sent[0].attachments).toEqual([attachment]);
  });
});
