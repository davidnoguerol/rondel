/**
 * Edge-case tests for TaskService: approval-gated completion +
 * cross-org rejections + restart survival of pending approvals.
 *
 * Wires a real `ApprovalService` so the approval↔task handoff is
 * exercised end-to-end, including the `approval:resolved` hook that
 * TaskService subscribes to in its constructor.
 */

import { describe, it, expect, vi } from "vitest";
import { join } from "node:path";
import { TaskService, type TaskServiceDeps } from "./task-service.js";
import { readTask, type TaskPaths } from "./task-store.js";
import { PendingApprovalStore } from "./pending-approval-store.js";
import { ApprovalService } from "../approvals/approval-service.js";
import type { ApprovalPaths } from "../approvals/approval-store.js";
import { createHooks, type RondelHooks } from "../shared/hooks.js";
import { createLogger } from "../shared/logger.js";
import type { OrgResolution } from "../shared/org-isolation.js";
import type { ChannelRegistry } from "../channels/core/registry.js";
import { withTmpRondel } from "../../../../tests/helpers/tmp.js";
import type { TaskStatus } from "../shared/types/tasks.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Poll the on-disk task record until it reaches the expected status
 * or we time out. The approval-resolved listener is async and
 * performs multiple disk ops; `setImmediate` alone isn't reliable.
 */
async function waitForStatus(
  paths: TaskPaths,
  org: string,
  id: string,
  expected: TaskStatus,
  timeoutMs = 1000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const record = await readTask(paths, org, id);
    if (record?.status === expected) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`Timeout waiting for task ${id} to reach ${expected}`);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface World {
  readonly agents: Record<string, string | undefined>;
}

/**
 * Quiet `ChannelRegistry` stub — approval dispatch fans out
 * fire-and-forget; we don't care about the Telegram side here.
 */
function silentRegistry(): ChannelRegistry {
  return { get: () => undefined } as unknown as ChannelRegistry;
}

async function setup(
  stateDir: string,
  world: World,
): Promise<{
  service: TaskService;
  approvals: ApprovalService;
  hooks: RondelHooks;
  paths: TaskPaths;
  pendingApprovals: PendingApprovalStore;
  rebuild: () => Promise<{ service: TaskService; hooks: RondelHooks }>;
}> {
  const hooks = createHooks();
  const log = createLogger("test", "error");
  const taskPaths: TaskPaths = { rootDir: join(stateDir, "tasks") };
  const approvalPaths: ApprovalPaths = {
    pendingDir: join(stateDir, "approvals", "pending"),
    resolvedDir: join(stateDir, "approvals", "resolved"),
  };
  const approvals = new ApprovalService({
    paths: approvalPaths,
    hooks,
    channels: silentRegistry(),
    resolveAccountId: () => undefined,
    log,
  });
  await approvals.init();
  const pendingApprovals = new PendingApprovalStore(taskPaths, log);

  const orgLookup = (name: string): OrgResolution => {
    if (!(name in world.agents)) return { status: "unknown" };
    const org = world.agents[name];
    return org ? { status: "org", orgName: org } : { status: "global" };
  };

  const deps: TaskServiceDeps = {
    paths: taskPaths,
    hooks,
    orgLookup,
    isKnownAgent: (n) => n in world.agents,
    pendingApprovals,
    approvals,
    log,
  };
  const service = new TaskService(deps);
  await service.init();

  /**
   * Rebuild a fresh TaskService on the SAME disk with a fresh hook
   * bus. Simulates a daemon restart — the old in-memory listener is
   * gone; reconciliation happens via `init()` reading the pending
   * file on disk + querying the ApprovalService for state.
   */
  const rebuild = async () => {
    service.dispose();
    const freshHooks = createHooks();
    const freshApprovals = new ApprovalService({
      paths: approvalPaths,
      hooks: freshHooks,
      channels: silentRegistry(),
      resolveAccountId: () => undefined,
      log,
    });
    await freshApprovals.init();
    const freshPending = new PendingApprovalStore(taskPaths, log);
    const fresh = new TaskService({
      ...deps,
      hooks: freshHooks,
      pendingApprovals: freshPending,
      approvals: freshApprovals,
    });
    await fresh.init();
    return { service: fresh, hooks: freshHooks };
  };

  return { service, approvals, hooks, paths: taskPaths, pendingApprovals, rebuild };
}

// ---------------------------------------------------------------------------
// Approval-gated complete
// ---------------------------------------------------------------------------

describe("TaskService — approval-gated completion", () => {
  it("returns approval_pending and persists the pending entry on complete()", async () => {
    const tmp = withTmpRondel();
    const { service, pendingApprovals } = await setup(tmp.stateDir, {
      agents: { alice: "eng", bob: "eng" },
    });
    const task = await service.create(
      { agentName: "alice", isAdmin: false },
      { title: "x", assignedTo: "bob", externalAction: true },
    );
    await service.claim({ agentName: "bob", isAdmin: false }, task.id);
    const result = await service.complete(
      { agentName: "bob", isAdmin: false },
      task.id,
      { result: "done" },
    );
    expect(result.status).toBe("approval_pending");
    if (result.status !== "approval_pending") throw new Error("unreachable");
    expect(result.approvalRequestId).toMatch(/^appr_/);

    // Disk state: task still in_progress, pending-approvals file has entry.
    expect(pendingApprovals.findByTaskId(task.org, task.id)?.approvalRequestId).toBe(
      result.approvalRequestId,
    );
  });

  it("on approval allow, the task transitions to completed with the stashed result", async () => {
    const tmp = withTmpRondel();
    const { service, approvals, hooks, paths, pendingApprovals } = await setup(
      tmp.stateDir,
      { agents: { alice: "eng", bob: "eng" } },
    );
    const task = await service.create(
      { agentName: "alice", isAdmin: false },
      { title: "x", assignedTo: "bob", externalAction: true },
    );
    await service.claim({ agentName: "bob", isAdmin: false }, task.id);
    const pending = await service.complete(
      { agentName: "bob", isAdmin: false },
      task.id,
      { result: "shipped", outputs: [{ type: "file", path: "/tmp/x.txt" }] },
    );
    if (pending.status !== "approval_pending") throw new Error("unreachable");

    const completedListener = vi.fn();
    hooks.on("task:completed", completedListener);

    await approvals.resolve(pending.approvalRequestId, "allow", "operator");
    // Hook callback is async and does disk I/O; poll for transition.
    await waitForStatus(paths, task.org, task.id, "completed");

    const onDisk = await readTask(paths, task.org, task.id);
    expect(onDisk?.status).toBe("completed");
    expect(onDisk?.result).toBe("shipped");
    expect(onDisk?.outputs).toHaveLength(1);

    expect(completedListener).toHaveBeenCalledTimes(1);
    expect(pendingApprovals.findByTaskId(task.org, task.id)).toBeUndefined();
  });

  it("on approval deny, the task moves to blocked with blockedReason and releases the claim", async () => {
    const tmp = withTmpRondel();
    const { service, approvals, hooks, paths, pendingApprovals } = await setup(
      tmp.stateDir,
      { agents: { alice: "eng", bob: "eng" } },
    );
    const task = await service.create(
      { agentName: "alice", isAdmin: false },
      { title: "x", assignedTo: "bob", externalAction: true },
    );
    await service.claim({ agentName: "bob", isAdmin: false }, task.id);
    const pending = await service.complete(
      { agentName: "bob", isAdmin: false },
      task.id,
      { result: "shipped" },
    );
    if (pending.status !== "approval_pending") throw new Error("unreachable");

    const blockedListener = vi.fn();
    hooks.on("task:blocked", blockedListener);

    await approvals.resolve(pending.approvalRequestId, "deny", "operator");
    await waitForStatus(paths, task.org, task.id, "blocked");

    const onDisk = await readTask(paths, task.org, task.id);
    expect(onDisk?.status).toBe("blocked");
    expect(onDisk?.blockedReason).toContain("denied");
    expect(pendingApprovals.findByTaskId(task.org, task.id)).toBeUndefined();
    expect(blockedListener).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Restart survival
// ---------------------------------------------------------------------------

describe("TaskService — restart reconciliation", () => {
  it("applies an approval that resolved while the daemon was dead", async () => {
    const tmp = withTmpRondel();
    const { service, approvals, paths, rebuild } = await setup(tmp.stateDir, {
      agents: { alice: "eng", bob: "eng" },
    });
    const task = await service.create(
      { agentName: "alice", isAdmin: false },
      { title: "x", assignedTo: "bob", externalAction: true },
    );
    await service.claim({ agentName: "bob", isAdmin: false }, task.id);
    const pending = await service.complete(
      { agentName: "bob", isAdmin: false },
      task.id,
      { result: "shipped" },
    );
    if (pending.status !== "approval_pending") throw new Error("unreachable");

    // Simulate: the old daemon's hook subscription is gone. Resolve
    // directly on the approvals service (same disk). The task should
    // NOT transition yet because no TaskService is listening.
    service.dispose();
    await approvals.resolve(pending.approvalRequestId, "allow", "operator");
    // Nothing should have picked it up — the old service is disposed.

    // Rebuild — TaskService.init() reconciles.
    const { service: fresh } = await rebuild();
    const onDisk = await readTask(paths, task.org, task.id);
    expect(onDisk?.status).toBe("completed");
    expect(onDisk?.result).toBe("shipped");
    // Entry removed post-apply.
    const afterList = await fresh.list({ agentName: "alice", isAdmin: false }, {});
    expect(afterList.every((t) => t.status !== "in_progress" || t.id !== task.id)).toBe(true);
  });

  it("treats a missing approval as a denial on restart", async () => {
    const tmp = withTmpRondel();
    const { service, paths, pendingApprovals, rebuild } = await setup(tmp.stateDir, {
      agents: { alice: "eng", bob: "eng" },
    });
    const task = await service.create(
      { agentName: "alice", isAdmin: false },
      { title: "x", assignedTo: "bob", externalAction: true },
    );
    await service.claim({ agentName: "bob", isAdmin: false }, task.id);
    const pending = await service.complete(
      { agentName: "bob", isAdmin: false },
      task.id,
      { result: "shipped" },
    );
    if (pending.status !== "approval_pending") throw new Error("unreachable");

    // Hand-corrupt the pending store: point the entry at a bogus
    // approval id. Rebuild — init() should not find it and treat as
    // denial.
    await pendingApprovals.add(task.org, {
      taskId: task.id,
      approvalRequestId: "appr_0_deadbeef",
      org: task.org,
      createdAt: new Date().toISOString(),
      completionInput: { result: "shipped", outputs: [] },
    });

    service.dispose();
    const { service: fresh } = await rebuild();
    const onDisk = await readTask(paths, task.org, task.id);
    expect(onDisk?.status).toBe("blocked");
    expect(onDisk?.blockedReason).toContain("lost");
    // Entry was cleaned up.
    const remainingPending = fresh
      .list({ agentName: "alice", isAdmin: false }, { includeCompleted: true });
    expect((await remainingPending).some((t) => t.id === task.id)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Cross-org + unknown caller
// ---------------------------------------------------------------------------

describe("TaskService — cross-org + unknown caller edges", () => {
  it("cross-org read blocked for non-admin", async () => {
    const tmp = withTmpRondel();
    const { service } = await setup(tmp.stateDir, {
      agents: { alice: "eng", charlie: "finance", root: undefined },
    });
    const task = await service.create(
      { agentName: "root", isAdmin: true },
      { title: "x", assignedTo: "charlie" },
    );
    const result = await service.readOne({ agentName: "alice", isAdmin: false }, task.id);
    // Same-org scan returns undefined; alice is in "eng" but task is in "finance".
    expect(result).toBeUndefined();
  });

  it("unknown caller rejects", async () => {
    const tmp = withTmpRondel();
    const { service } = await setup(tmp.stateDir, {
      agents: { alice: "eng", bob: "eng" },
    });
    await expect(
      service.create(
        { agentName: "ghost", isAdmin: false },
        { title: "x", assignedTo: "bob" },
      ),
    ).rejects.toMatchObject({ code: "unknown_agent" });
  });

  it("externalAction without approvals service → validation", async () => {
    const tmp = withTmpRondel();
    const hooks = createHooks();
    const log = createLogger("test", "error");
    const taskPaths: TaskPaths = { rootDir: join(tmp.stateDir, "tasks") };
    const pendingApprovals = new PendingApprovalStore(taskPaths, log);
    const world = { agents: { alice: "eng", bob: "eng" } };
    const service = new TaskService({
      paths: taskPaths,
      hooks,
      orgLookup: (name): OrgResolution => {
        if (!(name in world.agents)) return { status: "unknown" };
        const org = world.agents[name];
        return org ? { status: "org", orgName: org } : { status: "global" };
      },
      isKnownAgent: (n) => n in world.agents,
      pendingApprovals,
      approvals: undefined,
      log,
    });
    await service.init();
    await expect(
      service.create(
        { agentName: "alice", isAdmin: false },
        { title: "x", assignedTo: "bob", externalAction: true },
      ),
    ).rejects.toMatchObject({ code: "validation" });
  });
});
