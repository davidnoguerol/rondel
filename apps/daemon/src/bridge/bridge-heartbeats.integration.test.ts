/**
 * Integration tests for the `/heartbeats/*` HTTP routes.
 *
 * Focus: the bridge handlers that back the `rondel_heartbeat_update` and
 * `rondel_heartbeat_read_all` MCP tools + the web dashboard's fleet view.
 * These tests boot a real Bridge HTTP server + real HeartbeatService
 * (wired to a real disk under `os.tmpdir()`), then drive the endpoints
 * with `fetch`.
 *
 * The existing HeartbeatService integration tests assert semantic
 * contracts (org isolation, missing agents, health classification). This
 * file asserts the HTTP wire contract:
 *
 *   - status codes map from HeartbeatError codes (unknown → 404,
 *     cross_org → 403) vs validateBody failures (malformed → 400)
 *   - caller identity is read from query params / body, not fabricated
 *   - 503 is returned when the bridge was constructed without a
 *     HeartbeatService (defensive branch)
 *   - the handler's orgLookup closure is driven off the real
 *     AgentManager, so cross-org isolation works end-to-end
 *
 * Pattern source: bridge-prompt.integration.test.ts +
 * bridge-skill-reload.integration.test.ts.
 *
 * What's deferred: the SSE tail (`GET /heartbeats/tail`) — covered by
 * `heartbeat-stream.unit.test.ts` at the source level; asserting the
 * full SSE wire format here would duplicate the generic SSE handler
 * tests. The tail endpoint is the subject of a separate integration
 * test only if the per-agent filter closure ever grows non-trivial
 * logic.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { Bridge } from "./bridge.js";
import { AgentManager } from "../agents/agent-manager.js";
import { HeartbeatService } from "../heartbeats/index.js";
import { createHooks } from "../shared/hooks.js";
import { withTmpRondel, type TmpRondelHandle } from "../../tests/helpers/tmp.js";
import { createCapturingLogger } from "../../tests/helpers/logger.js";
import { makeAgentConfig } from "../../tests/helpers/fixtures.js";
import type { DiscoveredAgent } from "../shared/types/index.js";
import type { OrgResolution } from "../shared/org-isolation.js";

// Constant interval for deterministic assertions.
const INTERVAL_MS = 4 * 60 * 60 * 1000;

interface BootResult {
  bridge: Bridge;
  url: string;
  mgr: AgentManager;
  heartbeats: HeartbeatService;
}

async function bootBridge(
  tmp: TmpRondelHandle,
  agents: DiscoveredAgent[],
  opts: { attachHeartbeats?: boolean } = { attachHeartbeats: true },
): Promise<BootResult> {
  const log = createCapturingLogger();
  const mgr = new AgentManager(log);
  await mgr.initialize(tmp.rondelHome, agents, []);

  const hooks = createHooks();
  const heartbeats = new HeartbeatService({
    paths: { dir: `${tmp.stateDir}/heartbeats` },
    hooks,
    log,
    // Drive org resolution off the real AgentManager so cross-org tests
    // match production behaviour.
    orgLookup: (name): OrgResolution => {
      if (!mgr.getTemplate(name)) return { status: "unknown" };
      const org = mgr.getAgentOrg(name);
      return org ? { status: "org", orgName: org.orgName } : { status: "global" };
    },
    isKnownAgent: (name) => mgr.getTemplate(name) !== undefined,
    listAllAgents: () => mgr.getAgentNames(),
    resolveIntervalMs: () => INTERVAL_MS,
  });
  await heartbeats.init();

  // Bridge constructor takes positional args; these tests exercise the
  // heartbeat HTTP endpoints only (POST /heartbeats/update, GET
  // /heartbeats/:org[/:agent]) which flow through the service — no SSE.
  const bridge = new Bridge(
    mgr,
    log,
    tmp.rondelHome,
    undefined, // hooks
    undefined, // router
    undefined, // approvals
    undefined, // readFileState
    undefined, // fileHistory
    undefined, // schedules
    opts.attachHeartbeats ? heartbeats : undefined,
    undefined, // tasks
    undefined, // multiplexStream
  );
  await bridge.start();
  return { bridge, url: bridge.getUrl(), mgr, heartbeats };
}

function makeGlobalAgent(tmp: TmpRondelHandle, name: string): DiscoveredAgent {
  const agentDir = tmp.mkAgent(name, { "AGENT.md": `# ${name}\nhi` });
  return {
    agentName: name,
    agentDir,
    config: makeAgentConfig({ agentName: name, channels: [] }),
  };
}

function makeOrgAgent(
  tmp: TmpRondelHandle,
  org: string,
  name: string,
): DiscoveredAgent {
  const { agentDir, orgDir } = tmp.mkOrgAgent(org, name, { "AGENT.md": `# ${name}` });
  return {
    agentName: name,
    agentDir,
    config: makeAgentConfig({ agentName: name, channels: [] }),
    // Both orgName AND orgDir are required for AgentManager.initialize
    // to wire the agent into its org registry. Mirrors what the
    // discovery scan produces for an agent found under workspaces/{org}/agents/.
    orgName: org,
    orgDir,
  };
}

describe("Bridge — POST /heartbeats/update", () => {
  let tmp: TmpRondelHandle;
  let boot: BootResult;

  beforeEach(async () => {
    tmp = withTmpRondel();
    boot = await bootBridge(tmp, [makeGlobalAgent(tmp, "kai")]);
  });

  afterEach(() => {
    boot.bridge.stop();
    boot.mgr.stopAll();
  });

  async function post(body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await fetch(`${boot.url}/heartbeats/update`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as Record<string, unknown>;
    return { status: res.status, json };
  }

  it("returns 200 and persists the record for a valid self-write", async () => {
    const { status, json } = await post({
      callerAgent: "kai",
      status: "in flow",
      currentTask: "ingestion",
    });
    expect(status).toBe(200);
    expect((json as { record: { agent: string; status: string } }).record.agent).toBe("kai");
    expect((json as { record: { status: string } }).record.status).toBe("in flow");

    // Service-side read confirms the write hit disk through the real
    // HeartbeatService (not just the in-memory response).
    const roundTrip = await boot.heartbeats.readOne(
      { agentName: "kai", isAdmin: false },
      "kai",
    );
    expect(roundTrip?.status).toBe("in flow");
    expect(roundTrip?.intervalMs).toBe(INTERVAL_MS);
  });

  it("returns 400 when the body is missing required fields", async () => {
    const { status, json } = await post({ callerAgent: "kai" });
    expect(status).toBe(400);
    expect(String(json.error)).toMatch(/status/);
  });

  it("returns 400 when callerAgent violates the name regex", async () => {
    const { status, json } = await post({
      callerAgent: "-bad",
      status: "hi",
    });
    expect(status).toBe(400);
    expect(String(json.error)).toMatch(/callerAgent/);
  });

  it("returns 400 when status is empty", async () => {
    const { status, json } = await post({
      callerAgent: "kai",
      status: "",
    });
    expect(status).toBe(400);
    expect(String(json.error)).toMatch(/status/);
  });

  it("returns 404 when callerAgent is not a registered agent", async () => {
    // HeartbeatError('unknown_agent') must map to 404, not 400 —
    // Zod accepted the name format, only the agent-existence check fails.
    const { status, json } = await post({
      callerAgent: "ghost",
      status: "hi",
    });
    expect(status).toBe(404);
    expect(json.code).toBe("unknown_agent");
  });

  it("returns 503 when the bridge has no HeartbeatService", async () => {
    // Tear down the default bridge and boot one without heartbeats
    // wired in. The handler's defensive branch must surface 503 rather
    // than crash with an undefined dereference.
    boot.bridge.stop();
    boot.mgr.stopAll();
    boot = await bootBridge(tmp, [makeGlobalAgent(tmp, "kai")], {
      attachHeartbeats: false,
    });

    const { status, json } = await post({ callerAgent: "kai", status: "x" });
    expect(status).toBe(503);
    expect(String(json.error)).toMatch(/not available/i);
  });
});

describe("Bridge — GET /heartbeats/:org and /heartbeats/:org/:agent", () => {
  let tmp: TmpRondelHandle;
  let boot: BootResult;

  beforeEach(async () => {
    tmp = withTmpRondel();
    boot = await bootBridge(tmp, [
      makeGlobalAgent(tmp, "kai"),
      makeGlobalAgent(tmp, "ada"),
      makeOrgAgent(tmp, "acme", "brooks"),
    ]);
    // Seed one healthy record so readAll has something to return.
    await boot.heartbeats.update(
      { agentName: "kai", isAdmin: false },
      { status: "alive" },
    );
  });

  afterEach(() => {
    boot.bridge.stop();
    boot.mgr.stopAll();
  });

  async function get(path: string): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await fetch(`${boot.url}${path}`);
    const json = (await res.json()) as Record<string, unknown>;
    return { status: res.status, json };
  }

  it("returns 200 with records + missing + summary when an admin queries a reachable org", async () => {
    // Fleet reads are admin-only — see design §4 / service readAll gating.
    const { status, json } = await get("/heartbeats/global?callerAgent=kai&isAdmin=true");
    expect(status).toBe(200);

    const records = (json as { records: Array<{ agent: string; health: string }> }).records;
    expect(records.map((r) => r.agent).sort()).toEqual(["kai"]);
    expect(records[0].health).toBe("healthy");

    expect((json as { missing: string[] }).missing.sort()).toEqual(["ada"]);
    expect(json.summary).toEqual({ healthy: 1, stale: 0, down: 0, missing: 1 });
  });

  it("returns 403 when a non-admin attempts a fleet read", async () => {
    // Non-admins never get a fleet answer, even for their own org.
    const { status, json } = await get("/heartbeats/global?callerAgent=kai");
    expect(status).toBe(403);
    expect(json.code).toBe("forbidden");
  });

  it("returns 200 for a single-agent GET", async () => {
    const { status, json } = await get("/heartbeats/global/kai?callerAgent=kai");
    expect(status).toBe(200);
    expect((json as { agent: string }).agent).toBe("kai");
    expect((json as { health: string }).health).toBe("healthy");
  });

  it("returns 404 when the agent exists but has no heartbeat record", async () => {
    const { status, json } = await get("/heartbeats/global/ada?callerAgent=kai");
    expect(status).toBe(404);
    expect(String(json.error)).toMatch(/ada/);
  });

  it("returns 404 when the target agent is not registered", async () => {
    const { status, json } = await get("/heartbeats/global/ghost?callerAgent=kai");
    expect(status).toBe(404);
    expect(json.code).toBe("unknown_agent");
  });

  it("returns 400 when callerAgent is missing from the query string", async () => {
    const { status, json } = await get("/heartbeats/global");
    expect(status).toBe(400);
    expect(String(json.error)).toMatch(/callerAgent/);
  });

  it("returns 403 when a non-admin asks for a different org (fleet read is admin-only)", async () => {
    // Non-admin readAll is rejected outright — the forbidden-first check
    // runs before any cross-org bookkeeping, so the HTTP body reflects
    // the admin gate, not the org mismatch.
    const { status, json } = await get("/heartbeats/acme?callerAgent=kai");
    expect(status).toBe(403);
    expect(json.code).toBe("forbidden");
  });

  it("allows a global caller to single-agent read into an org (global can message any)", async () => {
    // `readOne` uses the shared `checkOrgIsolation` rule: "either side
    // global → allowed". Since `kai` is global and `brooks` is `acme`,
    // this is permitted without admin. The stricter non-global-to-
    // different-org cross-org case is exercised by
    // `heartbeat-service.integration.test.ts` where both sides are
    // non-global orgs.
    await boot.heartbeats.update(
      { agentName: "brooks", isAdmin: false },
      { status: "alive" },
    );
    const { status, json } = await get("/heartbeats/acme/brooks?callerAgent=kai");
    expect(status).toBe(200);
    expect((json as { agent: string }).agent).toBe("brooks");
  });

  it("admin cross-org read returns 200", async () => {
    // Seed a record in the other org so readAll has content.
    await boot.heartbeats.update(
      { agentName: "brooks", isAdmin: false },
      { status: "alive" },
    );
    const { status, json } = await get(
      "/heartbeats/acme?callerAgent=kai&isAdmin=true",
    );
    expect(status).toBe(200);
    const records = (json as { records: Array<{ agent: string }> }).records;
    expect(records.map((r) => r.agent)).toEqual(["brooks"]);
  });

  it("returns 503 when the bridge has no HeartbeatService", async () => {
    boot.bridge.stop();
    boot.mgr.stopAll();
    boot = await bootBridge(tmp, [makeGlobalAgent(tmp, "kai")], {
      attachHeartbeats: false,
    });

    const { status, json } = await get("/heartbeats/global?callerAgent=kai");
    expect(status).toBe(503);
    expect(String(json.error)).toMatch(/not available/i);
  });
});
