/**
 * Unit tests for ScheduleStreamSource.
 *
 * Scope: fan-out semantics, per-client error isolation, declarative-job
 * filtering, and hook unsubscribe on dispose. A hand-faked RondelHooks
 * with just `on`/`off`/`emit` lets us drive the stream without the full
 * scheduling stack, and a stub snapshot lookup verifies `summarize` is
 * called with the right inputs for each frame kind.
 *
 * Out of scope: the SSE wire format is covered in sse-handler tests and
 * the schedule summarizer itself has no standalone test (it's a pure
 * projection of inputs — covered implicitly here and in integration).
 */

import { describe, it, expect } from "vitest";

import { RondelHooks } from "../shared/hooks.js";
import type { CronJob, CronJobState } from "../shared/types/index.js";

import { ScheduleStreamSource, type ScheduleFramePayload } from "./schedule-stream.js";
import type { ScheduleSnapshotLookup } from "./schedule-stream.js";
import type { SseFrame } from "./sse-types.js";

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

function makeJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: "sched_1700000000_deadbeef",
    name: "ping",
    schedule: { kind: "every", interval: "5m" },
    prompt: "say hi",
    source: "runtime",
    owner: "alice",
    createdAtMs: 1_700_000_000_000,
    ...overrides,
  };
}

function makeState(overrides: Partial<CronJobState> = {}): CronJobState {
  return {
    consecutiveErrors: 0,
    ...overrides,
  };
}

/**
 * Snapshot lookup that returns the same stub for any job id. The stream
 * source calls this on created/updated frames — `ran` frames use the
 * fresh state from the hook payload and ignore this, `deleted` frames
 * pass `undefined` through.
 */
function makeLookup(snapshot?: CronJobState): ScheduleSnapshotLookup {
  return {
    getJobStateSnapshot: () => (snapshot ? { ...snapshot } : undefined),
  };
}

// -----------------------------------------------------------------------------
// Subscription lifecycle
// -----------------------------------------------------------------------------

describe("ScheduleStreamSource — subscription lifecycle", () => {
  it("subscribes to all four schedule hooks at construction", () => {
    const hooks = new RondelHooks();
    new ScheduleStreamSource(hooks, makeLookup());

    expect(hooks.listenerCount("schedule:created")).toBe(1);
    expect(hooks.listenerCount("schedule:updated")).toBe(1);
    expect(hooks.listenerCount("schedule:deleted")).toBe(1);
    expect(hooks.listenerCount("schedule:ran")).toBe(1);
  });

  it("getClientCount reflects subscribe/unsubscribe", () => {
    const source = new ScheduleStreamSource(new RondelHooks(), makeLookup());
    expect(source.getClientCount()).toBe(0);

    const unsubA = source.subscribe(() => {});
    const unsubB = source.subscribe(() => {});
    expect(source.getClientCount()).toBe(2);

    unsubA();
    expect(source.getClientCount()).toBe(1);
    unsubB();
    expect(source.getClientCount()).toBe(0);
  });

  it("dispose() clears clients AND unsubscribes from every hook", () => {
    const hooks = new RondelHooks();
    const source = new ScheduleStreamSource(hooks, makeLookup());
    source.subscribe(() => {});
    source.subscribe(() => {});

    source.dispose();

    expect(source.getClientCount()).toBe(0);
    expect(hooks.listenerCount("schedule:created")).toBe(0);
    expect(hooks.listenerCount("schedule:updated")).toBe(0);
    expect(hooks.listenerCount("schedule:deleted")).toBe(0);
    expect(hooks.listenerCount("schedule:ran")).toBe(0);
  });
});

// -----------------------------------------------------------------------------
// Fan-out semantics
// -----------------------------------------------------------------------------

describe("ScheduleStreamSource — fan-out", () => {
  it("emits `schedule.created` with a summary to every subscriber", () => {
    const hooks = new RondelHooks();
    const snapshot = makeState({ nextRunAtMs: 1_700_000_300_000 });
    const source = new ScheduleStreamSource(hooks, makeLookup(snapshot));

    const received: SseFrame<ScheduleFramePayload>[][] = [[], []];
    source.subscribe((f) => received[0].push(f));
    source.subscribe((f) => received[1].push(f));

    hooks.emit("schedule:created", { job: makeJob() });

    for (const inbox of received) {
      expect(inbox).toHaveLength(1);
      expect(inbox[0].event).toBe("schedule.created");
      expect(inbox[0].data.id).toBe("sched_1700000000_deadbeef");
      expect(inbox[0].data.nextRunAtMs).toBe(snapshot.nextRunAtMs);
    }
  });

  it("`schedule.ran` uses the fresh state from the hook payload, not the snapshot", () => {
    // Snapshot lookup returns stale state; the event payload carries the
    // authoritative post-run state. The stream must prefer the latter.
    const hooks = new RondelHooks();
    const staleSnapshot = makeState({ lastStatus: "error", lastRunAtMs: 1 });
    const source = new ScheduleStreamSource(hooks, makeLookup(staleSnapshot));

    let captured: ScheduleFramePayload | null = null;
    source.subscribe((f) => {
      captured = f.data;
    });

    const freshState = makeState({ lastStatus: "ok", lastRunAtMs: 42, nextRunAtMs: 100 });
    hooks.emit("schedule:ran", { job: makeJob(), state: freshState });

    expect(captured).not.toBeNull();
    expect(captured!.lastStatus).toBe("ok");
    expect(captured!.lastRunAtMs).toBe(42);
    expect(captured!.nextRunAtMs).toBe(100);
  });

  it("`schedule.deleted` carries the reason alongside the summary", () => {
    const hooks = new RondelHooks();
    const source = new ScheduleStreamSource(hooks, makeLookup());

    let captured: SseFrame<ScheduleFramePayload> | null = null;
    source.subscribe((f) => {
      captured = f;
    });

    hooks.emit("schedule:deleted", { job: makeJob(), reason: "ran_once" });

    expect(captured).not.toBeNull();
    expect(captured!.event).toBe("schedule.deleted");
    const data = captured!.data as ScheduleFramePayload & { reason: string };
    expect(data.reason).toBe("ran_once");
    expect(data.id).toBe("sched_1700000000_deadbeef");
  });

  it("declarative jobs do NOT produce frames (runtime-only UI surface)", () => {
    const hooks = new RondelHooks();
    const source = new ScheduleStreamSource(hooks, makeLookup());

    let calls = 0;
    source.subscribe(() => {
      calls++;
    });

    hooks.emit("schedule:created", { job: makeJob({ source: "declarative" }) });
    hooks.emit("schedule:ran", { job: makeJob({ source: "declarative" }), state: makeState() });
    hooks.emit("schedule:deleted", {
      job: makeJob({ source: "declarative" }),
      reason: "requested",
    });

    expect(calls).toBe(0);
  });

  it("skips work entirely when there are zero subscribers", () => {
    const hooks = new RondelHooks();
    new ScheduleStreamSource(hooks, makeLookup());

    expect(() =>
      hooks.emit("schedule:created", { job: makeJob() }),
    ).not.toThrow();
  });

  it("a throwing client does NOT break delivery to sibling clients", () => {
    const hooks = new RondelHooks();
    const source = new ScheduleStreamSource(hooks, makeLookup());

    let goodCalls = 0;
    source.subscribe(() => {
      throw new Error("boom");
    });
    source.subscribe(() => {
      goodCalls++;
    });

    hooks.emit("schedule:created", { job: makeJob() });
    expect(goodCalls).toBe(1);
  });

  it("iterates a snapshot of clients so mid-fanout unsubscribe is safe", () => {
    const hooks = new RondelHooks();
    const source = new ScheduleStreamSource(hooks, makeLookup());

    let bCalls = 0;
    let unsubA: (() => void) | null = null;
    unsubA = source.subscribe(() => {
      unsubA?.();
    });
    source.subscribe(() => {
      bCalls++;
    });

    hooks.emit("schedule:created", { job: makeJob() });
    expect(bCalls).toBe(1);
    expect(source.getClientCount()).toBe(1);
  });
});
