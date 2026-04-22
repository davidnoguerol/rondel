/**
 * Unit tests for MultiplexStreamSource.
 *
 * Scope: topic tagging on fan-out, subscribe/dispose lifecycle, per-client
 * error boundary, unsubscribe-during-fan-out safety, buildReplay snapshot
 * aggregation, and correct disposal of upstream source subscriptions.
 *
 * Strategy: fake each component source as the minimum surface the
 * multiplex consumes. Avoids pulling in real services (heartbeat, task,
 * schedule, etc.) — the wiring in the multiplex is what's under test, not
 * the individual sources.
 */

import { describe, it, expect, vi } from "vitest";

import {
  MULTIPLEX_EVENT,
  MultiplexStreamSource,
  type MultiplexedFrameData,
  type MultiplexStreamSources,
} from "./multiplex-stream.js";
import type { SseFrame } from "./sse-types.js";
import type { AgentStateFrameData, AgentStateStreamSource } from "./agent-state-stream.js";
import type { ApprovalStreamSource } from "./approval-stream.js";
import type { HeartbeatFrameData, HeartbeatStreamSource } from "./heartbeat-stream.js";
import type { LedgerStreamSource } from "./ledger-stream.js";
import type { ScheduleFramePayload, ScheduleStreamSource } from "./schedule-stream.js";
import type { TaskFrameData, TaskStreamSource } from "./task-stream.js";
import type { ApprovalRecord } from "../shared/types/approvals.js";
import type { LedgerEvent } from "../ledger/ledger-types.js";

// -----------------------------------------------------------------------------
// Fakes — one per component source
// -----------------------------------------------------------------------------

interface FakeSource<T> {
  subscribe(send: (frame: SseFrame<T>) => void): () => void;
  emit(frame: SseFrame<T>): void;
  subscriberCount(): number;
}

function makeFake<T>(): FakeSource<T> {
  const subs = new Set<(frame: SseFrame<T>) => void>();
  return {
    subscribe(send) {
      subs.add(send);
      return () => {
        subs.delete(send);
      };
    },
    emit(frame) {
      for (const s of [...subs]) s(frame);
    },
    subscriberCount: () => subs.size,
  };
}

interface Fakes {
  approvals: FakeSource<ApprovalRecord>;
  agentsState: FakeSource<AgentStateFrameData>;
  tasks: FakeSource<TaskFrameData>;
  ledger: FakeSource<LedgerEvent>;
  schedules: FakeSource<ScheduleFramePayload>;
  heartbeats: FakeSource<HeartbeatFrameData>;
  sources: MultiplexStreamSources;
}

function makeFakes(overrides: {
  agentsStateSnapshot?: SseFrame<AgentStateFrameData>;
  tasksSnapshot?: (caller: { agentName: string; isAdmin: boolean }) => Promise<SseFrame<TaskFrameData>>;
  heartbeatsSnapshot?: () => Promise<SseFrame<HeartbeatFrameData>>;
} = {}): Fakes {
  const approvals = makeFake<ApprovalRecord>();
  const agentsState = makeFake<AgentStateFrameData>();
  const tasks = makeFake<TaskFrameData>();
  const ledger = makeFake<LedgerEvent>();
  const schedules = makeFake<ScheduleFramePayload>();
  const heartbeats = makeFake<HeartbeatFrameData>();

  // Shape-match the StreamSource surface the multiplex actually calls.
  // Only `subscribe` is touched for fan-out; `snapshot` (sync) and
  // `asyncSnapshot` are read by `buildReplay`. We deliberately cast the
  // minimal shapes to the source class types — the multiplex doesn't
  // touch dispose() on the components (orchestrator owns that).
  const sources: MultiplexStreamSources = {
    approvals: { subscribe: approvals.subscribe } as unknown as ApprovalStreamSource,
    agentsState: {
      subscribe: agentsState.subscribe,
      snapshot: () =>
        overrides.agentsStateSnapshot ?? {
          event: "agent_state.snapshot",
          data: { kind: "snapshot", entries: [] },
        },
    } as unknown as AgentStateStreamSource,
    tasks: {
      subscribe: tasks.subscribe,
      asyncSnapshot:
        overrides.tasksSnapshot ??
        (async () => ({
          event: "task.snapshot",
          data: { kind: "snapshot", entries: [] },
        })),
    } as unknown as TaskStreamSource,
    ledger: { subscribe: ledger.subscribe } as unknown as LedgerStreamSource,
    schedules: { subscribe: schedules.subscribe } as unknown as ScheduleStreamSource,
    heartbeats: {
      subscribe: heartbeats.subscribe,
      asyncSnapshot:
        overrides.heartbeatsSnapshot ??
        (async () => ({
          event: "heartbeat.snapshot",
          data: { kind: "snapshot", entries: [] },
        })),
    } as unknown as HeartbeatStreamSource,
  };

  return { approvals, agentsState, tasks, ledger, schedules, heartbeats, sources };
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe("MultiplexStreamSource — construction", () => {
  it("subscribes to every component source on construction", () => {
    const fakes = makeFakes();
    new MultiplexStreamSource(fakes.sources);

    expect(fakes.approvals.subscriberCount()).toBe(1);
    expect(fakes.agentsState.subscriberCount()).toBe(1);
    expect(fakes.tasks.subscriberCount()).toBe(1);
    expect(fakes.ledger.subscriberCount()).toBe(1);
    expect(fakes.schedules.subscriberCount()).toBe(1);
    expect(fakes.heartbeats.subscriberCount()).toBe(1);
  });

  it("dispose unsubscribes from every component source", () => {
    const fakes = makeFakes();
    const mux = new MultiplexStreamSource(fakes.sources);
    mux.dispose();

    expect(fakes.approvals.subscriberCount()).toBe(0);
    expect(fakes.agentsState.subscriberCount()).toBe(0);
    expect(fakes.tasks.subscriberCount()).toBe(0);
    expect(fakes.ledger.subscriberCount()).toBe(0);
    expect(fakes.schedules.subscriberCount()).toBe(0);
    expect(fakes.heartbeats.subscriberCount()).toBe(0);
  });
});

describe("MultiplexStreamSource — fan-out tagging", () => {
  it("tags approval frames with topic=approvals", () => {
    const fakes = makeFakes();
    const mux = new MultiplexStreamSource(fakes.sources);
    const received: SseFrame<MultiplexedFrameData>[] = [];
    mux.subscribe((f) => received.push(f));

    const payload: ApprovalRecord = { requestId: "x" } as unknown as ApprovalRecord;
    fakes.approvals.emit({ event: "approval.requested", data: payload });

    expect(received).toHaveLength(1);
    expect(received[0].event).toBe(MULTIPLEX_EVENT);
    expect(received[0].data.topic).toBe("approvals");
    expect(received[0].data.frame).toEqual({ event: "approval.requested", data: payload });
  });

  it("tags ledger frames with topic=ledger", () => {
    const fakes = makeFakes();
    const mux = new MultiplexStreamSource(fakes.sources);
    const received: SseFrame<MultiplexedFrameData>[] = [];
    mux.subscribe((f) => received.push(f));

    fakes.ledger.emit({
      event: "ledger.appended",
      data: { id: "e1" } as unknown as LedgerEvent,
    });

    expect(received[0].data.topic).toBe("ledger");
    expect(received[0].data.frame.event).toBe("ledger.appended");
  });

  it("passes each source's frames through with the correct topic", () => {
    const fakes = makeFakes();
    const mux = new MultiplexStreamSource(fakes.sources);
    const received: SseFrame<MultiplexedFrameData>[] = [];
    mux.subscribe((f) => received.push(f));

    fakes.approvals.emit({
      event: "approval.requested",
      data: {} as unknown as ApprovalRecord,
    });
    fakes.agentsState.emit({
      event: "agent_state.delta",
      data: { kind: "delta", entry: { agentName: "a" } } as unknown as AgentStateFrameData,
    });
    fakes.tasks.emit({
      event: "task.delta",
      data: { kind: "delta", entry: {}, event: "created" } as unknown as TaskFrameData,
    });
    fakes.schedules.emit({
      event: "schedule.created",
      data: {} as unknown as ScheduleFramePayload,
    });
    fakes.heartbeats.emit({
      event: "heartbeat.delta",
      data: { kind: "delta", entry: {} } as unknown as HeartbeatFrameData,
    });

    expect(received.map((f) => f.data.topic)).toEqual([
      "approvals",
      "agents-state",
      "tasks",
      "schedules",
      "heartbeats",
    ]);
  });
});

describe("MultiplexStreamSource — client lifecycle", () => {
  it("no fan-out when there are no clients — avoids useless work", () => {
    const fakes = makeFakes();
    new MultiplexStreamSource(fakes.sources);
    // No subscriber attached. Emitting should be a no-op (no throw).
    fakes.approvals.emit({
      event: "approval.requested",
      data: {} as unknown as ApprovalRecord,
    });
  });

  it("getClientCount tracks connected subscribers", () => {
    const fakes = makeFakes();
    const mux = new MultiplexStreamSource(fakes.sources);
    expect(mux.getClientCount()).toBe(0);

    const unsub1 = mux.subscribe(() => {});
    const unsub2 = mux.subscribe(() => {});
    expect(mux.getClientCount()).toBe(2);

    unsub1();
    expect(mux.getClientCount()).toBe(1);
    unsub2();
    expect(mux.getClientCount()).toBe(0);
  });

  it("a throwing client does not break other clients", () => {
    const fakes = makeFakes();
    const mux = new MultiplexStreamSource(fakes.sources);
    const bad = vi.fn(() => {
      throw new Error("boom");
    });
    const good: SseFrame<MultiplexedFrameData>[] = [];
    mux.subscribe(bad);
    mux.subscribe((f) => good.push(f));

    fakes.approvals.emit({
      event: "approval.requested",
      data: {} as unknown as ApprovalRecord,
    });

    expect(bad).toHaveBeenCalledTimes(1);
    expect(good).toHaveLength(1);
  });

  it("unsubscribe during fan-out does not invalidate the iterator", () => {
    const fakes = makeFakes();
    const mux = new MultiplexStreamSource(fakes.sources);
    let unsubSelf: (() => void) | null = null;
    const received: SseFrame<MultiplexedFrameData>[] = [];
    unsubSelf = mux.subscribe(() => unsubSelf?.());
    mux.subscribe((f) => received.push(f));

    fakes.tasks.emit({
      event: "task.delta",
      data: { kind: "delta", entry: {}, event: "created" } as unknown as TaskFrameData,
    });

    expect(received).toHaveLength(1);
  });

  it("after dispose, source emissions do not reach clients", () => {
    const fakes = makeFakes();
    const mux = new MultiplexStreamSource(fakes.sources);
    const received: unknown[] = [];
    mux.subscribe((f) => received.push(f));

    mux.dispose();
    fakes.approvals.emit({
      event: "approval.requested",
      data: {} as unknown as ApprovalRecord,
    });

    expect(received).toEqual([]);
  });
});

describe("MultiplexStreamSource — buildReplay", () => {
  it("emits a snapshot frame for agents-state, heartbeats, and tasks only", async () => {
    const agentsSnap: SseFrame<AgentStateFrameData> = {
      event: "agent_state.snapshot",
      data: { kind: "snapshot", entries: [] },
    };
    const heartbeatsSnap: SseFrame<HeartbeatFrameData> = {
      event: "heartbeat.snapshot",
      data: { kind: "snapshot", entries: [] },
    };
    const tasksSnap: SseFrame<TaskFrameData> = {
      event: "task.snapshot",
      data: { kind: "snapshot", entries: [] },
    };

    const fakes = makeFakes({
      agentsStateSnapshot: agentsSnap,
      heartbeatsSnapshot: async () => heartbeatsSnap,
      tasksSnapshot: async () => tasksSnap,
    });

    const mux = new MultiplexStreamSource(fakes.sources);
    const replay = mux.buildReplay({ agentName: "web", isAdmin: true });

    const emitted: SseFrame<MultiplexedFrameData>[] = [];
    await replay((f) => emitted.push(f));

    expect(emitted).toHaveLength(3);
    expect(emitted.map((f) => f.data.topic)).toEqual([
      "agents-state",
      "heartbeats",
      "tasks",
    ]);
    expect(emitted[0].data.frame).toEqual(agentsSnap);
    expect(emitted[1].data.frame).toEqual(heartbeatsSnap);
    expect(emitted[2].data.frame).toEqual(tasksSnap);
  });

  it("passes the caller into tasks asyncSnapshot", async () => {
    const taskSnapshot = vi.fn(async () => ({
      event: "task.snapshot",
      data: { kind: "snapshot" as const, entries: [] },
    }));
    const fakes = makeFakes({ tasksSnapshot: taskSnapshot });
    const mux = new MultiplexStreamSource(fakes.sources);

    const replay = mux.buildReplay({ agentName: "operator", isAdmin: true });
    await replay(() => {});

    expect(taskSnapshot).toHaveBeenCalledWith({ agentName: "operator", isAdmin: true });
  });

  it("swallows snapshot errors so one bad topic does not kill the stream", async () => {
    // Critical contract: if heartbeats (or tasks) snapshot throws, the
    // stream MUST NOT abort — otherwise handleSseRequest's prefix-phase
    // catch fires `cleanup()`, the response ends, the browser
    // EventSource reconnects after 3 s, hits the same error, and the UI
    // shows "Connecting" forever. See use-stream-topic regression that
    // surfaced this with the loopback `callerAgent: "web"` against
    // TaskService.list (which throws `unknown_agent`).
    const taskSnap: SseFrame<TaskFrameData> = {
      event: "task.snapshot",
      data: { kind: "snapshot", entries: [] },
    };
    const fakes = makeFakes({
      heartbeatsSnapshot: async () => {
        throw new Error("disk read failed");
      },
      tasksSnapshot: async () => taskSnap,
    });
    const mux = new MultiplexStreamSource(fakes.sources);
    const replay = mux.buildReplay({ agentName: "web", isAdmin: true });

    const emitted: SseFrame<MultiplexedFrameData>[] = [];
    await expect(replay((f) => emitted.push(f))).resolves.toBeUndefined();

    // agents-state and tasks should still be delivered; heartbeats is dropped.
    expect(emitted.map((f) => f.data.topic)).toEqual(["agents-state", "tasks"]);
  });
});
