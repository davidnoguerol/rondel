/**
 * Unit tests for AgentStateStreamSource.
 *
 * Scope: snapshot content + tagging, delta fan-out + tagging, zero-client
 * fast path on deltas, per-client error isolation, and dispose() release
 * of the upstream ConversationManager subscription.
 *
 * We hand-fake the ConversationManager surface this source actually
 * touches (`onStateChange` + `getAllConversationStates`) rather than
 * construct a real one — the real manager pulls in hooks, AgentProcess,
 * session index, transcripts, and fs.
 */

import { describe, it, expect } from "vitest";

import type { ConversationManager } from "../agents/conversation-manager.js";
import type { AgentStateEvent } from "../shared/types/agents.js";
import { AgentStateStreamSource, type AgentStateFrameData } from "./agent-state-stream.js";
import type { SseFrame } from "./sse-types.js";

// -----------------------------------------------------------------------------
// Fake ConversationManager
// -----------------------------------------------------------------------------

interface FakeCM {
  readonly manager: ConversationManager;
  setSnapshot(entries: AgentStateEvent[]): void;
  emitDelta(entry: AgentStateEvent): void;
  listenerCount(): number;
}

function makeFakeCM(): FakeCM {
  const listeners = new Set<(e: AgentStateEvent) => void>();
  let snapshot: AgentStateEvent[] = [];

  const fake = {
    onStateChange(cb: (e: AgentStateEvent) => void): () => void {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    getAllConversationStates(): AgentStateEvent[] {
      return snapshot;
    },
  } as unknown as ConversationManager;

  return {
    manager: fake,
    setSnapshot: (entries) => {
      snapshot = entries;
    },
    emitDelta: (entry) => {
      for (const cb of listeners) cb(entry);
    },
    listenerCount: () => listeners.size,
  };
}

function makeEntry(overrides: Partial<AgentStateEvent> = {}): AgentStateEvent {
  return {
    agentName: "alice",
    chatId: "c1",
    channelType: "telegram",
    state: "idle",
    sessionId: "sess-1",
    ts: "2026-04-13T12:00:00.000Z",
    ...overrides,
  };
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe("AgentStateStreamSource — snapshot()", () => {
  it("emits `agent_state.snapshot` with all current conversation entries", () => {
    const fake = makeFakeCM();
    const entries = [
      makeEntry({ agentName: "alice", chatId: "c1", state: "idle" }),
      makeEntry({ agentName: "bob", chatId: "c2", state: "busy" }),
    ];
    fake.setSnapshot(entries);

    const source = new AgentStateStreamSource(fake.manager);
    const frame = source.snapshot();

    expect(frame.event).toBe("agent_state.snapshot");
    expect(frame.data.kind).toBe("snapshot");
    if (frame.data.kind !== "snapshot") throw new Error("unreachable");
    expect(frame.data.entries).toEqual(entries);
  });

  it("returns an empty-entries snapshot when no conversations are active", () => {
    const fake = makeFakeCM();
    const source = new AgentStateStreamSource(fake.manager);
    const frame = source.snapshot();
    if (frame.data.kind !== "snapshot") throw new Error("unreachable");
    expect(frame.data.entries).toEqual([]);
  });
});

describe("AgentStateStreamSource — delta fan-out", () => {
  it("emits `agent_state.delta` to every subscriber on each transition", () => {
    const fake = makeFakeCM();
    const source = new AgentStateStreamSource(fake.manager);

    const received: SseFrame<AgentStateFrameData>[][] = [[], []];
    source.subscribe((f) => received[0].push(f));
    source.subscribe((f) => received[1].push(f));

    const entry = makeEntry({ state: "busy" });
    fake.emitDelta(entry);

    for (const inbox of received) {
      expect(inbox).toHaveLength(1);
      expect(inbox[0].event).toBe("agent_state.delta");
      expect(inbox[0].data.kind).toBe("delta");
      if (inbox[0].data.kind !== "delta") throw new Error("unreachable");
      expect(inbox[0].data.entry).toEqual(entry);
    }
  });

  it("skips work entirely when there are zero subscribers", () => {
    // The source guards on `clients.size === 0` and returns without
    // building a frame. Emitting with no subscribers must not throw.
    const fake = makeFakeCM();
    new AgentStateStreamSource(fake.manager);
    expect(() => fake.emitDelta(makeEntry())).not.toThrow();
  });

  it("a throwing client does NOT break delivery to sibling clients", () => {
    const fake = makeFakeCM();
    const source = new AgentStateStreamSource(fake.manager);

    let goodCalls = 0;
    source.subscribe(() => {
      throw new Error("boom");
    });
    source.subscribe(() => {
      goodCalls++;
    });

    expect(() => fake.emitDelta(makeEntry())).not.toThrow();
    expect(goodCalls).toBe(1);
  });

  it("iterates over a client snapshot so mid-fanout unsubscribe is safe", () => {
    const fake = makeFakeCM();
    const source = new AgentStateStreamSource(fake.manager);

    let bCalls = 0;
    let unsubA: (() => void) | null = null;
    unsubA = source.subscribe(() => {
      unsubA?.();
    });
    source.subscribe(() => {
      bCalls++;
    });

    fake.emitDelta(makeEntry());
    expect(bCalls).toBe(1);
    expect(source.getClientCount()).toBe(1);
  });
});

describe("AgentStateStreamSource — lifecycle", () => {
  it("subscribes to ConversationManager.onStateChange at construction", () => {
    const fake = makeFakeCM();
    new AgentStateStreamSource(fake.manager);
    expect(fake.listenerCount()).toBe(1);
  });

  it("getClientCount tracks subscribe/unsubscribe", () => {
    const source = new AgentStateStreamSource(makeFakeCM().manager);
    expect(source.getClientCount()).toBe(0);

    const unsubA = source.subscribe(() => {});
    const unsubB = source.subscribe(() => {});
    expect(source.getClientCount()).toBe(2);

    unsubA();
    unsubB();
    expect(source.getClientCount()).toBe(0);
  });

  it("dispose() unsubscribes from the upstream manager AND drops clients", () => {
    const fake = makeFakeCM();
    const source = new AgentStateStreamSource(fake.manager);
    source.subscribe(() => {});
    source.subscribe(() => {});
    expect(fake.listenerCount()).toBe(1);

    source.dispose();

    expect(source.getClientCount()).toBe(0);
    expect(fake.listenerCount()).toBe(0);
  });
});
