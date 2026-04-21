/**
 * Integration tests for the /tasks/* HTTP routes.
 *
 * Boots a real Bridge + real TaskService + real ApprovalService against
 * a tmpdir. Drives the endpoints with fetch. Asserts the HTTP wire
 * contract (status codes mapping from TaskError, body validation,
 * caller identity from query/body, 503 when the service is absent).
 *
 * Pattern source: bridge-heartbeats.integration.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { Bridge } from "./bridge.js";
import { AgentManager } from "../agents/agent-manager.js";
import { ApprovalService } from "../approvals/index.js";
import { PendingApprovalStore, TaskService } from "../tasks/index.js";
import { createHooks } from "../shared/hooks.js";
import { withTmpRondel, type TmpRondelHandle } from "../../tests/helpers/tmp.js";
import { createCapturingLogger } from "../../tests/helpers/logger.js";
import { makeAgentConfig } from "../../tests/helpers/fixtures.js";
import type { DiscoveredAgent } from "../shared/types/index.js";
import type { OrgResolution } from "../shared/org-isolation.js";
import type { ChannelRegistry } from "../channels/core/registry.js";

interface BootResult {
  bridge: Bridge;
  url: string;
  mgr: AgentManager;
  approvals: ApprovalService;
  tasks?: TaskService;
  tmp: TmpRondelHandle;
}

function silentChannels(): ChannelRegistry {
  return { get: () => undefined } as unknown as ChannelRegistry;
}

async function bootBridge(
  tmp: TmpRondelHandle,
  agents: DiscoveredAgent[],
  opts: { attachTasks?: boolean } = { attachTasks: true },
): Promise<BootResult> {
  const log = createCapturingLogger();
  const mgr = new AgentManager(log);
  await mgr.initialize(tmp.rondelHome, agents, []);
  const hooks = createHooks();

  const approvals = new ApprovalService({
    paths: {
      pendingDir: `${tmp.stateDir}/approvals/pending`,
      resolvedDir: `${tmp.stateDir}/approvals/resolved`,
    },
    hooks,
    channels: silentChannels(),
    resolveAccountId: () => undefined,
    log,
  });
  await approvals.init();

  const orgLookup = (name: string): OrgResolution => {
    if (!mgr.getTemplate(name)) return { status: "unknown" };
    const org = mgr.getAgentOrg(name);
    return org ? { status: "org", orgName: org.orgName } : { status: "global" };
  };

  let tasks: TaskService | undefined;
  if (opts.attachTasks !== false) {
    const taskPaths = { rootDir: `${tmp.stateDir}/tasks` };
    const pendingApprovals = new PendingApprovalStore(taskPaths, log);
    tasks = new TaskService({
      paths: taskPaths,
      hooks,
      log,
      orgLookup,
      isKnownAgent: (name) => mgr.getTemplate(name) !== undefined,
      pendingApprovals,
      approvals,
    });
    await tasks.init();
  }

  const bridge = new Bridge(
    mgr,
    log,
    tmp.rondelHome,
    hooks,
    undefined, // router
    undefined, // ledgerStream
    undefined, // agentStateStream
    approvals,
    undefined, // readFileState
    undefined, // fileHistory
    undefined, // approvalStream
    undefined, // schedules
    undefined, // scheduleStream
    undefined, // heartbeats
    undefined, // heartbeatStream
    tasks,
  );
  await bridge.start();
  return { bridge, url: bridge.getUrl(), mgr, approvals, tasks, tmp };
}

function makeGlobalAgent(tmp: TmpRondelHandle, name: string): DiscoveredAgent {
  const agentDir = tmp.mkAgent(name, { "AGENT.md": `# ${name}` });
  return {
    agentName: name,
    agentDir,
    config: makeAgentConfig({ agentName: name, channels: [] }),
  };
}

function makeOrgAgent(tmp: TmpRondelHandle, org: string, name: string): DiscoveredAgent {
  const { agentDir, orgDir } = tmp.mkOrgAgent(org, name, { "AGENT.md": `# ${name}` });
  return {
    agentName: name,
    agentDir,
    config: makeAgentConfig({ agentName: name, channels: [] }),
    orgName: org,
    orgDir,
  };
}

async function post(
  url: string,
  path: string,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as Record<string, unknown>;
  return { status: res.status, json };
}

async function get(
  url: string,
  path: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${url}${path}`);
  const json = (await res.json()) as Record<string, unknown>;
  return { status: res.status, json };
}

describe("Bridge — POST /tasks/create + lifecycle", () => {
  let tmp: TmpRondelHandle;
  let boot: BootResult;

  beforeEach(async () => {
    tmp = withTmpRondel();
    boot = await bootBridge(tmp, [
      makeOrgAgent(tmp, "eng", "alice"),
      makeOrgAgent(tmp, "eng", "bob"),
    ]);
  });

  afterEach(() => {
    boot.bridge.stop();
    boot.mgr.stopAll();
  });

  it("round-trips create → claim → complete over HTTP", async () => {
    const create = await post(boot.url, "/tasks/create", {
      callerAgent: "alice",
      title: "ship doc",
      assignedTo: "bob",
      priority: "high",
    });
    expect(create.status).toBe(200);
    const task = (create.json as { task: { id: string } }).task;
    expect(task.id).toMatch(/^task_\d+_[a-f0-9]+$/);

    const claim = await post(boot.url, `/tasks/${task.id}/claim`, { callerAgent: "bob" });
    expect(claim.status).toBe(200);
    expect((claim.json as { task: { status: string } }).task.status).toBe("in_progress");

    const done = await post(boot.url, `/tasks/${task.id}/complete`, {
      callerAgent: "bob",
      result: "shipped",
    });
    expect(done.status).toBe(200);
    expect(done.json.status).toBe("completed");
  });

  it("returns 409 on claim conflict", async () => {
    const create = await post(boot.url, "/tasks/create", {
      callerAgent: "alice",
      title: "x",
      assignedTo: "bob",
    });
    const id = (create.json as { task: { id: string } }).task.id;
    const first = await post(boot.url, `/tasks/${id}/claim`, { callerAgent: "bob" });
    expect(first.status).toBe(200);
    // Same agent re-claiming is idempotent in the store, but the
    // service rejects on invalid_transition (status is now in_progress).
    const second = await post(boot.url, `/tasks/${id}/claim`, { callerAgent: "bob" });
    expect(second.status).toBe(409);
  });

  it("returns 409 on cycle detection", async () => {
    const a = await post(boot.url, "/tasks/create", {
      callerAgent: "alice",
      title: "a",
      assignedTo: "bob",
    });
    const aid = (a.json as { task: { id: string } }).task.id;
    const b = await post(boot.url, "/tasks/create", {
      callerAgent: "alice",
      title: "b",
      assignedTo: "bob",
      blockedBy: [aid],
    });
    const bid = (b.json as { task: { id: string } }).task.id;

    const bad = await post(boot.url, `/tasks/${aid}/update`, {
      callerAgent: "alice",
      blockedBy: [bid],
    });
    expect(bad.status).toBe(409);
    expect(bad.json.code).toBe("cycle_detected");
  });

  it("returns 400 on malformed body", async () => {
    const res = await post(boot.url, "/tasks/create", { callerAgent: "alice" });
    expect(res.status).toBe(400);
  });
});

describe("Bridge — GET /tasks + cross-org", () => {
  let tmp: TmpRondelHandle;
  let boot: BootResult;

  beforeEach(async () => {
    tmp = withTmpRondel();
    boot = await bootBridge(tmp, [
      makeOrgAgent(tmp, "eng", "alice"),
      makeOrgAgent(tmp, "eng", "bob"),
      makeOrgAgent(tmp, "finance", "charlie"),
    ]);
  });

  afterEach(() => {
    boot.bridge.stop();
    boot.mgr.stopAll();
  });

  it("GET /tasks/:org returns same-org tasks", async () => {
    await post(boot.url, "/tasks/create", {
      callerAgent: "alice",
      title: "t",
      assignedTo: "bob",
    });
    const { status, json } = await get(
      boot.url,
      "/tasks/eng?callerAgent=bob",
    );
    expect(status).toBe(200);
    const tasks = (json as { tasks: unknown[] }).tasks;
    expect(tasks).toHaveLength(1);
  });

  it("GET /tasks/:org filtered to 0 when caller is in a different org", async () => {
    await post(boot.url, "/tasks/create", {
      callerAgent: "alice",
      title: "t",
      assignedTo: "bob",
    });
    const { status, json } = await get(
      boot.url,
      "/tasks/eng?callerAgent=charlie",
    );
    // list() scopes by caller's org when non-admin — charlie's org is
    // finance, so even querying /tasks/eng yields empty.
    expect(status).toBe(200);
    expect((json as { tasks: unknown[] }).tasks).toEqual([]);
  });

  it("GET /tasks/:org/:id returns 404 for missing, 200 for present", async () => {
    const create = await post(boot.url, "/tasks/create", {
      callerAgent: "alice",
      title: "t",
      assignedTo: "bob",
    });
    const id = (create.json as { task: { id: string } }).task.id;

    const hit = await get(boot.url, `/tasks/eng/${id}?callerAgent=bob`);
    expect(hit.status).toBe(200);
    expect((hit.json as { task: { id: string } }).task.id).toBe(id);

    const miss = await get(boot.url, `/tasks/eng/task_0_deadbeef?callerAgent=bob`);
    expect(miss.status).toBe(404);
  });

  it("GET /tasks/:org/:id with includeAudit=true returns the audit log", async () => {
    const create = await post(boot.url, "/tasks/create", {
      callerAgent: "alice",
      title: "t",
      assignedTo: "bob",
    });
    const id = (create.json as { task: { id: string } }).task.id;
    const { json } = await get(
      boot.url,
      `/tasks/eng/${id}?callerAgent=bob&includeAudit=true`,
    );
    const audit = (json as { audit: unknown[] }).audit;
    expect(Array.isArray(audit)).toBe(true);
    expect(audit!.length).toBeGreaterThanOrEqual(1);
  });
});

describe("Bridge — 503 when service is absent", () => {
  it("returns 503 for /tasks/create when no TaskService", async () => {
    const tmp = withTmpRondel();
    const boot = await bootBridge(
      tmp,
      [makeOrgAgent(tmp, "eng", "alice"), makeOrgAgent(tmp, "eng", "bob")],
      { attachTasks: false },
    );
    try {
      const { status } = await post(boot.url, "/tasks/create", {
        callerAgent: "alice",
        title: "x",
        assignedTo: "bob",
      });
      expect(status).toBe(503);
    } finally {
      boot.bridge.stop();
      boot.mgr.stopAll();
    }
  });
});

describe("Bridge — approval-pending response", () => {
  it("returns 200 with status: approval_pending for externalAction tasks", async () => {
    const tmp = withTmpRondel();
    const boot = await bootBridge(tmp, [
      makeOrgAgent(tmp, "eng", "alice"),
      makeOrgAgent(tmp, "eng", "bob"),
    ]);
    try {
      const create = await post(boot.url, "/tasks/create", {
        callerAgent: "alice",
        title: "x",
        assignedTo: "bob",
        externalAction: true,
      });
      const id = (create.json as { task: { id: string } }).task.id;
      await post(boot.url, `/tasks/${id}/claim`, { callerAgent: "bob" });
      const done = await post(boot.url, `/tasks/${id}/complete`, {
        callerAgent: "bob",
        result: "shipped",
      });
      expect(done.status).toBe(200);
      expect(done.json.status).toBe("approval_pending");
      expect(String(done.json.approvalRequestId)).toMatch(/^appr_/);
    } finally {
      boot.bridge.stop();
      boot.mgr.stopAll();
    }
  });
});
