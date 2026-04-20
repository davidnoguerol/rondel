/**
 * Task board types.
 *
 * A task is a persistent, claimable unit of work recorded as a JSON file
 * at `state/tasks/{org}/task_<epoch>_<hex>.json`. Agents create tasks
 * before starting work, atomically claim them via an O_EXCL lockfile,
 * block with a reason when stuck, and complete with a result + optional
 * outputs. Every state change appends to a per-task JSONL audit log.
 *
 * See `docs/phase-1/02-task-board-design.md` for the full contract.
 *
 * Pure types — no runtime imports.
 */

// ---------------------------------------------------------------------------
// Status & priority
// ---------------------------------------------------------------------------

export type TaskStatus =
  | "pending"
  | "in_progress"
  | "blocked"
  | "completed"
  | "cancelled";

export type TaskPriority = "urgent" | "high" | "normal" | "low";

/**
 * Numeric rank used by `orderTasks()` in `tasks/task-dag.ts`. Lower is
 * higher priority — `urgent` sorts first.
 */
export const TASK_PRIORITY_RANK: Readonly<Record<TaskPriority, number>> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
};

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

/**
 * A concrete deliverable attached to a completed task. Phase 1 ships
 * with file outputs only; the union keeps room for future kinds.
 */
export interface TaskOutput {
  readonly type: "file";
  readonly path: string;
  readonly label?: string;
}

// ---------------------------------------------------------------------------
// Record
// ---------------------------------------------------------------------------

/**
 * Canonical on-disk task record. One file per task, overwritten in place
 * on every mutation via `atomicWriteFile`.
 *
 * `version` future-proofs schema migrations — the store refuses to parse
 * records whose version it doesn't recognise.
 *
 * `blockedBy` and `blocks` are maintained symmetrically: creating a task
 * with `blockedBy: [A]` appends this task's id to `A.blocks`. The
 * cycle check in `task-dag.ts` walks the `blockedBy` edges and rejects
 * writes that would introduce a cycle.
 */
export interface TaskRecord {
  readonly version: 1;
  readonly id: string;
  readonly org: string;
  readonly title: string;
  readonly description: string;
  readonly status: TaskStatus;
  readonly priority: TaskPriority;
  readonly createdBy: string;
  readonly assignedTo: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly claimedAt?: string;
  readonly completedAt?: string;
  readonly dueDate?: string;
  readonly blockedBy: readonly string[];
  readonly blocks: readonly string[];
  readonly blockedReason?: string;
  /**
   * When true, `rondel_task_complete` opens an approval via the existing
   * `ApprovalService` before flipping status to `completed`. Approved →
   * transitions; denied → stays `in_progress` with `blockedReason` set.
   */
  readonly externalAction: boolean;
  readonly result?: string;
  readonly outputs: readonly TaskOutput[];
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

export type TaskAuditEvent =
  | "created"
  | "claimed"
  | "updated"
  | "blocked"
  | "unblocked"
  | "completed"
  | "cancelled";

/**
 * One line of a task's append-only audit log at
 * `state/tasks/{org}/audit/{id}.jsonl`. Never rewritten.
 */
export interface TaskAuditEntry {
  readonly ts: string;
  readonly event: TaskAuditEvent;
  readonly by: string;
  readonly fromStatus?: TaskStatus;
  readonly toStatus?: TaskStatus;
  readonly note?: string;
}

// ---------------------------------------------------------------------------
// Staleness classification
// ---------------------------------------------------------------------------

/**
 * Output of `classifyStaleness` in `tasks/task-dag.ts`. `fresh` means no
 * staleness signal; anything else is a surfaceable condition for the
 * heartbeat skill or orchestrator review.
 */
export type TaskStaleness =
  | "fresh"
  | "stale_pending"
  | "stale_in_progress"
  | "overdue"
  | "blocked_unblockable";

// ---------------------------------------------------------------------------
// Pending-approval link (approval-gated completion)
// ---------------------------------------------------------------------------

/**
 * On-disk link between a task whose completion is awaiting human
 * approval and the approval record in `approvals/`. Persisted per org at
 * `state/tasks/{org}/.pending-approvals.json` so that a daemon restart
 * during the wait window can still apply the outcome when the human
 * decides.
 *
 * `completionInput` is stashed at request time so the service can apply
 * the exact `{result, outputs}` the agent asked for when the approval
 * flips to allow — the agent is not re-consulted.
 */
export interface PendingApprovalEntry {
  readonly taskId: string;
  readonly approvalRequestId: string;
  readonly org: string;
  readonly createdAt: string;
  readonly completionInput: {
    readonly result: string;
    readonly outputs: readonly TaskOutput[];
  };
}

/**
 * Versioned file wrapper — same pattern as `schedules.json`. The store
 * starts empty (rather than crashing) on a version it doesn't recognise.
 */
export interface PendingApprovalsFileV1 {
  readonly version: 1;
  readonly entries: readonly PendingApprovalEntry[];
}
