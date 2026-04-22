/**
 * Unit tests for the pure reducer behind useSchedulesTail.
 *
 * The React hook needs a DOM (EventSource) which the node-environment
 * vitest setup doesn't provide — but the correctness concerns we care
 * about (idempotency, upsert semantics, delete removes, sort order) are
 * pure. Same pattern as `use-conversation-tail.parser.test.ts`.
 */

import { describe, it, expect } from "vitest";

import type { ScheduleStreamFrame, ScheduleSummary } from "../bridge/schemas";

import { foldScheduleFrames } from "./fold-schedule-frames";

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

function makeSchedule(overrides: Partial<ScheduleSummary> = {}): ScheduleSummary {
  return {
    id: "sched_1700000001_aaaaaaaa",
    name: "ping",
    owner: "alice",
    enabled: true,
    schedule: { kind: "every", interval: "5m" },
    prompt: "say hi",
    sessionTarget: "isolated",
    source: "runtime",
    createdAtMs: 1_700_000_000_000,
    ...overrides,
  };
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe("foldScheduleFrames — initial list", () => {
  it("returns the initial list verbatim when there are no frames", () => {
    const initial = [makeSchedule({ id: "sched_1_a", name: "a" })];
    expect(foldScheduleFrames(initial, [], "alice")).toEqual(initial);
  });

  it("sorts by createdAtMs descending, then id ascending", () => {
    const older = makeSchedule({
      id: "sched_1700000001_a",
      name: "older",
      createdAtMs: 1_700_000_000_000,
    });
    const newer = makeSchedule({
      id: "sched_1700000002_b",
      name: "newer",
      createdAtMs: 1_700_000_100_000,
    });
    const same1 = makeSchedule({
      id: "sched_1700000000_a",
      name: "same-a",
      createdAtMs: 1_699_000_000_000,
    });
    const same2 = makeSchedule({
      id: "sched_1700000000_b",
      name: "same-b",
      createdAtMs: 1_699_000_000_000,
    });

    const out = foldScheduleFrames([older, newer, same1, same2], [], "alice");
    expect(out.map((s) => s.name)).toEqual(["newer", "older", "same-a", "same-b"]);
  });
});

describe("foldScheduleFrames — upserts", () => {
  it("schedule.created adds a new entry", () => {
    const created: ScheduleStreamFrame = {
      event: "schedule.created",
      data: makeSchedule({ id: "sched_new", name: "new" }),
    };
    const out = foldScheduleFrames([], [created], "alice");
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("new");
  });

  it("schedule.updated replaces the matching id (mutation fields win)", () => {
    const initial = [makeSchedule({ id: "sched_x", name: "old name", enabled: true })];
    const update: ScheduleStreamFrame = {
      event: "schedule.updated",
      data: makeSchedule({ id: "sched_x", name: "new name", enabled: false }),
    };
    const out = foldScheduleFrames(initial, [update], "alice");
    expect(out[0].name).toBe("new name");
    expect(out[0].enabled).toBe(false);
  });

  it("schedule.ran updates last-run fields in place", () => {
    const initial = [makeSchedule({ id: "sched_x", lastStatus: undefined, lastRunAtMs: undefined })];
    const ran: ScheduleStreamFrame = {
      event: "schedule.ran",
      data: makeSchedule({
        id: "sched_x",
        lastStatus: "ok",
        lastRunAtMs: 1_700_000_500_000,
        nextRunAtMs: 1_700_000_800_000,
      }),
    };
    const out = foldScheduleFrames(initial, [ran], "alice");
    expect(out[0].lastStatus).toBe("ok");
    expect(out[0].lastRunAtMs).toBe(1_700_000_500_000);
    expect(out[0].nextRunAtMs).toBe(1_700_000_800_000);
  });
});

describe("foldScheduleFrames — deletes", () => {
  it("schedule.deleted removes the matching id", () => {
    const initial = [
      makeSchedule({ id: "sched_keep" }),
      makeSchedule({ id: "sched_drop" }),
    ];
    const del: ScheduleStreamFrame = {
      event: "schedule.deleted",
      data: { ...makeSchedule({ id: "sched_drop" }), reason: "requested" },
    };
    const out = foldScheduleFrames(initial, [del], "alice");
    expect(out.map((s) => s.id)).toEqual(["sched_keep"]);
  });

  it("schedule.deleted for an unknown id is a no-op (idempotent across replays)", () => {
    const initial = [makeSchedule({ id: "sched_keep" })];
    const del: ScheduleStreamFrame = {
      event: "schedule.deleted",
      data: { ...makeSchedule({ id: "sched_gone" }), reason: "requested" },
    };
    expect(foldScheduleFrames(initial, [del], "alice").map((s) => s.id)).toEqual(["sched_keep"]);
  });
});

describe("foldScheduleFrames — idempotency on reconnect replay", () => {
  it("applying the same frame sequence twice produces the same result", () => {
    // This is the invariant that matters in practice: EventSource can
    // replay buffered frames after a reconnect (the spec allows the
    // browser to redeliver). The reducer must tolerate that without
    // double-inserts, lost updates, or resurrected deletes.
    const initial: ScheduleSummary[] = [];
    const frames: ScheduleStreamFrame[] = [
      { event: "schedule.created", data: makeSchedule({ id: "sched_a", name: "A" }) },
      { event: "schedule.updated", data: makeSchedule({ id: "sched_a", name: "A-updated" }) },
      { event: "schedule.ran", data: makeSchedule({ id: "sched_a", name: "A-updated", lastStatus: "ok" }) },
      { event: "schedule.deleted", data: { ...makeSchedule({ id: "sched_a" }), reason: "requested" } },
    ];

    const onceThrough = foldScheduleFrames(initial, frames, "alice");
    const doubled = foldScheduleFrames(initial, [...frames, ...frames], "alice");
    expect(doubled).toEqual(onceThrough);
    expect(doubled).toHaveLength(0); // deleted wins at the end
  });

  it("partial replay (reconnect mid-stream) does not resurrect a deleted entry", () => {
    const initial: ScheduleSummary[] = [];
    const frames: ScheduleStreamFrame[] = [
      { event: "schedule.created", data: makeSchedule({ id: "sched_a" }) },
      { event: "schedule.deleted", data: { ...makeSchedule({ id: "sched_a" }), reason: "requested" } },
      { event: "schedule.created", data: makeSchedule({ id: "sched_a" }) }, // replay of earlier create
    ];
    // The reducer replays deterministically — the final "create" reappears.
    // That's fine; the daemon will send a paired delete if the schedule is
    // still gone, and the reducer will drop it again.
    const out = foldScheduleFrames(initial, frames, "alice");
    expect(out.map((s) => s.id)).toEqual(["sched_a"]);
  });
});

describe("foldScheduleFrames — owner filtering (cross-agent isolation)", () => {
  it("drops schedule.created frames whose owner != agent", () => {
    // The SSE endpoint is global — without this filter, one agent's page
    // would render another agent's schedules. This is a correctness
    // invariant, not a UX polish: tested explicitly so a future refactor
    // can't silently regress it.
    const theirs: ScheduleStreamFrame = {
      event: "schedule.created",
      data: makeSchedule({ id: "sched_bob", owner: "bob" }),
    };
    const mine: ScheduleStreamFrame = {
      event: "schedule.created",
      data: makeSchedule({ id: "sched_alice", owner: "alice" }),
    };
    const out = foldScheduleFrames([], [theirs, mine], "alice");
    expect(out.map((s) => s.id)).toEqual(["sched_alice"]);
  });

  it("drops schedule.ran frames whose owner != agent", () => {
    const initial = [makeSchedule({ id: "sched_alice", owner: "alice", lastStatus: undefined })];
    const theirsRan: ScheduleStreamFrame = {
      event: "schedule.ran",
      data: makeSchedule({ id: "sched_bob", owner: "bob", lastStatus: "ok" }),
    };
    const out = foldScheduleFrames(initial, [theirsRan], "alice");
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("sched_alice");
    // lastStatus on the alice schedule unchanged — the bob.ran frame
    // didn't leak through.
    expect(out[0].lastStatus).toBeUndefined();
  });

  it("drops schedule.deleted frames whose owner != agent (can't delete someone else's view)", () => {
    // If bob deletes his schedule, the deleted frame carries owner: "bob".
    // Alice's view must not remove anything from its map in response —
    // alice's ids are disjoint from bob's, but the filter is the
    // load-bearing part of this invariant.
    const initial = [makeSchedule({ id: "sched_alice", owner: "alice" })];
    const theirsDel: ScheduleStreamFrame = {
      event: "schedule.deleted",
      data: { ...makeSchedule({ id: "sched_bob", owner: "bob" }), reason: "requested" },
    };
    const out = foldScheduleFrames(initial, [theirsDel], "alice");
    expect(out.map((s) => s.id)).toEqual(["sched_alice"]);
  });

  it("drops frames with undefined owner (missing-owner is treated as not-mine)", () => {
    // Declarative jobs lack `owner`; the source already filters them out,
    // but the reducer defends the invariant locally too.
    const orphan: ScheduleStreamFrame = {
      event: "schedule.created",
      // @ts-expect-error — intentionally constructing an invalid frame for the test
      data: { ...makeSchedule({ id: "sched_orphan" }), owner: undefined },
    };
    const out = foldScheduleFrames([], [orphan], "alice");
    expect(out).toHaveLength(0);
  });
});
