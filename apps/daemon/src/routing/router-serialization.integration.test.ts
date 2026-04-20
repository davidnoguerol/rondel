/**
 * Tests the per-conversation serialization contract of Router.
 *
 * Without the `conversationLock`, two concurrent callers can both observe
 * `state === "idle"` and both dispatch, producing out-of-order delivery.
 * With it, every send/enqueue decision is atomic per conversation, and the
 * queue/dispatch order matches submission order.
 *
 * Uses inline stubs (same shape as scheduler-behavior.integration.test.ts)
 * — no real Claude CLI processes. What we care about here is the routing
 * decision, not the agent behaviour.
 */

import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { Router } from "./router.js";
import { QueueStore } from "./queue-store.js";
import type { AgentProcess } from "../agents/agent-process.js";
import type { AgentManager } from "../agents/agent-manager.js";
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

class FakeAgentProcess extends EventEmitter {
  readonly sent: string[] = [];
  constructor(public state: FakeState = "idle") {
    super();
  }
  getState(): FakeState {
    return this.state;
  }
  sendMessage(text: string): void {
    this.sent.push(text);
  }
  // Not used by the serialization tests but required by the Router's wireProcess.
  getSessionId(): string {
    return "stub-session";
  }
}

class StubAgentManager {
  readonly typingStarts: Array<{ channelType: string; accountId: string; chatId: string }> = [];
  private readonly registry = {
    startTypingIndicator: (channelType: string, accountId: string, chatId: string) => {
      this.typingStarts.push({ channelType, accountId, chatId });
    },
    stopTypingIndicator: () => {},
    sendText: async () => {},
    onMessage: () => {},
  };

  constructor(private readonly process: FakeAgentProcess) {}

  getConversation(): AgentProcess | undefined {
    return this.process as unknown as AgentProcess;
  }
  getPrimaryChannel(): { channelType: string; accountId: string } {
    return { channelType: "telegram", accountId: "bot1" };
  }
  getChannelRegistry() {
    return this.registry;
  }
}

function makeRouter(process: FakeAgentProcess, stateDir: string): Router {
  const mgr = new StubAgentManager(process);
  const queueStore = new QueueStore(stateDir);
  return new Router(mgr as unknown as AgentManager, silentLog as never, queueStore);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Router — per-conversation serialization (idle process)", () => {
  it("dispatches N concurrent sendOrQueue calls in submission order", async () => {
    const tmp = withTmpRondel();
    const process = new FakeAgentProcess("idle");
    const router = makeRouter(process, tmp.stateDir);

    const N = 10;
    const inputs = Array.from({ length: N }, (_, i) => `msg-${i}`);

    // Fire all calls without awaiting in-between — they race.
    await Promise.all(inputs.map((text) =>
      router.sendOrQueue("bot1", "telegram", "chat1", text),
    ));

    // Every message should have been dispatched (not queued — agent is idle).
    // Order must match submission order.
    expect(process.sent).toEqual(inputs);
  });
});

describe("Router — per-conversation serialization (busy process)", () => {
  it("enqueues N concurrent sendOrQueue calls in submission order", async () => {
    const tmp = withTmpRondel();
    const process = new FakeAgentProcess("busy");
    const router = makeRouter(process, tmp.stateDir);

    const N = 10;
    const inputs = Array.from({ length: N }, (_, i) => `msg-${i}`);

    await Promise.all(inputs.map((text) =>
      router.sendOrQueue("bot1", "telegram", "chat1", text),
    ));

    // Nothing dispatched — agent is busy for the whole test.
    expect(process.sent).toEqual([]);

    // The queue holds all messages in order. Reach in via a /status
    // command to observe position, or use the private map directly via
    // a narrow cast — the cast is the most direct assertion.
    const queues = (router as unknown as { queues: Map<string, Array<{ text: string }>> }).queues;
    const queue = queues.get("bot1:telegram:chat1")!;
    expect(queue.map((m) => m.text)).toEqual(inputs);
  });
});

describe("Router — per-conversation serialization (distinct conversations don't block)", () => {
  it("runs independent conversations concurrently", async () => {
    const tmp = withTmpRondel();
    const p1 = new FakeAgentProcess("idle");
    const p2 = new FakeAgentProcess("idle");

    // A router sees its AgentManager's process lookup — we need one router
    // that can return different processes per conversation. Build an inline
    // multi-process stub.
    const mgr = {
      getConversation: (_agent: string, channel: string, chat: string) => {
        if (chat === "chat1") return p1 as unknown as AgentProcess;
        if (chat === "chat2") return p2 as unknown as AgentProcess;
        return undefined;
      },
      getPrimaryChannel: () => ({ channelType: "telegram", accountId: "bot1" }),
      getChannelRegistry: () => ({
        startTypingIndicator: () => {},
        stopTypingIndicator: () => {},
        sendText: async () => {},
        onMessage: () => {},
      }),
    };
    const queueStore = new QueueStore(tmp.stateDir);
    const router = new Router(mgr as unknown as AgentManager, silentLog as never, queueStore);

    await Promise.all([
      router.sendOrQueue("bot1", "telegram", "chat1", "to-p1-a"),
      router.sendOrQueue("bot1", "telegram", "chat2", "to-p2-a"),
      router.sendOrQueue("bot1", "telegram", "chat1", "to-p1-b"),
      router.sendOrQueue("bot1", "telegram", "chat2", "to-p2-b"),
    ]);

    expect(p1.sent).toEqual(["to-p1-a", "to-p1-b"]);
    expect(p2.sent).toEqual(["to-p2-a", "to-p2-b"]);
  });
});
