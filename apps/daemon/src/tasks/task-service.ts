/**
 * TaskService — business logic for the task board domain.
 *
 * Mirrors the store / service / hooks split used by ApprovalService,
 * ScheduleService, and HeartbeatService. All disk I/O goes through
 * `task-store.ts` + `pending-approval-store.ts`; org isolation is
 * enforced via `shared/org-isolation.ts`; every state transition emits
 * a `task:*` hook for the ledger and stream source to pick up.
 *
 * Approval gating: when a task carries `externalAction: true`,
 * `complete()` opens an approval via the existing `ApprovalService`
 * before flipping the status. The pending link is persisted to disk
 * (see `pending-approval-store.ts`) so a daemon restart during the
 * wait window can still apply the outcome.
 */

import { mkdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import type { RondelHooks } from "../shared/hooks.js";
import type { Logger } from "../shared/logger.js";
import { checkOrgIsolation, type OrgLookup } from "../shared/org-isolation.js";
import type {
  PendingApprovalEntry,
  TaskAuditEntry,
  TaskOutput,
  TaskPriority,
  TaskRecord,
  TaskStaleness,
  TaskStatus,
} from "../shared/types/tasks.js";
import type { ApprovalRecord, ApprovalStatus } from "../shared/types/approvals.js";
import type { ApprovalService } from "../approvals/approval-service.js";
import {
  appendAudit,
  listAllTasks,
  listTasks,
  readAudit,
  readTask,
  releaseClaim,
  tryClaim,
  writeTask,
  type TaskPaths,
} from "./task-store.js";
import { PendingApprovalStore } from "./pending-approval-store.js";
import {
  classifyStaleness,
  detectCycle,
  openBlockers,
  orderTasks,
  type DagPeer,
  type StalenessPeer,
  type StatusPeer,
} from "./task-dag.js";

// ---------------------------------------------------------------------------
// Caller context
// ---------------------------------------------------------------------------

/**
 * Identity of the agent calling a task tool. Populated at the bridge
 * boundary from MCP env vars — same forgeable-identity caveat as the
 * schedule and heartbeat endpoints.
 */
export interface TaskCaller {
  readonly agentName: string;
  readonly isAdmin: boolean;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type TaskErrorCode =
  | "validation"
  | "not_found"
  | "unknown_agent"
  | "forbidden"
  | "cross_org"
  | "invalid_transition"
  | "cycle_detected"
  | "blocked_by_open"
  | "claim_conflict";

export class TaskError extends Error {
  constructor(
    public readonly code: TaskErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "TaskError";
  }
}

// ---------------------------------------------------------------------------
// Method inputs
// ---------------------------------------------------------------------------

export interface TaskCreateFields {
  readonly title: string;
  readonly description?: string;
  readonly assignedTo: string;
  readonly priority?: TaskPriority;
  readonly blockedBy?: readonly string[];
  readonly dueDate?: string;
  readonly externalAction?: boolean;
}

export interface TaskUpdateFields {
  readonly title?: string;
  readonly description?: string;
  readonly priority?: TaskPriority;
  readonly assignedTo?: string;
  readonly dueDate?: string | null;
  readonly blockedBy?: readonly string[];
}

export interface TaskCompleteFields {
  readonly result: string;
  readonly outputs?: readonly TaskOutput[];
}

export interface TaskListFilters {
  readonly assignee?: string;
  readonly status?: TaskStatus;
  readonly priority?: TaskPriority;
  readonly includeCompleted?: boolean;
  readonly staleOnly?: boolean;
}

export type TaskCompleteResult =
  | { readonly status: "completed"; readonly record: TaskRecord }
  | {
      readonly status: "approval_pending";
      readonly record: TaskRecord;
      readonly approvalRequestId: string;
    };

export interface TaskStaleResult {
  readonly task: TaskRecord;
  readonly staleness: TaskStaleness;
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface TaskServiceDeps {
  readonly paths: TaskPaths;
  readonly hooks: RondelHooks;
  readonly orgLookup: OrgLookup;
  readonly isKnownAgent: (agent: string) => boolean;
  readonly pendingApprovals: PendingApprovalStore;
  /**
   * Optional — required only if any task in the system can use
   * `externalAction: true`. Absent `approvals` causes `create()` to
   * reject external-action tasks with `validation`.
   */
  readonly approvals?: ApprovalService;
  readonly log: Logger;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

const GLOBAL_ORG_LABEL = "global";

export class TaskService {
  private readonly log: Logger;
  private readonly unsubscribeApprovalResolved?: () => void;

  constructor(private readonly deps: TaskServiceDeps) {
    this.log = deps.log.child("tasks");

    // Subscribe once to approval resolutions so an externally-gated
    // completion can land whenever the human decides. The listener is
    // idempotent — if the entry isn't ours, we skip.
    const onResolved = ({ record }: { record: ApprovalRecord }): void => {
      void this.handleApprovalResolved(record).catch((err) => {
        this.log.error(
          `handleApprovalResolved failed for ${record.requestId}: ${errMessage(err)}`,
        );
      });
    };
    deps.hooks.on("approval:resolved", onResolved);
    this.unsubscribeApprovalResolved = () => deps.hooks.off("approval:resolved", onResolved);
  }

  /**
   * Ensure state dirs exist, load the pending-approvals store, and
   * reconcile any entries whose approval has already been resolved
   * (e.g. during the window between the daemon dying and being
   * restarted).
   *
   * Precondition: `ApprovalService.recoverPending()` has already run
   * so every approval is either pending or terminally resolved.
   */
  async init(): Promise<void> {
    await mkdir(this.deps.paths.rootDir, { recursive: true });
    await this.deps.pendingApprovals.init();
    await this.reconcilePendingApprovals();
  }

  /** Cleanly detach the approval-resolved listener. */
  dispose(): void {
    try {
      this.unsubscribeApprovalResolved?.();
    } catch {
      // Hook off() semantics aren't ours to enforce.
    }
  }

  // -------------------------------------------------------------------------
  // Create
  // -------------------------------------------------------------------------

  async create(caller: TaskCaller, input: TaskCreateFields): Promise<TaskRecord> {
    this.assertAgentExists(caller.agentName);
    this.assertAgentExists(input.assignedTo);

    // Resolve assignee's org. Task lives in the assignee's org.
    const taskOrg = this.orgLabelFor(input.assignedTo);

    // Non-admin callers must share the org with the assignee.
    if (!caller.isAdmin) {
      const callerOrg = this.orgLabelFor(caller.agentName);
      if (callerOrg !== taskOrg) {
        throw new TaskError(
          "cross_org",
          `Cross-org task creation blocked: ${callerOrg} → ${taskOrg}`,
        );
      }
    }

    if (input.externalAction === true && !this.deps.approvals) {
      throw new TaskError(
        "validation",
        "externalAction requires an approvals service to be configured",
      );
    }

    const now = new Date().toISOString();
    const id = newTaskId();
    const blockedBy = input.blockedBy ?? [];

    // Validate every blocker exists in the same org.
    const peers = new Map<string, TaskRecord>();
    for (const bid of blockedBy) {
      const peer = await readTask(this.deps.paths, taskOrg, bid, this.log);
      if (!peer) {
        throw new TaskError("not_found", `blockedBy refers to unknown task: ${bid}`);
      }
      peers.set(bid, peer);
    }

    // Cycle detection — use the virtual task so self-references close
    // without touching disk.
    const dagPeers = new Map<string, DagPeer>();
    for (const [pid, p] of peers) dagPeers.set(pid, { id: pid, blockedBy: p.blockedBy });
    const cycle = detectCycle({ id, blockedBy }, dagPeers);
    if (cycle) {
      throw new TaskError("cycle_detected", `Dependency cycle: ${cycle.cycle.join(" → ")}`);
    }

    const record: TaskRecord = {
      version: 1,
      id,
      org: taskOrg,
      title: input.title,
      description: input.description ?? "",
      status: "pending",
      priority: input.priority ?? "normal",
      createdBy: caller.agentName,
      assignedTo: input.assignedTo,
      createdAt: now,
      updatedAt: now,
      dueDate: input.dueDate,
      blockedBy: [...blockedBy],
      blocks: [],
      externalAction: input.externalAction === true,
      outputs: [],
    };

    await writeTask(this.deps.paths, record);

    // Symmetric edge: append this task's id to every peer's blocks[].
    // Write order matches the design doc (validate → write new →
    // update peers → audit). A failure here leaves dangling edges on
    // the peer, which is the accepted residual called out in
    // ARCHITECTURE.md.
    for (const [pid, peer] of peers) {
      const updatedPeer: TaskRecord = {
        ...peer,
        blocks: [...peer.blocks, id],
        updatedAt: now,
      };
      try {
        await writeTask(this.deps.paths, updatedPeer);
      } catch (err) {
        this.log.error(
          `Peer ${pid} blocks[] update failed for new task ${id}: ${errMessage(err)}`,
        );
      }
    }

    await appendAudit(this.deps.paths, taskOrg, id, {
      ts: now,
      event: "created",
      by: caller.agentName,
      toStatus: "pending",
    });

    this.deps.hooks.emit("task:created", { record });
    this.log.info(`Task created: ${id} — ${shortTitle(record.title)}`);
    return record;
  }

  // -------------------------------------------------------------------------
  // Claim
  // -------------------------------------------------------------------------

  async claim(caller: TaskCaller, id: string): Promise<TaskRecord> {
    this.assertAgentExists(caller.agentName);
    const task = await this.loadOrThrow(caller, id);
    this.assertSameOrgOrAdmin(caller, task);

    if (task.assignedTo !== caller.agentName && !caller.isAdmin) {
      throw new TaskError(
        "forbidden",
        `Task ${id} is assigned to ${task.assignedTo}`,
      );
    }

    if (task.status !== "pending") {
      throw new TaskError(
        "invalid_transition",
        `Task ${id} is ${task.status}, not pending`,
      );
    }

    // DAG gate — all blockers must be completed.
    const peerStatuses = await this.loadPeerStatuses(task.org, task.blockedBy);
    const open = openBlockers(task, peerStatuses);
    if (open.length > 0) {
      throw new TaskError(
        "blocked_by_open",
        `Blocked by: ${open.join(", ")}`,
        { openBlockers: open },
      );
    }

    // Atomic claim — O_EXCL on the lockfile.
    const claimResult = await tryClaim(this.deps.paths, task.org, task.id, caller.agentName);
    if (!claimResult.claimed) {
      throw new TaskError(
        "claim_conflict",
        `Already claimed by ${claimResult.holderAgent ?? "unknown"}`,
        { holderAgent: claimResult.holderAgent, holderAt: claimResult.holderAt },
      );
    }

    const now = new Date().toISOString();
    const updated: TaskRecord = {
      ...task,
      status: "in_progress",
      claimedAt: now,
      updatedAt: now,
    };
    try {
      await writeTask(this.deps.paths, updated);
    } catch (err) {
      // Roll back the lock so someone can retry.
      await releaseClaim(this.deps.paths, task.org, task.id).catch(() => {});
      throw err;
    }

    await appendAudit(this.deps.paths, task.org, task.id, {
      ts: now,
      event: "claimed",
      by: caller.agentName,
      fromStatus: "pending",
      toStatus: "in_progress",
    });

    this.deps.hooks.emit("task:claimed", { record: updated });
    this.log.info(`Task claimed: ${task.id} by ${caller.agentName}`);
    return updated;
  }

  // -------------------------------------------------------------------------
  // Update (free-text patch; no status flips)
  // -------------------------------------------------------------------------

  async update(
    caller: TaskCaller,
    id: string,
    patch: TaskUpdateFields,
  ): Promise<TaskRecord> {
    this.assertAgentExists(caller.agentName);
    const task = await this.loadOrThrow(caller, id);
    this.assertSameOrgOrAdmin(caller, task);

    if (
      task.createdBy !== caller.agentName &&
      task.assignedTo !== caller.agentName &&
      !caller.isAdmin
    ) {
      throw new TaskError(
        "forbidden",
        `Task ${id} can only be updated by its creator, assignee, or admins`,
      );
    }

    if (task.status === "completed" || task.status === "cancelled") {
      throw new TaskError(
        "invalid_transition",
        `Task ${id} is terminal (${task.status})`,
      );
    }

    // If assignee is changing, validate + enforce org match.
    let nextAssignedTo = task.assignedTo;
    if (patch.assignedTo && patch.assignedTo !== task.assignedTo) {
      this.assertAgentExists(patch.assignedTo);
      const newOrg = this.orgLabelFor(patch.assignedTo);
      if (newOrg !== task.org) {
        throw new TaskError(
          "cross_org",
          `Reassignment crosses org boundary (${task.org} → ${newOrg})`,
        );
      }
      nextAssignedTo = patch.assignedTo;
    }

    // If blockedBy is changing, validate peers + detect cycles.
    let nextBlockedBy: readonly string[] = task.blockedBy;
    if (patch.blockedBy) {
      for (const bid of patch.blockedBy) {
        const peer = await readTask(this.deps.paths, task.org, bid, this.log);
        if (!peer) throw new TaskError("not_found", `blockedBy refers to unknown task: ${bid}`);
      }
      const dagPeers = await this.loadDagPeersTransitive(task.org, patch.blockedBy);
      const cycle = detectCycle({ id: task.id, blockedBy: patch.blockedBy }, dagPeers);
      if (cycle) {
        throw new TaskError(
          "cycle_detected",
          `Dependency cycle: ${cycle.cycle.join(" → ")}`,
        );
      }
      nextBlockedBy = patch.blockedBy;
    }

    const now = new Date().toISOString();
    const updated: TaskRecord = {
      ...task,
      title: patch.title ?? task.title,
      description: patch.description ?? task.description,
      priority: patch.priority ?? task.priority,
      assignedTo: nextAssignedTo,
      dueDate:
        patch.dueDate === null ? undefined : patch.dueDate ?? task.dueDate,
      blockedBy: nextBlockedBy,
      updatedAt: now,
    };

    await writeTask(this.deps.paths, updated);

    // If blockedBy changed, rewrite affected peers' `blocks[]`. Same
    // residual risk as create — documented.
    if (patch.blockedBy) {
      const added = nextBlockedBy.filter((b) => !task.blockedBy.includes(b));
      const removed = task.blockedBy.filter((b) => !nextBlockedBy.includes(b));
      for (const bid of added) await this.appendPeerBlocksEdge(task.org, bid, task.id, now);
      for (const bid of removed) await this.removePeerBlocksEdge(task.org, bid, task.id, now);
    }

    await appendAudit(this.deps.paths, task.org, task.id, {
      ts: now,
      event: "updated",
      by: caller.agentName,
      note: summarizePatch(patch),
    });

    this.deps.hooks.emit("task:updated", { record: updated });
    return updated;
  }

  // -------------------------------------------------------------------------
  // Complete (may gate through approvals)
  // -------------------------------------------------------------------------

  async complete(
    caller: TaskCaller,
    id: string,
    fields: TaskCompleteFields,
  ): Promise<TaskCompleteResult> {
    this.assertAgentExists(caller.agentName);
    const task = await this.loadOrThrow(caller, id);
    this.assertSameOrgOrAdmin(caller, task);

    if (task.assignedTo !== caller.agentName && !caller.isAdmin) {
      throw new TaskError(
        "forbidden",
        `Task ${id} is assigned to ${task.assignedTo}`,
      );
    }

    if (task.status !== "in_progress") {
      throw new TaskError(
        "invalid_transition",
        `Task ${id} is ${task.status}, not in_progress`,
      );
    }

    const outputs = fields.outputs ?? [];

    if (task.externalAction) {
      if (!this.deps.approvals) {
        throw new TaskError(
          "validation",
          "externalAction requires an approvals service",
        );
      }
      const { requestId } = await this.deps.approvals.requestToolUse({
        agentName: caller.agentName,
        toolName: "rondel_task_complete",
        toolInput: { taskId: task.id, result: fields.result, outputs },
        reason: "external_action",
      });

      const entry: PendingApprovalEntry = {
        taskId: task.id,
        approvalRequestId: requestId,
        org: task.org,
        createdAt: new Date().toISOString(),
        completionInput: { result: fields.result, outputs: [...outputs] },
      };
      // Persist-before-ack — if the daemon dies after this call, the
      // pending entry is on disk and init() will reconcile on restart.
      await this.deps.pendingApprovals.add(task.org, entry);

      return { status: "approval_pending", record: task, approvalRequestId: requestId };
    }

    // Direct-complete path.
    const completed = await this.applyCompletion(task, caller.agentName, fields.result, outputs);
    return { status: "completed", record: completed };
  }

  // -------------------------------------------------------------------------
  // Block / unblock / cancel
  // -------------------------------------------------------------------------

  async block(caller: TaskCaller, id: string, reason: string): Promise<TaskRecord> {
    this.assertAgentExists(caller.agentName);
    const task = await this.loadOrThrow(caller, id);
    this.assertSameOrgOrAdmin(caller, task);

    if (task.assignedTo !== caller.agentName && !caller.isAdmin) {
      throw new TaskError(
        "forbidden",
        `Task ${id} is assigned to ${task.assignedTo}`,
      );
    }

    if (task.status === "completed" || task.status === "cancelled" || task.status === "blocked") {
      throw new TaskError(
        "invalid_transition",
        `Task ${id} is ${task.status}`,
      );
    }

    const now = new Date().toISOString();
    const updated: TaskRecord = {
      ...task,
      status: "blocked",
      blockedReason: reason,
      updatedAt: now,
    };

    await writeTask(this.deps.paths, updated);
    await releaseClaim(this.deps.paths, task.org, task.id);
    await appendAudit(this.deps.paths, task.org, task.id, {
      ts: now,
      event: "blocked",
      by: caller.agentName,
      fromStatus: task.status,
      toStatus: "blocked",
      note: reason,
    });

    this.deps.hooks.emit("task:blocked", { record: updated });
    return updated;
  }

  async unblock(caller: TaskCaller, id: string): Promise<TaskRecord> {
    this.assertAgentExists(caller.agentName);
    const task = await this.loadOrThrow(caller, id);
    this.assertSameOrgOrAdmin(caller, task);

    if (
      task.createdBy !== caller.agentName &&
      task.assignedTo !== caller.agentName &&
      !caller.isAdmin
    ) {
      throw new TaskError(
        "forbidden",
        `Task ${id} can only be unblocked by its creator, assignee, or admins`,
      );
    }
    if (task.status !== "blocked") {
      throw new TaskError(
        "invalid_transition",
        `Task ${id} is ${task.status}, not blocked`,
      );
    }

    const now = new Date().toISOString();
    const updated: TaskRecord = {
      ...task,
      status: "pending",
      blockedReason: undefined,
      updatedAt: now,
    };
    await writeTask(this.deps.paths, updated);
    await appendAudit(this.deps.paths, task.org, task.id, {
      ts: now,
      event: "unblocked",
      by: caller.agentName,
      fromStatus: "blocked",
      toStatus: "pending",
    });

    this.deps.hooks.emit("task:updated", { record: updated });
    return updated;
  }

  async cancel(caller: TaskCaller, id: string, reason?: string): Promise<TaskRecord> {
    this.assertAgentExists(caller.agentName);
    const task = await this.loadOrThrow(caller, id);
    this.assertSameOrgOrAdmin(caller, task);

    if (
      task.createdBy !== caller.agentName &&
      task.assignedTo !== caller.agentName &&
      !caller.isAdmin
    ) {
      throw new TaskError(
        "forbidden",
        `Task ${id} can only be cancelled by its creator, assignee, or admins`,
      );
    }
    if (task.status === "completed" || task.status === "cancelled") {
      throw new TaskError("invalid_transition", `Task ${id} is already ${task.status}`);
    }

    const now = new Date().toISOString();
    const updated: TaskRecord = {
      ...task,
      status: "cancelled",
      completedAt: now,
      updatedAt: now,
      blockedReason: reason,
    };
    await writeTask(this.deps.paths, updated);
    await releaseClaim(this.deps.paths, task.org, task.id);
    // If we had a pending approval queued, drop it — no one will resolve it.
    await this.deps.pendingApprovals.remove(task.org, task.id);

    await appendAudit(this.deps.paths, task.org, task.id, {
      ts: now,
      event: "cancelled",
      by: caller.agentName,
      fromStatus: task.status,
      toStatus: "cancelled",
      note: reason,
    });

    this.deps.hooks.emit("task:cancelled", { record: updated });
    return updated;
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  async readOne(caller: TaskCaller, id: string): Promise<TaskRecord | undefined> {
    this.assertAgentExists(caller.agentName);
    const task = await this.locateTask(caller, id);
    if (!task) return undefined;
    this.assertSameOrgOrAdmin(caller, task);
    return task;
  }

  async readAudit(caller: TaskCaller, id: string): Promise<readonly TaskAuditEntry[]> {
    this.assertAgentExists(caller.agentName);
    const task = await this.locateTask(caller, id);
    if (!task) return [];
    this.assertSameOrgOrAdmin(caller, task);
    return readAudit(this.deps.paths, task.org, task.id, this.log);
  }

  async list(caller: TaskCaller, filters: TaskListFilters = {}): Promise<readonly TaskRecord[]> {
    this.assertAgentExists(caller.agentName);
    const scope = caller.isAdmin ? await listAllTasks(this.deps.paths, this.log) : await listTasks(this.deps.paths, this.orgLabelFor(caller.agentName), this.log);

    const filtered = scope.filter((t) => {
      if (filters.assignee && t.assignedTo !== filters.assignee) return false;
      if (filters.status && t.status !== filters.status) return false;
      if (filters.priority && t.priority !== filters.priority) return false;
      if (!filters.includeCompleted && (t.status === "completed" || t.status === "cancelled")) {
        return false;
      }
      return true;
    });

    const peers = indexByStatus(scope);
    let ordered = orderTasks(filtered, peers);

    if (filters.staleOnly) {
      const now = Date.now();
      const stalePeers = indexByStaleness(scope);
      ordered = ordered.filter((t) => classifyStaleness(t, now, stalePeers) !== "fresh");
    }

    return ordered;
  }

  async findStale(caller: TaskCaller, nowMs: number): Promise<readonly TaskStaleResult[]> {
    this.assertAgentExists(caller.agentName);
    const scope = caller.isAdmin
      ? await listAllTasks(this.deps.paths, this.log)
      : await listTasks(this.deps.paths, this.orgLabelFor(caller.agentName), this.log);

    const peers = indexByStaleness(scope);
    const out: TaskStaleResult[] = [];
    for (const task of scope) {
      const staleness = classifyStaleness(task, nowMs, peers);
      if (staleness !== "fresh") {
        out.push({ task, staleness });
        this.deps.hooks.emit("task:stale", { record: task, staleness });
      }
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Agent cleanup
  // -------------------------------------------------------------------------

  /**
   * Called from AdminApi.deleteAgent. Cancels every non-terminal task
   * assigned to the removed agent so the board doesn't keep pointing
   * at a dead inbox.
   */
  async onAgentDeleted(agent: string): Promise<void> {
    const all = await listAllTasks(this.deps.paths, this.log);
    const now = new Date().toISOString();
    const reason = `assignee ${agent} removed`;
    for (const task of all) {
      if (task.assignedTo !== agent) continue;
      if (task.status === "completed" || task.status === "cancelled") continue;
      const cancelled: TaskRecord = {
        ...task,
        status: "cancelled",
        completedAt: now,
        updatedAt: now,
        blockedReason: reason,
      };
      await writeTask(this.deps.paths, cancelled);
      await releaseClaim(this.deps.paths, task.org, task.id);
      await this.deps.pendingApprovals.remove(task.org, task.id);
      await appendAudit(this.deps.paths, task.org, task.id, {
        ts: now,
        event: "cancelled",
        by: "daemon",
        fromStatus: task.status,
        toStatus: "cancelled",
        note: reason,
      });
      this.deps.hooks.emit("task:cancelled", { record: cancelled });
    }
  }

  // -------------------------------------------------------------------------
  // Approval reconciliation
  // -------------------------------------------------------------------------

  private async reconcilePendingApprovals(): Promise<void> {
    const approvals = this.deps.approvals;
    if (!approvals) return;
    const entries = this.deps.pendingApprovals.listAll();
    for (const entry of entries) {
      const record = await approvals.getById(entry.approvalRequestId);
      if (!record) {
        // Lost to auto-deny during ApprovalService.recoverPending.
        this.log.warn(
          `Reconcile: approval ${entry.approvalRequestId} for task ${entry.taskId} not found — treating as deny`,
        );
        await this.applyDenial(entry, "approval lost on restart");
        continue;
      }
      if (record.status === "pending") continue; // listener will handle
      if (record.decision === "allow") {
        await this.applyAllow(entry, record.resolvedBy ?? "daemon");
      } else {
        await this.applyDenial(entry, `approval denied${record.resolvedBy ? ` by ${record.resolvedBy}` : ""}`);
      }
    }
  }

  private async handleApprovalResolved(record: ApprovalRecord): Promise<void> {
    const entry = this.deps.pendingApprovals.findByApprovalId(record.requestId);
    if (!entry) return; // not ours
    if ((record.status as ApprovalStatus) !== "resolved") return;
    if (record.decision === "allow") {
      await this.applyAllow(entry, record.resolvedBy ?? "approval");
    } else {
      await this.applyDenial(
        entry,
        `approval denied${record.resolvedBy ? ` by ${record.resolvedBy}` : ""}`,
      );
    }
  }

  private async applyAllow(entry: PendingApprovalEntry, by: string): Promise<void> {
    const task = await readTask(this.deps.paths, entry.org, entry.taskId, this.log);
    if (!task) {
      this.log.warn(`applyAllow: task ${entry.taskId} missing; dropping pending entry`);
      await this.deps.pendingApprovals.remove(entry.org, entry.taskId);
      return;
    }
    if (task.status === "completed" || task.status === "cancelled") {
      await this.deps.pendingApprovals.remove(entry.org, entry.taskId);
      return;
    }
    await this.applyCompletion(task, by, entry.completionInput.result, entry.completionInput.outputs);
    await this.deps.pendingApprovals.remove(entry.org, entry.taskId);
  }

  private async applyDenial(entry: PendingApprovalEntry, reason: string): Promise<void> {
    const task = await readTask(this.deps.paths, entry.org, entry.taskId, this.log);
    if (!task) {
      await this.deps.pendingApprovals.remove(entry.org, entry.taskId);
      return;
    }
    if (task.status === "completed" || task.status === "cancelled") {
      await this.deps.pendingApprovals.remove(entry.org, entry.taskId);
      return;
    }
    const now = new Date().toISOString();
    const updated: TaskRecord = {
      ...task,
      status: "blocked",
      blockedReason: reason,
      updatedAt: now,
    };
    await writeTask(this.deps.paths, updated);
    await releaseClaim(this.deps.paths, task.org, task.id);
    await appendAudit(this.deps.paths, task.org, task.id, {
      ts: now,
      event: "blocked",
      by: "daemon",
      fromStatus: task.status,
      toStatus: "blocked",
      note: reason,
    });
    this.deps.hooks.emit("task:blocked", { record: updated });
    await this.deps.pendingApprovals.remove(entry.org, entry.taskId);
  }

  private async applyCompletion(
    task: TaskRecord,
    by: string,
    result: string,
    outputs: readonly TaskOutput[],
  ): Promise<TaskRecord> {
    const now = new Date().toISOString();
    const updated: TaskRecord = {
      ...task,
      status: "completed",
      completedAt: now,
      updatedAt: now,
      result,
      outputs: [...outputs],
    };
    await writeTask(this.deps.paths, updated);
    await releaseClaim(this.deps.paths, task.org, task.id);
    await appendAudit(this.deps.paths, task.org, task.id, {
      ts: now,
      event: "completed",
      by,
      fromStatus: task.status,
      toStatus: "completed",
    });
    this.deps.hooks.emit("task:completed", { record: updated });
    return updated;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private assertAgentExists(agent: string): void {
    if (!this.deps.isKnownAgent(agent)) {
      throw new TaskError("unknown_agent", `Unknown agent: ${agent}`);
    }
  }

  private orgLabelFor(agent: string): string {
    const res = this.deps.orgLookup(agent);
    if (res.status === "org") return res.orgName;
    return GLOBAL_ORG_LABEL;
  }

  private assertSameOrgOrAdmin(caller: TaskCaller, task: TaskRecord): void {
    if (caller.isAdmin) return;
    const callerOrg = this.orgLabelFor(caller.agentName);
    if (callerOrg === task.org) return;
    const err = checkOrgIsolation(this.deps.orgLookup, caller.agentName, task.assignedTo);
    const msg = err
      ? err.replace(/^Cross-org messaging blocked/, "Cross-org task access blocked")
      : `Cross-org task access blocked: ${callerOrg} → ${task.org}`;
    throw new TaskError("cross_org", msg);
  }

  private async loadOrThrow(caller: TaskCaller, id: string): Promise<TaskRecord> {
    const task = await this.locateTask(caller, id);
    if (!task) throw new TaskError("not_found", `Task not found: ${id}`);
    return task;
  }

  /**
   * Resolve a task by id. Fast path: look in the caller's org. Slow
   * path (admins only): scan every org. Returns undefined when not
   * found anywhere in scope.
   */
  private async locateTask(caller: TaskCaller, id: string): Promise<TaskRecord | undefined> {
    // Validate format early so crafted ids never reach listOrgs.
    // readTask also guards, but failing fast is clearer.
    try {
      const callerOrg = this.orgLabelFor(caller.agentName);
      const fast = await readTask(this.deps.paths, callerOrg, id, this.log);
      if (fast) return fast;
    } catch (err) {
      // Invalid id or bad org name → bubble as validation error.
      throw new TaskError("validation", errMessage(err));
    }
    if (!caller.isAdmin) return undefined;
    // Admin fallback: scan every org.
    const all = await listAllTasks(this.deps.paths, this.log);
    return all.find((t) => t.id === id);
  }

  private async loadPeerStatuses(
    org: string,
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, StatusPeer>> {
    const map = new Map<string, StatusPeer>();
    for (const bid of ids) {
      const peer = await readTask(this.deps.paths, org, bid, this.log);
      if (peer) map.set(bid, { id: peer.id, status: peer.status });
    }
    return map;
  }

  /**
   * Build a DAG-peer map by walking the `blockedBy` edges transitively
   * from `seedIds`. Only needed when `update()` changes a task's
   * blockedBy; `create()` uses the direct peers.
   */
  private async loadDagPeersTransitive(
    org: string,
    seedIds: readonly string[],
  ): Promise<ReadonlyMap<string, DagPeer>> {
    const peers = new Map<string, DagPeer>();
    const queue: string[] = [...seedIds];
    while (queue.length > 0) {
      const next = queue.shift()!;
      if (peers.has(next)) continue;
      const peer = await readTask(this.deps.paths, org, next, this.log);
      if (!peer) continue;
      peers.set(next, { id: peer.id, blockedBy: peer.blockedBy });
      for (const bid of peer.blockedBy) queue.push(bid);
    }
    return peers;
  }

  private async appendPeerBlocksEdge(
    org: string,
    peerId: string,
    taskId: string,
    now: string,
  ): Promise<void> {
    const peer = await readTask(this.deps.paths, org, peerId, this.log);
    if (!peer) return;
    if (peer.blocks.includes(taskId)) return;
    const updated: TaskRecord = { ...peer, blocks: [...peer.blocks, taskId], updatedAt: now };
    await writeTask(this.deps.paths, updated);
  }

  private async removePeerBlocksEdge(
    org: string,
    peerId: string,
    taskId: string,
    now: string,
  ): Promise<void> {
    const peer = await readTask(this.deps.paths, org, peerId, this.log);
    if (!peer) return;
    if (!peer.blocks.includes(taskId)) return;
    const updated: TaskRecord = {
      ...peer,
      blocks: peer.blocks.filter((b) => b !== taskId),
      updatedAt: now,
    };
    await writeTask(this.deps.paths, updated);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function newTaskId(): string {
  const epoch = Date.now();
  const rand = randomBytes(4).toString("hex");
  return `task_${epoch}_${rand}`;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function shortTitle(title: string): string {
  return title.length > 60 ? title.slice(0, 60) + "..." : title;
}

function summarizePatch(patch: TaskUpdateFields): string {
  const keys: string[] = [];
  if (patch.title !== undefined) keys.push("title");
  if (patch.description !== undefined) keys.push("description");
  if (patch.priority !== undefined) keys.push("priority");
  if (patch.assignedTo !== undefined) keys.push("assignedTo");
  if (patch.dueDate !== undefined) keys.push("dueDate");
  if (patch.blockedBy !== undefined) keys.push("blockedBy");
  return keys.length > 0 ? `patched: ${keys.join(", ")}` : "no-op";
}

function indexByStatus(tasks: readonly TaskRecord[]): ReadonlyMap<string, StatusPeer> {
  const map = new Map<string, StatusPeer>();
  for (const t of tasks) map.set(t.id, { id: t.id, status: t.status });
  return map;
}

function indexByStaleness(tasks: readonly TaskRecord[]): ReadonlyMap<string, StalenessPeer> {
  const map = new Map<string, StalenessPeer>();
  for (const t of tasks) {
    map.set(t.id, {
      id: t.id,
      status: t.status,
      updatedAt: t.updatedAt,
      completedAt: t.completedAt,
    });
  }
  return map;
}
