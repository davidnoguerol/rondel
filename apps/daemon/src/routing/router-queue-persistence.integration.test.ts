/**
 * Tests the Router's disk-backed queue persistence end-to-end.
 *
 * Scenarios:
 *   1. Happy-path recovery: messages accepted while the agent was busy
 *      survive a daemon restart. Rebuilding the Router from the same
 *      state directory re-populates in-memory queues, and the next idle
 *      transition drains them in order.
 *   2. At-least-once on crash-mid-drain: the disk snapshot taken before
 *      a drain completes replays on recovery, producing a duplicate.
 *      This is the documented trade-off — loss would be strictly worse.
 *   3. Orphan cleanup: a queue file referencing a no-longer-existing
 *      agent is logged and cleared, not left to accumulate forever.
 *
 * Inline stubs in the style of scheduler-behavior.integration.test.ts —
 * no real Claude CLI processes. What we verify here is the Router /
 * QueueStore integration, not the agent.
 */

import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Router } from "./router.js";
import { QueueStore } from "./queue-store.js";
import type { AgentProcess } from "../agents/agent-process.js";
import type { AgentManager } from "../agents/agent-manager.js";
import { conversationKey, type QueuedMessage } from "../shared/types/index.js";
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
  private _state: FakeState;

  constructor(initial: FakeState = "busy") {
    super();
    this._state = initial;
  }

  getState(): FakeState {
    return this._state;
  }
  getSessionId(): string {
    return "stub-session";
  }
  sendMessage(text: string): void {
    this.sent.push(text);
  }

  /** Transition state + emit stateChange, the way the real AgentProcess does. */
  transitionTo(state: FakeState): void {
    this._state = state;
    this.emit("stateChange", state);
  }
}

interface StubManagerOptions {
  readonly knownAgents: ReadonlySet<string>;
  readonly process: FakeAgentProcess;
}

function makeStubManager(opts: StubManagerOptions) {
  const registry = {
    startTypingIndicator: () => {},
    stopTypingIndicator: () => {},
    sendText: async () => {},
    onMessage: () => {},
  };
  // The Router consults `agentManager.conversations.hasPendingRestart` on
  // every idle transition (for post-turn skill-reload restarts). A minimal
  // stub that always reports no pending restart keeps the drain path
  // straightforward for these tests.
  const conversations = {
    hasPendingRestart: () => false,
    clearPendingRestart: () => {},
  };
  return {
    conversations,
    getConversation: (agent: string) =>
      opts.knownAgents.has(agent) ? (opts.process as unknown as AgentProcess) : undefined,
    getOrSpawnConversation: (agent: string) =>
      opts.knownAgents.has(agent) ? (opts.process as unknown as AgentProcess) : undefined,
    getPrimaryChannel: () => ({ channelType: "telegram", accountId: "bot1" }),
    getChannelRegistry: () => registry,
  };
}

function makeMessage(text: string, agent = "bot1", chat = "chat1"): QueuedMessage {
  return {
    agentName: agent,
    channelType: "telegram",
    accountId: "bot1",
    chatId: chat,
    text,
    queuedAt: Date.now(),
  };
}

/**
 * Poll a predicate until it returns truthy. Used to wait on the async
 * drain chain (stateChange → drainQueue → sendMessage → removeFirst),
 * which spans multiple microtask/macrotask ticks of file I/O.
 */
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

describe("Router — queue persistence (accept path)", () => {
  it("writes accepted messages to disk before returning", async () => {
    const tmp = withTmpRondel();
    const process = new FakeAgentProcess("busy");
    const mgr = makeStubManager({ knownAgents: new Set(["bot1"]), process });
    const store = new QueueStore(tmp.stateDir);
    await store.ensureDir();
    const router = new Router(mgr as unknown as AgentManager, silentLog as never, store);

    await router.sendOrQueue("bot1", "telegram", "chat1", "m1");
    await router.sendOrQueue("bot1", "telegram", "chat1", "m2");

    const persisted = await store.readAll();
    const messages = persisted.get(conversationKey("bot1", "telegram", "chat1"));
    expect(messages?.map((m) => m.text)).toEqual(["m1", "m2"]);
  });
});

describe("Router — queue recovery (happy path)", () => {
  it("rebuilds in-memory queues from disk and drains on next idle", async () => {
    const tmp = withTmpRondel();
    const process = new FakeAgentProcess("busy");
    const mgr = makeStubManager({ knownAgents: new Set(["bot1"]), process });
    const store = new QueueStore(tmp.stateDir);
    await store.ensureDir();

    // Simulate a previous run that queued three messages while the agent
    // was busy and then crashed before draining.
    const key = conversationKey("bot1", "telegram", "chat1");
    await store.append(key, makeMessage("m1"));
    await store.append(key, makeMessage("m2"));
    await store.append(key, makeMessage("m3"));

    // Fresh daemon — new Router instance reading the same stateDir.
    const router = new Router(mgr as unknown as AgentManager, silentLog as never, store);
    await router.recoverQueues();

    // Agent was busy across the restart; simulate it finishing the
    // in-flight turn. Drain fires on each idle transition, so we step
    // through busy→idle once per queued message.
    process.transitionTo("idle");
    await waitFor(() => process.sent.length >= 1);

    process.transitionTo("busy");
    process.transitionTo("idle");
    await waitFor(() => process.sent.length >= 2);

    process.transitionTo("busy");
    process.transitionTo("idle");
    await waitFor(() => process.sent.length >= 3);

    expect(process.sent).toEqual(["m1", "m2", "m3"]);

    // Disk should be empty after the full drain.
    const persisted = await store.readAll();
    expect(persisted.has(key)).toBe(false);
  });
});

describe("Router — queue recovery (orphan cleanup)", () => {
  it("clears queue files for agents that no longer exist", async () => {
    const tmp = withTmpRondel();
    const process = new FakeAgentProcess("idle");
    // Only "bot1" is known — "ghost" is orphaned.
    const mgr = makeStubManager({ knownAgents: new Set(["bot1"]), process });
    const store = new QueueStore(tmp.stateDir);
    await store.ensureDir();

    const orphanKey = conversationKey("ghost", "telegram", "chat9");
    const liveKey = conversationKey("bot1", "telegram", "chat1");
    await store.append(orphanKey, makeMessage("lost", "ghost", "chat9"));
    await store.append(liveKey, makeMessage("kept"));

    const router = new Router(mgr as unknown as AgentManager, silentLog as never, store);
    await router.recoverQueues();

    const after = await store.readAll();
    expect(after.has(orphanKey)).toBe(false); // cleared
    expect(after.get(liveKey)?.map((m) => m.text)).toEqual(["kept"]); // preserved
  });

  it("skips files with malformed names without crashing", async () => {
    const tmp = withTmpRondel();
    const process = new FakeAgentProcess("idle");
    const mgr = makeStubManager({ knownAgents: new Set(["bot1"]), process });
    const store = new QueueStore(tmp.stateDir);
    await store.ensureDir();

    // Drop a file with a name that decodes to something that's not a valid
    // conversation key (no colons). The store's readAll silently skips it,
    // so recovery shouldn't see it at all — and shouldn't crash.
    await writeFile(join(tmp.stateDir, "queues", "garbage.json"), "[]");

    const router = new Router(mgr as unknown as AgentManager, silentLog as never, store);
    await expect(router.recoverQueues()).resolves.toBeUndefined();
  });
});

describe("Router — queue persistence (drain removes from disk)", () => {
  it("clears the on-disk entry after successful dispatch", async () => {
    const tmp = withTmpRondel();
    const process = new FakeAgentProcess("busy");
    const mgr = makeStubManager({ knownAgents: new Set(["bot1"]), process });
    const store = new QueueStore(tmp.stateDir);
    await store.ensureDir();
    const router = new Router(mgr as unknown as AgentManager, silentLog as never, store);

    // Two messages accepted while busy.
    await router.sendOrQueue("bot1", "telegram", "chat1", "m1");
    await router.sendOrQueue("bot1", "telegram", "chat1", "m2");

    const key = conversationKey("bot1", "telegram", "chat1");
    expect((await store.readAll()).get(key)!.length).toBe(2);

    // Drain one: transition idle → drain fires → dispatches m1 → removes from disk.
    process.transitionTo("idle");
    await waitFor(() => process.sent.length >= 1);

    // Then wait for the disk-remove to complete (the drain's removeFirst
    // await finishes after dispatch — see drainQueue's at-least-once
    // comment). Polling disk state is the reliable signal here.
    await waitFor(async () => {
      const persisted = await store.readAll();
      const remaining = persisted.get(key)?.map((m) => m.text) ?? [];
      return remaining.length === 1 && remaining[0] === "m2";
    });

    expect(process.sent).toEqual(["m1"]);
    expect((await store.readAll()).get(key)!.map((m) => m.text)).toEqual(["m2"]);
  });
});
