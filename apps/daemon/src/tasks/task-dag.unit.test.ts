/**
 * Unit tests for the pure DAG helpers.
 *
 * No filesystem, no mocks — every test constructs data inline. Covers
 * every branch of `detectCycle`, `openBlockers`, `classifyStaleness`,
 * and `orderTasks` per design §13 "Unit".
 */

import { describe, it, expect } from "vitest";
import {
  BLOCKED_STALE_MS,
  IN_PROGRESS_STALE_MS,
  PENDING_STALE_MS,
  classifyStaleness,
  detectCycle,
  openBlockers,
  orderTasks,
  type DagPeer,
  type StalenessPeer,
  type StatusPeer,
} from "./task-dag.js";
import type { TaskRecord, TaskPriority, TaskStatus } from "../shared/types/tasks.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeTask(overrides: Partial<TaskRecord> & { id: string }): TaskRecord {
  return {
    version: 1,
    id: overrides.id,
    org: "global",
    title: "T",
    description: "",
    status: "pending",
    priority: "normal",
    createdBy: "alice",
    assignedTo: "alice",
    createdAt: "2026-04-20T12:00:00Z",
    updatedAt: "2026-04-20T12:00:00Z",
    blockedBy: [],
    blocks: [],
    externalAction: false,
    outputs: [],
    ...overrides,
  };
}

function peerMap<T extends { id: string }>(peers: readonly T[]): ReadonlyMap<string, T> {
  return new Map(peers.map((p) => [p.id, p]));
}

// ---------------------------------------------------------------------------
// detectCycle
// ---------------------------------------------------------------------------

describe("detectCycle", () => {
  it("returns null for the empty graph", () => {
    const peers = new Map<string, DagPeer>();
    expect(detectCycle({ id: "task_1_a", blockedBy: [] }, peers)).toBeNull();
  });

  it("detects a direct self-loop (A → A)", () => {
    const peers = peerMap<DagPeer>([]);
    const result = detectCycle({ id: "task_1_a", blockedBy: ["task_1_a"] }, peers);
    expect(result).not.toBeNull();
    expect(result!.cycle[0]).toBe("task_1_a");
    expect(result!.cycle[result!.cycle.length - 1]).toBe("task_1_a");
  });

  it("detects a two-node cycle (A → B → A)", () => {
    const peers = peerMap<DagPeer>([
      { id: "task_1_b", blockedBy: ["task_1_a"] },
    ]);
    const result = detectCycle({ id: "task_1_a", blockedBy: ["task_1_b"] }, peers);
    expect(result).not.toBeNull();
    expect(result!.cycle).toContain("task_1_a");
    expect(result!.cycle).toContain("task_1_b");
  });

  it("detects a three-node cycle (A → B → C → A)", () => {
    const peers = peerMap<DagPeer>([
      { id: "task_1_b", blockedBy: ["task_1_c"] },
      { id: "task_1_c", blockedBy: ["task_1_a"] },
    ]);
    const result = detectCycle({ id: "task_1_a", blockedBy: ["task_1_b"] }, peers);
    expect(result).not.toBeNull();
    expect(new Set(result!.cycle)).toEqual(new Set(["task_1_a", "task_1_b", "task_1_c"]));
  });

  it("returns null for an acyclic diamond (A → B, A → C, B → D, C → D)", () => {
    const peers = peerMap<DagPeer>([
      { id: "task_1_b", blockedBy: ["task_1_d"] },
      { id: "task_1_c", blockedBy: ["task_1_d"] },
      { id: "task_1_d", blockedBy: [] },
    ]);
    expect(detectCycle({ id: "task_1_a", blockedBy: ["task_1_b", "task_1_c"] }, peers)).toBeNull();
  });

  it("treats a missing peer as a leaf (no cycle)", () => {
    const peers = peerMap<DagPeer>([]);
    expect(detectCycle({ id: "task_1_a", blockedBy: ["task_1_missing"] }, peers)).toBeNull();
  });

  it("catches a cycle that only closes because the virtual task substitutes its own blockedBy", () => {
    // Peer says B depends on A, but A is being created with B in its blockedBy.
    const peers = peerMap<DagPeer>([
      { id: "task_1_b", blockedBy: ["task_1_a"] },
    ]);
    const result = detectCycle({ id: "task_1_a", blockedBy: ["task_1_b"] }, peers);
    expect(result).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// openBlockers
// ---------------------------------------------------------------------------

describe("openBlockers", () => {
  it("returns empty when all blockers are completed", () => {
    const peers = peerMap<StatusPeer>([
      { id: "task_1_a", status: "completed" },
      { id: "task_1_b", status: "completed" },
    ]);
    expect(openBlockers({ blockedBy: ["task_1_a", "task_1_b"] }, peers)).toEqual([]);
  });

  it("returns ids of blockers that are not yet completed", () => {
    const peers = peerMap<StatusPeer>([
      { id: "task_1_a", status: "completed" },
      { id: "task_1_b", status: "pending" },
      { id: "task_1_c", status: "in_progress" },
    ]);
    expect(openBlockers({ blockedBy: ["task_1_a", "task_1_b", "task_1_c"] }, peers)).toEqual([
      "task_1_b",
      "task_1_c",
    ]);
  });

  it("treats missing peers as open", () => {
    const peers = peerMap<StatusPeer>([]);
    expect(openBlockers({ blockedBy: ["task_1_missing"] }, peers)).toEqual(["task_1_missing"]);
  });

  it("returns empty when blockedBy is empty", () => {
    expect(openBlockers({ blockedBy: [] }, new Map())).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// classifyStaleness
// ---------------------------------------------------------------------------

describe("classifyStaleness", () => {
  const NOW = Date.parse("2026-04-20T12:00:00Z");

  it("returns fresh for terminal statuses regardless of age", () => {
    const completed = makeTask({
      id: "task_1_a",
      status: "completed",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    });
    const cancelled = makeTask({
      id: "task_1_b",
      status: "cancelled",
      createdAt: "2024-01-01T00:00:00Z",
    });
    expect(classifyStaleness(completed, NOW, new Map())).toBe("fresh");
    expect(classifyStaleness(cancelled, NOW, new Map())).toBe("fresh");
  });

  it("flags overdue when dueDate is in the past (higher priority than staleness)", () => {
    const task = makeTask({
      id: "task_1_a",
      status: "in_progress",
      claimedAt: new Date(NOW - 60_000).toISOString(),
      dueDate: new Date(NOW - 1_000).toISOString(),
    });
    expect(classifyStaleness(task, NOW, new Map())).toBe("overdue");
  });

  it("does not flag overdue for a completed task even with past dueDate", () => {
    const task = makeTask({
      id: "task_1_a",
      status: "completed",
      dueDate: "2020-01-01T00:00:00Z",
    });
    expect(classifyStaleness(task, NOW, new Map())).toBe("fresh");
  });

  it("flags stale_pending once pending age exceeds threshold", () => {
    const old = makeTask({
      id: "task_1_a",
      status: "pending",
      createdAt: new Date(NOW - PENDING_STALE_MS - 60_000).toISOString(),
    });
    const fresh = makeTask({
      id: "task_1_b",
      status: "pending",
      createdAt: new Date(NOW - 60_000).toISOString(),
    });
    expect(classifyStaleness(old, NOW, new Map())).toBe("stale_pending");
    expect(classifyStaleness(fresh, NOW, new Map())).toBe("fresh");
  });

  it("flags stale_in_progress against claimedAt, not createdAt", () => {
    const task = makeTask({
      id: "task_1_a",
      status: "in_progress",
      createdAt: "2020-01-01T00:00:00Z",
      claimedAt: new Date(NOW - 60_000).toISOString(),
    });
    expect(classifyStaleness(task, NOW, new Map())).toBe("fresh");
  });

  it("flags stale_in_progress once in_progress age exceeds threshold", () => {
    const task = makeTask({
      id: "task_1_a",
      status: "in_progress",
      claimedAt: new Date(NOW - IN_PROGRESS_STALE_MS - 60_000).toISOString(),
    });
    expect(classifyStaleness(task, NOW, new Map())).toBe("stale_in_progress");
  });

  it("flags blocked_unblockable when all deps completed > BLOCKED_STALE_MS ago", () => {
    const peers = peerMap<StalenessPeer>([
      {
        id: "task_1_a",
        status: "completed",
        updatedAt: "2026-04-20T00:00:00Z",
        completedAt: new Date(NOW - BLOCKED_STALE_MS - 60_000).toISOString(),
      },
    ]);
    const task = makeTask({
      id: "task_1_b",
      status: "blocked",
      blockedBy: ["task_1_a"],
      updatedAt: "2026-04-20T00:00:00Z",
    });
    expect(classifyStaleness(task, NOW, peers)).toBe("blocked_unblockable");
  });

  it("leaves blocked task fresh when a dep is still incomplete", () => {
    const peers = peerMap<StalenessPeer>([
      {
        id: "task_1_a",
        status: "pending",
        updatedAt: "2026-04-20T00:00:00Z",
      },
    ]);
    const task = makeTask({
      id: "task_1_b",
      status: "blocked",
      blockedBy: ["task_1_a"],
      updatedAt: "2026-04-20T00:00:00Z",
    });
    expect(classifyStaleness(task, NOW, peers)).toBe("fresh");
  });

  it("leaves blocked task fresh when all deps completed recently", () => {
    const peers = peerMap<StalenessPeer>([
      {
        id: "task_1_a",
        status: "completed",
        updatedAt: "2026-04-20T00:00:00Z",
        completedAt: new Date(NOW - 60_000).toISOString(),
      },
    ]);
    const task = makeTask({
      id: "task_1_b",
      status: "blocked",
      blockedBy: ["task_1_a"],
      updatedAt: "2026-04-20T00:00:00Z",
    });
    expect(classifyStaleness(task, NOW, peers)).toBe("fresh");
  });
});

// ---------------------------------------------------------------------------
// orderTasks
// ---------------------------------------------------------------------------

describe("orderTasks", () => {
  it("places unblocked tasks before blocked ones", () => {
    const peers = peerMap<StatusPeer>([
      { id: "task_1_dep", status: "pending" },
    ]);
    const tasks: TaskRecord[] = [
      makeTask({ id: "task_1_blocked", blockedBy: ["task_1_dep"], priority: "urgent" }),
      makeTask({ id: "task_1_unblocked", priority: "low" }),
    ];
    const ordered = orderTasks(tasks, peers);
    expect(ordered.map((t) => t.id)).toEqual(["task_1_unblocked", "task_1_blocked"]);
  });

  it("sorts within each partition by priority rank", () => {
    const tasks: TaskRecord[] = [
      makeTask({ id: "task_1_c", priority: "low" }),
      makeTask({ id: "task_1_a", priority: "urgent" }),
      makeTask({ id: "task_1_b", priority: "normal" }),
    ];
    const ordered = orderTasks(tasks, new Map());
    expect(ordered.map((t) => t.id)).toEqual(["task_1_a", "task_1_b", "task_1_c"]);
  });

  it("breaks priority ties by oldest createdAt", () => {
    const tasks: TaskRecord[] = [
      makeTask({ id: "task_1_newer", createdAt: "2026-04-20T12:00:00Z" }),
      makeTask({ id: "task_1_older", createdAt: "2024-01-01T00:00:00Z" }),
    ];
    const ordered = orderTasks(tasks, new Map());
    expect(ordered.map((t) => t.id)).toEqual(["task_1_older", "task_1_newer"]);
  });

  it("interleaves partitions correctly", () => {
    const peers = peerMap<StatusPeer>([
      { id: "task_1_d", status: "pending" },
    ]);
    const tasks: TaskRecord[] = [
      makeTask({ id: "task_1_blocked_high", priority: "high", blockedBy: ["task_1_d"] }),
      makeTask({ id: "task_1_free_low", priority: "low" }),
      makeTask({ id: "task_1_blocked_low", priority: "low", blockedBy: ["task_1_d"] }),
      makeTask({ id: "task_1_free_urgent", priority: "urgent" }),
    ];
    const ordered = orderTasks(tasks, peers);
    expect(ordered.map((t) => t.id)).toEqual([
      "task_1_free_urgent",
      "task_1_free_low",
      "task_1_blocked_high",
      "task_1_blocked_low",
    ]);
  });
});
