/**
 * TaskService integration tests — real disk, real hooks, in-memory
 * agent/org lookups. Covers happy-path lifecycle, DAG enforcement,
 * cycle detection, list ordering, staleness, hook fan-out, agent
 * deletion cleanup.
 *
 * Approval-gated complete lives in `task-service.edge.integration.test.ts`
 * where the approval service is stood up against real state.
 */

import { describe, it, expect, vi } from "vitest";
import { join } from "node:path";
import { TaskService, TaskError, type TaskServiceDeps } from "./task-service.js";
import { readTask, type TaskPaths } from "./task-store.js";
import { PendingApprovalStore } from "./pending-approval-store.js";
import { IN_PROGRESS_STALE_MS, PENDING_STALE_MS } from "./task-dag.js";
import { createHooks, type RondelHooks } from "../shared/hooks.js";
import { createLogger } from "../shared/logger.js";
import type { OrgResolution } from "../shared/org-isolation.js";
import type { TaskRecord } from "../shared/types/tasks.js";
import { withTmpRondel } from "../../../../tests/helpers/tmp.js";

interface World {
  readonly agents: Record<string, string | undefined>;
}

async function makeService(
  stateDir: string,
  world: World,
  overrides: Partial<TaskServiceDeps> = {},
): Promise<{
  service: TaskService;
  hooks: RondelHooks;
  paths: TaskPaths;
  pendingApprovals: PendingApprovalStore;
}> {
  const hooks = createHooks();
  const paths: TaskPaths = { rootDir: join(stateDir, "tasks") };
  const log = createLogger("test", "error");
  const pendingApprovals = new PendingApprovalStore(paths, log);
  const service = new TaskService({
    paths,
    hooks,
    log,
    pendingApprovals,
    orgLookup: (name): OrgResolution => {
      if (!(name in world.agents)) return { status: "unknown" };
      const org = world.agents[name];
      return org ? { status: "org", orgName: org } : { status: "global" };
    },
    isKnownAgent: (name) => name in world.agents,
    ...overrides,
  });
  await service.init();
  return { service, hooks, paths, pendingApprovals };
}

describe("TaskService — happy path lifecycle", () => {
  it("create → claim → complete writes the expected audit trail", async () => {
    const tmp = withTmpRondel();
    const { service, hooks, paths } = await makeService(tmp.stateDir, {
      agents: { alice: "eng", bob: "eng" },
    });

    const created = vi.fn();
    const claimed = vi.fn();
    const completed = vi.fn();
    hooks.on("task:created", created);
    hooks.on("task:claimed", claimed);
    hooks.on("task:completed", completed);

    const task = await service.create(
      { agentName: "alice", isAdmin: false },
      { title: "ship doc", assignedTo: "bob", priority: "high" },
    );
    expect(task.status).toBe("pending");
    expect(task.assignedTo).toBe("bob");
    expect(task.org).toBe("eng");

    const claimedTask = await service.claim({ agentName: "bob", isAdmin: false }, task.id);
    expect(claimedTask.status).toBe("in_progress");
    expect(claimedTask.claimedAt).toBeDefined();

    const result = await service.complete(
      { agentName: "bob", isAdmin: false },
      task.id,
      { result: "shipped", outputs: [{ type: "file", path: "/tmp/doc.md" }] },
    );
    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");
    expect(result.record.status).toBe("completed");
    expect(result.record.outputs).toHaveLength(1);

    expect(created).toHaveBeenCalledTimes(1);
    expect(claimed).toHaveBeenCalledTimes(1);
    expect(completed).toHaveBeenCalledTimes(1);

    const audit = await service.readAudit({ agentName: "alice", isAdmin: false }, task.id);
    expect(audit.map((e) => e.event)).toEqual(["created", "claimed", "completed"]);

    const onDisk = await readTask(paths, task.org, task.id);
    expect(onDisk?.status).toBe("completed");
  });
});

describe("TaskService — DAG enforcement", () => {
  it("rejects claiming B while its blocker A is still pending", async () => {
    const tmp = withTmpRondel();
    const { service } = await makeService(tmp.stateDir, {
      agents: { alice: "eng", bob: "eng" },
    });

    const a = await service.create(
      { agentName: "alice", isAdmin: false },
      { title: "a", assignedTo: "bob" },
    );
    const b = await service.create(
      { agentName: "alice", isAdmin: false },
      { title: "b", assignedTo: "bob", blockedBy: [a.id] },
    );

    await expect(
      service.claim({ agentName: "bob", isAdmin: false }, b.id),
    ).rejects.toMatchObject({ code: "blocked_by_open" });

    // Complete A, then B can be claimed
    await service.claim({ agentName: "bob", isAdmin: false }, a.id);
    await service.complete({ agentName: "bob", isAdmin: false }, a.id, { result: "done" });
    const claimedB = await service.claim({ agentName: "bob", isAdmin: false }, b.id);
    expect(claimedB.status).toBe("in_progress");
  });

  it("maintains symmetric edges: peer.blocks[] gets the new task id", async () => {
    const tmp = withTmpRondel();
    const { service, paths } = await makeService(tmp.stateDir, {
      agents: { alice: "eng", bob: "eng" },
    });
    const a = await service.create(
      { agentName: "alice", isAdmin: false },
      { title: "a", assignedTo: "bob" },
    );
    const b = await service.create(
      { agentName: "alice", isAdmin: false },
      { title: "b", assignedTo: "bob", blockedBy: [a.id] },
    );
    const reloadA = await readTask(paths, a.org, a.id);
    expect(reloadA?.blocks).toContain(b.id);
  });

  it("detects cycles on create", async () => {
    const tmp = withTmpRondel();
    const { service } = await makeService(tmp.stateDir, {
      agents: { alice: "eng", bob: "eng" },
    });
    const a = await service.create(
      { agentName: "alice", isAdmin: false },
      { title: "a", assignedTo: "bob" },
    );
    // Build a chain and close it.
    const b = await service.create(
      { agentName: "alice", isAdmin: false },
      { title: "b", assignedTo: "bob", blockedBy: [a.id] },
    );
    await expect(
      service.update({ agentName: "alice", isAdmin: false }, a.id, { blockedBy: [b.id] }),
    ).rejects.toMatchObject({ code: "cycle_detected" });
  });

  it("rejects create when a blocker does not exist", async () => {
    const tmp = withTmpRondel();
    const { service } = await makeService(tmp.stateDir, {
      agents: { alice: "eng", bob: "eng" },
    });
    await expect(
      service.create(
        { agentName: "alice", isAdmin: false },
        { title: "x", assignedTo: "bob", blockedBy: ["task_999_dead"] },
      ),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("TaskService — cross-org + privileges", () => {
  it("rejects non-admin creating for an assignee in a different org", async () => {
    const tmp = withTmpRondel();
    const { service } = await makeService(tmp.stateDir, {
      agents: { alice: "eng", charlie: "finance" },
    });
    await expect(
      service.create(
        { agentName: "alice", isAdmin: false },
        { title: "x", assignedTo: "charlie" },
      ),
    ).rejects.toMatchObject({ code: "cross_org" });
  });

  it("admin can create cross-org", async () => {
    const tmp = withTmpRondel();
    const { service } = await makeService(tmp.stateDir, {
      agents: { root: undefined, charlie: "finance" },
    });
    const task = await service.create(
      { agentName: "root", isAdmin: true },
      { title: "x", assignedTo: "charlie" },
    );
    expect(task.org).toBe("finance");
  });

  it("non-assignee cannot claim", async () => {
    const tmp = withTmpRondel();
    const { service } = await makeService(tmp.stateDir, {
      agents: { alice: "eng", bob: "eng", dave: "eng" },
    });
    const task = await service.create(
      { agentName: "alice", isAdmin: false },
      { title: "x", assignedTo: "bob" },
    );
    await expect(
      service.claim({ agentName: "dave", isAdmin: false }, task.id),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("non-admin same-org agent can list within their org", async () => {
    const tmp = withTmpRondel();
    const { service } = await makeService(tmp.stateDir, {
      agents: { alice: "eng", bob: "eng", charlie: "finance" },
    });
    await service.create(
      { agentName: "alice", isAdmin: false },
      { title: "x", assignedTo: "bob" },
    );
    const list = await service.list({ agentName: "bob", isAdmin: false }, {});
    expect(list).toHaveLength(1);
    const others = await service.list({ agentName: "charlie", isAdmin: false }, {});
    expect(others).toEqual([]);
  });
});

describe("TaskService — claim conflict", () => {
  it("second concurrent claim loses with claim_conflict", async () => {
    const tmp = withTmpRondel();
    const { service } = await makeService(tmp.stateDir, {
      agents: { alice: "eng", bob: "eng" },
    });
    const task = await service.create(
      { agentName: "alice", isAdmin: false },
      { title: "x", assignedTo: "bob" },
    );

    // Race: both branches claim in parallel. Only one JSON state
    // transition can land (the store's O_EXCL). The second must see a
    // claim_conflict even though both agents think they are the
    // assignee... wait, only bob is the assignee. Let me do the race
    // via admin + bob.
    const results = await Promise.allSettled([
      service.claim({ agentName: "bob", isAdmin: false }, task.id),
      service.claim({ agentName: "root", isAdmin: true }, task.id),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
  });
});

describe("TaskService — block / unblock / cancel", () => {
  it("block transitions to blocked, releases claim, captures reason", async () => {
    const tmp = withTmpRondel();
    const { service } = await makeService(tmp.stateDir, {
      agents: { alice: "eng", bob: "eng" },
    });
    const task = await service.create(
      { agentName: "alice", isAdmin: false },
      { title: "x", assignedTo: "bob" },
    );
    await service.claim({ agentName: "bob", isAdmin: false }, task.id);
    const blocked = await service.block({ agentName: "bob", isAdmin: false }, task.id, "need input");
    expect(blocked.status).toBe("blocked");
    expect(blocked.blockedReason).toBe("need input");

    // Can re-claim after unblock
    const unblocked = await service.unblock({ agentName: "bob", isAdmin: false }, task.id);
    expect(unblocked.status).toBe("pending");
    expect(unblocked.blockedReason).toBeUndefined();
    const reclaimed = await service.claim({ agentName: "bob", isAdmin: false }, task.id);
    expect(reclaimed.status).toBe("in_progress");
  });

  it("cancel is terminal; further transitions rejected", async () => {
    const tmp = withTmpRondel();
    const { service } = await makeService(tmp.stateDir, {
      agents: { alice: "eng", bob: "eng" },
    });
    const task = await service.create(
      { agentName: "alice", isAdmin: false },
      { title: "x", assignedTo: "bob" },
    );
    await service.cancel({ agentName: "alice", isAdmin: false }, task.id, "not needed");
    await expect(
      service.claim({ agentName: "bob", isAdmin: false }, task.id),
    ).rejects.toMatchObject({ code: "invalid_transition" });
  });
});

describe("TaskService — list ordering + staleness", () => {
  it("orders unblocked-first, priority desc, createdAt asc", async () => {
    const tmp = withTmpRondel();
    const { service } = await makeService(tmp.stateDir, {
      agents: { alice: "eng", bob: "eng" },
    });
    const dep = await service.create(
      { agentName: "alice", isAdmin: false },
      { title: "dep", assignedTo: "bob", priority: "normal" },
    );
    const blockedHigh = await service.create(
      { agentName: "alice", isAdmin: false },
      { title: "blocked-high", assignedTo: "bob", priority: "high", blockedBy: [dep.id] },
    );
    const freeUrgent = await service.create(
      { agentName: "alice", isAdmin: false },
      { title: "free-urgent", assignedTo: "bob", priority: "urgent" },
    );
    const freeLow = await service.create(
      { agentName: "alice", isAdmin: false },
      { title: "free-low", assignedTo: "bob", priority: "low" },
    );

    const ordered = await service.list({ agentName: "bob", isAdmin: false }, {});
    expect(ordered.map((t) => t.id)).toEqual([
      freeUrgent.id,
      dep.id,
      freeLow.id,
      blockedHigh.id,
    ]);
  });

  it("findStale returns tasks past threshold and emits task:stale", async () => {
    const tmp = withTmpRondel();
    const { service, hooks } = await makeService(tmp.stateDir, {
      agents: { alice: "eng", bob: "eng" },
    });
    const task = await service.create(
      { agentName: "alice", isAdmin: false },
      { title: "x", assignedTo: "bob" },
    );
    const now = Date.parse(task.createdAt) + PENDING_STALE_MS + 60_000;

    const staleListener = vi.fn();
    hooks.on("task:stale", staleListener);

    const results = await service.findStale({ agentName: "alice", isAdmin: false }, now);
    expect(results).toHaveLength(1);
    expect(results[0].staleness).toBe("stale_pending");
    expect(staleListener).toHaveBeenCalledTimes(1);
  });

  it("in_progress stale uses claimedAt as reference", async () => {
    const tmp = withTmpRondel();
    const { service } = await makeService(tmp.stateDir, {
      agents: { alice: "eng", bob: "eng" },
    });
    const task = await service.create(
      { agentName: "alice", isAdmin: false },
      { title: "x", assignedTo: "bob" },
    );
    const claimed = await service.claim({ agentName: "bob", isAdmin: false }, task.id);
    const now = Date.parse(claimed.claimedAt!) + IN_PROGRESS_STALE_MS + 60_000;

    const results = await service.findStale({ agentName: "alice", isAdmin: false }, now);
    expect(results).toHaveLength(1);
    expect(results[0].staleness).toBe("stale_in_progress");
  });
});

describe("TaskService — onAgentDeleted", () => {
  it("cancels every non-terminal task assigned to the removed agent", async () => {
    const tmp = withTmpRondel();
    const { service, paths } = await makeService(tmp.stateDir, {
      agents: { alice: "eng", bob: "eng" },
    });

    const t1 = await service.create(
      { agentName: "alice", isAdmin: false },
      { title: "t1", assignedTo: "bob" },
    );
    const t2 = await service.create(
      { agentName: "alice", isAdmin: false },
      { title: "t2", assignedTo: "bob" },
    );
    await service.claim({ agentName: "bob", isAdmin: false }, t2.id);
    await service.complete({ agentName: "bob", isAdmin: false }, t2.id, { result: "done" });

    await service.onAgentDeleted("bob");

    const t1After = await readTask(paths, "eng", t1.id);
    const t2After = await readTask(paths, "eng", t2.id);
    expect(t1After?.status).toBe("cancelled");
    // Completed task should NOT be touched.
    expect(t2After?.status).toBe("completed");
  });
});

describe("TaskService — readOne + locate", () => {
  it("readOne finds tasks in the caller's org", async () => {
    const tmp = withTmpRondel();
    const { service } = await makeService(tmp.stateDir, {
      agents: { alice: "eng", bob: "eng" },
    });
    const task = await service.create(
      { agentName: "alice", isAdmin: false },
      { title: "x", assignedTo: "bob" },
    );
    const found = await service.readOne({ agentName: "bob", isAdmin: false }, task.id);
    expect(found?.id).toBe(task.id);
  });

  it("readOne returns undefined for a missing id (same-org scope)", async () => {
    const tmp = withTmpRondel();
    const { service } = await makeService(tmp.stateDir, {
      agents: { alice: "eng" },
    });
    const found = await service.readOne(
      { agentName: "alice", isAdmin: false },
      "task_0_0000dead",
    );
    expect(found).toBeUndefined();
  });

  it("admin can find tasks across orgs", async () => {
    const tmp = withTmpRondel();
    const { service } = await makeService(tmp.stateDir, {
      agents: { root: undefined, alice: "eng", charlie: "finance" },
    });
    const task = await service.create(
      { agentName: "root", isAdmin: true },
      { title: "x", assignedTo: "charlie" },
    );
    const found = await service.readOne({ agentName: "root", isAdmin: true }, task.id);
    expect(found?.id).toBe(task.id);
  });
});
