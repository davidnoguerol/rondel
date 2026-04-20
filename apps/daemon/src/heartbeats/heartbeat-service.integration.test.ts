/**
 * HeartbeatService integration tests — real disk, real hooks, in-memory
 * org/agent lookups. Verifies the service's contract with the rest of
 * Rondel: writes emit `heartbeat:updated`, reads respect org isolation,
 * `readAll` surfaces missing agents, `removeForAgent` cleans the file.
 */

import { describe, it, expect, vi } from "vitest";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { HeartbeatService, HeartbeatError, type HeartbeatServiceDeps } from "./heartbeat-service.js";
import { listHeartbeats, readHeartbeat, type HeartbeatPaths } from "./heartbeat-store.js";
import { createHooks } from "../shared/hooks.js";
import { createLogger } from "../shared/logger.js";
import type { OrgResolution } from "../shared/org-isolation.js";
import { withTmpRondel } from "../../../../tests/helpers/tmp.js";

interface FakeWorld {
  /** agentName → org name, or undefined for global. */
  readonly agents: Record<string, string | undefined>;
}

function makeService(
  stateDir: string,
  world: FakeWorld,
  overrides: Partial<HeartbeatServiceDeps> = {},
) {
  const hooks = createHooks();
  const paths: HeartbeatPaths = { dir: join(stateDir, "heartbeats") };
  const service = new HeartbeatService({
    paths,
    hooks,
    log: createLogger("test"),
    orgLookup: (name): OrgResolution => {
      if (!(name in world.agents)) return { status: "unknown" };
      const org = world.agents[name];
      return org ? { status: "org", orgName: org } : { status: "global" };
    },
    isKnownAgent: (name) => name in world.agents,
    listAllAgents: () => Object.keys(world.agents),
    resolveIntervalMs: () => 4 * 60 * 60 * 1000,
    ...overrides,
  });
  return { service, hooks, paths };
}

describe("HeartbeatService", () => {
  it("init creates the heartbeats directory", async () => {
    const tmp = withTmpRondel();
    const { service, paths } = makeService(tmp.stateDir, { agents: { kai: undefined } });

    await service.init();
    // Should be callable — listHeartbeats should not throw.
    const list = await listHeartbeats(paths);
    expect(list).toEqual([]);
  });

  it("update writes the record and emits heartbeat:updated", async () => {
    const tmp = withTmpRondel();
    const { service, hooks, paths } = makeService(tmp.stateDir, { agents: { kai: undefined } });
    await service.init();

    const listener = vi.fn();
    hooks.on("heartbeat:updated", listener);

    const record = await service.update(
      { agentName: "kai", isAdmin: false },
      { status: "in flow", currentTask: "ingestion", notes: "see pr 42" },
    );

    expect(record.agent).toBe("kai");
    expect(record.org).toBe("global");
    expect(record.status).toBe("in flow");
    expect(record.intervalMs).toBe(4 * 60 * 60 * 1000);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0].record).toEqual(record);

    const onDisk = await readHeartbeat(paths, "kai");
    expect(onDisk).toEqual(record);
  });

  it("update rejects unknown callers", async () => {
    const tmp = withTmpRondel();
    const { service } = makeService(tmp.stateDir, { agents: { kai: undefined } });
    await service.init();

    await expect(
      service.update({ agentName: "ghost", isAdmin: false }, { status: "x" }),
    ).rejects.toMatchObject({ code: "unknown_agent" });
  });

  it("readAll returns records with health, missing agents, and counts", async () => {
    const tmp = withTmpRondel();
    const { service } = makeService(tmp.stateDir, {
      agents: { kai: undefined, ada: undefined, ghost: undefined },
    });
    await service.init();

    await service.update({ agentName: "kai", isAdmin: false }, { status: "fresh" });
    // `ada` never writes — missing.
    // Fake a stale `ghost` record by writing directly.
    const oldTs = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
    const ghostRecord = {
      agent: "ghost",
      org: "global",
      status: "silent",
      updatedAt: oldTs,
      intervalMs: 4 * 60 * 60 * 1000,
    };
    const { writeHeartbeat } = await import("./heartbeat-store.js");
    await writeHeartbeat({ dir: join(tmp.stateDir, "heartbeats") }, ghostRecord);

    const result = await service.readAll({ agentName: "kai", isAdmin: true });
    expect(result.records).toHaveLength(2);

    const byAgent = new Map(result.records.map((r) => [r.agent, r]));
    expect(byAgent.get("kai")?.health).toBe("healthy");
    expect(byAgent.get("ghost")?.health).toBe("stale");
    expect(result.missing).toEqual(["ada"]);
    expect(result.summary).toEqual({ healthy: 1, stale: 1, down: 0, missing: 1 });
  });

  it("readAll rejects non-admin callers outright (fleet reads are admin-only)", async () => {
    const tmp = withTmpRondel();
    const { service } = makeService(tmp.stateDir, {
      agents: { kai: "acme", other: "otherco" },
    });
    await service.init();
    await service.update({ agentName: "kai", isAdmin: false }, { status: "alive" });

    // Non-admin is rejected regardless of which org they target (own or other).
    await expect(
      service.readAll({ agentName: "kai", isAdmin: false }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      service.readAll({ agentName: "kai", isAdmin: false }, { org: "otherco" }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("readAll rejects forged caller identities (unknown agent)", async () => {
    const tmp = withTmpRondel();
    const { service } = makeService(tmp.stateDir, {
      agents: { kai: undefined },
    });
    await service.init();

    // A forged `callerAgent` that doesn't exist in the registry must be
    // rejected even with isAdmin=true — defense-in-depth against a
    // caller that sets both query params arbitrarily.
    await expect(
      service.readAll({ agentName: "ghost", isAdmin: true }),
    ).rejects.toMatchObject({ code: "unknown_agent" });
  });

  it("readAll allows admin cross-org read", async () => {
    const tmp = withTmpRondel();
    const { service } = makeService(tmp.stateDir, {
      agents: { kai: "acme", other: "otherco" },
    });
    await service.init();
    await service.update({ agentName: "other", isAdmin: false }, { status: "hello" });

    const result = await service.readAll(
      { agentName: "kai", isAdmin: true },
      { org: "otherco" },
    );
    expect(result.records.map((r) => r.agent)).toEqual(["other"]);
    expect(result.summary.healthy).toBe(1);
  });

  it("readOne returns the record with health fields", async () => {
    const tmp = withTmpRondel();
    const { service } = makeService(tmp.stateDir, { agents: { kai: undefined } });
    await service.init();
    await service.update({ agentName: "kai", isAdmin: false }, { status: "alive" });

    const r = await service.readOne({ agentName: "kai", isAdmin: false }, "kai");
    expect(r).toBeDefined();
    expect(r?.health).toBe("healthy");
    expect(typeof r?.ageMs).toBe("number");
  });

  it("readOne returns undefined when the agent hasn't written a beat yet", async () => {
    const tmp = withTmpRondel();
    const { service } = makeService(tmp.stateDir, { agents: { kai: undefined } });
    await service.init();

    const r = await service.readOne({ agentName: "kai", isAdmin: false }, "kai");
    expect(r).toBeUndefined();
  });

  it("readOne cross-org: non-admin rejected", async () => {
    const tmp = withTmpRondel();
    const { service } = makeService(tmp.stateDir, {
      agents: { a: "acme", b: "otherco" },
    });
    await service.init();
    await service.update({ agentName: "b", isAdmin: false }, { status: "hi" });

    await expect(
      service.readOne({ agentName: "a", isAdmin: false }, "b"),
    ).rejects.toMatchObject({ code: "cross_org" });
  });

  it("removeForAgent deletes the record (idempotent)", async () => {
    const tmp = withTmpRondel();
    const { service, paths } = makeService(tmp.stateDir, { agents: { kai: undefined } });
    await service.init();
    await service.update({ agentName: "kai", isAdmin: false }, { status: "alive" });

    await service.removeForAgent("kai");
    expect(await readHeartbeat(paths, "kai")).toBeUndefined();
    // Second call is idempotent.
    await service.removeForAgent("kai");
  });

  it("resolveIntervalMs is captured on the record", async () => {
    const tmp = withTmpRondel();
    const { service } = makeService(
      tmp.stateDir,
      { agents: { kai: undefined } },
      { resolveIntervalMs: () => 30 * 60 * 1000 },
    );
    await service.init();
    const r = await service.update({ agentName: "kai", isAdmin: false }, { status: "x" });
    expect(r.intervalMs).toBe(30 * 60 * 1000);
  });
});

describe("HeartbeatError", () => {
  it("preserves the code and the name", () => {
    const err = new HeartbeatError("unknown_agent", "nope");
    expect(err.name).toBe("HeartbeatError");
    expect(err.code).toBe("unknown_agent");
  });
});
