/**
 * Pure DAG helpers for the task board domain.
 *
 * Zero runtime imports outside `../shared/types`. No filesystem, no
 * logger, no mocks needed to test. All functions are referentially
 * transparent — same input always produces the same output.
 *
 * Sits underneath `task-store.ts` and `task-service.ts`; those modules
 * call in when they need cycle detection, blocker resolution, ordering,
 * or staleness classification. The service never reimplements this
 * logic; testing happens here.
 */

import type {
  TaskPriority,
  TaskRecord,
  TaskStaleness,
  TaskStatus,
} from "../shared/types/tasks.js";
import { TASK_PRIORITY_RANK } from "../shared/types/tasks.js";

// ---------------------------------------------------------------------------
// Staleness thresholds
// ---------------------------------------------------------------------------

/** Pending longer than this → `stale_pending`. */
export const PENDING_STALE_MS = 24 * 60 * 60 * 1000; // 24h

/** In-progress longer than this since `claimedAt` → `stale_in_progress`. */
export const IN_PROGRESS_STALE_MS = 2 * 60 * 60 * 1000; // 2h

/**
 * Once a blocked task's dependencies have all been completed for this
 * long with no progress on the blocked task itself, flag it as
 * `blocked_unblockable` — the agent should have moved it back to
 * `pending` or picked it up.
 */
export const BLOCKED_STALE_MS = 60 * 60 * 1000; // 1h

// ---------------------------------------------------------------------------
// Cycle detection
// ---------------------------------------------------------------------------

/**
 * Minimal projection needed for cycle detection — the DFS only walks
 * `blockedBy` edges, so we don't need (or want to depend on) the full
 * record shape here.
 */
export interface DagPeer {
  readonly id: string;
  readonly blockedBy: readonly string[];
}

/**
 * Virtual task shape used at create time, before the record is on disk.
 * The cycle check walks `virtualTask.blockedBy` substituting the virtual
 * definition for its own id when encountered (so a future self-reference
 * is caught).
 */
export interface VirtualDagTask {
  readonly id: string;
  readonly blockedBy: readonly string[];
}

/**
 * Detect a dependency cycle. Walks `blockedBy` edges depth-first
 * starting from `virtualTask`, substituting the virtual record for its
 * own id when revisited. Missing peers are treated as leaves (not an
 * error — the service raises separately if it wants strict peer
 * existence).
 *
 * Returns `null` when acyclic; otherwise returns the cycle path in
 * visit order ending at the node that closed the loop.
 */
export function detectCycle(
  virtualTask: VirtualDagTask,
  peers: ReadonlyMap<string, DagPeer>,
): { cycle: readonly string[] } | null {
  const visiting = new Set<string>();
  const path: string[] = [];

  function lookup(id: string): DagPeer {
    if (id === virtualTask.id) return virtualTask;
    return peers.get(id) ?? { id, blockedBy: [] };
  }

  function visit(id: string): readonly string[] | null {
    if (visiting.has(id)) {
      // Found a back-edge; slice from the first occurrence to close the cycle.
      const startIdx = path.indexOf(id);
      const cycle = path.slice(startIdx);
      cycle.push(id); // closing edge — same id shown at both ends
      return cycle;
    }
    visiting.add(id);
    path.push(id);
    const node = lookup(id);
    for (const next of node.blockedBy) {
      const found = visit(next);
      if (found) return found;
    }
    visiting.delete(id);
    path.pop();
    return null;
  }

  const cycle = visit(virtualTask.id);
  return cycle ? { cycle } : null;
}

// ---------------------------------------------------------------------------
// Blocked-by resolution
// ---------------------------------------------------------------------------

export interface StatusPeer {
  readonly id: string;
  readonly status: TaskStatus;
}

/**
 * Return the subset of `task.blockedBy` whose peer is not `completed`.
 * Missing peers are treated as open — the caller can decide whether to
 * reject (service.create strict path) or ignore (stale check resilient
 * path).
 */
export function openBlockers(
  task: { readonly blockedBy: readonly string[] },
  peers: ReadonlyMap<string, StatusPeer>,
): readonly string[] {
  const open: string[] = [];
  for (const id of task.blockedBy) {
    const peer = peers.get(id);
    if (!peer || peer.status !== "completed") open.push(id);
  }
  return open;
}

// ---------------------------------------------------------------------------
// Staleness classification
// ---------------------------------------------------------------------------

/**
 * Minimal peer shape for staleness of a `blocked` task.
 */
export interface StalenessPeer {
  readonly id: string;
  readonly status: TaskStatus;
  readonly updatedAt: string;
  readonly completedAt?: string;
}

/**
 * Classify a single task against the fixed thresholds.
 *
 * Order of checks (first match wins):
 *   1. completed / cancelled   → fresh (terminal)
 *   2. dueDate in the past      → overdue
 *   3. pending older than 24h   → stale_pending
 *   4. in_progress older than 2h from claimedAt (or createdAt fallback) → stale_in_progress
 *   5. blocked with all deps completed for >1h → blocked_unblockable
 *   6. otherwise                → fresh
 */
export function classifyStaleness(
  task: TaskRecord,
  nowMs: number,
  peers: ReadonlyMap<string, StalenessPeer>,
): TaskStaleness {
  if (task.status === "completed" || task.status === "cancelled") {
    return "fresh";
  }

  if (task.dueDate) {
    const due = Date.parse(task.dueDate);
    if (Number.isFinite(due) && due < nowMs) return "overdue";
  }

  if (task.status === "pending") {
    const created = Date.parse(task.createdAt);
    if (Number.isFinite(created) && nowMs - created > PENDING_STALE_MS) {
      return "stale_pending";
    }
    return "fresh";
  }

  if (task.status === "in_progress") {
    const reference = task.claimedAt ?? task.createdAt;
    const t = Date.parse(reference);
    if (Number.isFinite(t) && nowMs - t > IN_PROGRESS_STALE_MS) {
      return "stale_in_progress";
    }
    return "fresh";
  }

  if (task.status === "blocked") {
    // Walk blockedBy; if any peer is not completed, the block is
    // legitimately upheld. If all are completed (or blockedBy is
    // empty), the block is held for an external reason — use the
    // latest completion (or task.updatedAt if no deps) as the
    // reference and flag once more than BLOCKED_STALE_MS has elapsed.
    let allCleared = true;
    let referenceMs = Date.parse(task.updatedAt);
    if (!Number.isFinite(referenceMs)) referenceMs = 0;

    for (const bid of task.blockedBy) {
      const peer = peers.get(bid);
      if (!peer || peer.status !== "completed") {
        allCleared = false;
        break;
      }
      const tsRaw = peer.completedAt ?? peer.updatedAt;
      const ts = Date.parse(tsRaw);
      if (Number.isFinite(ts) && ts > referenceMs) referenceMs = ts;
    }

    if (allCleared && nowMs - referenceMs > BLOCKED_STALE_MS) {
      return "blocked_unblockable";
    }
    return "fresh";
  }

  return "fresh";
}

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

/**
 * Deterministic task ordering for list views:
 *   1. Unblocked tasks come before blocked ones ("blocked" here means
 *      `openBlockers(t, peers).length > 0`; it does NOT refer to the
 *      `blocked` status — a `pending` task with open upstream deps is
 *      "blocked" in this sense).
 *   2. Within each partition, higher priority first (urgent → low).
 *   3. Within each priority, older createdAt first.
 */
export function orderTasks(
  tasks: readonly TaskRecord[],
  peers: ReadonlyMap<string, StatusPeer>,
): readonly TaskRecord[] {
  const unblocked: TaskRecord[] = [];
  const blocked: TaskRecord[] = [];

  for (const t of tasks) {
    if (openBlockers(t, peers).length === 0) unblocked.push(t);
    else blocked.push(t);
  }

  const cmp = (a: TaskRecord, b: TaskRecord): number => {
    const pa = priorityRank(a.priority);
    const pb = priorityRank(b.priority);
    if (pa !== pb) return pa - pb;
    return a.createdAt.localeCompare(b.createdAt);
  };

  unblocked.sort(cmp);
  blocked.sort(cmp);
  return [...unblocked, ...blocked];
}

function priorityRank(p: TaskPriority): number {
  return TASK_PRIORITY_RANK[p];
}
