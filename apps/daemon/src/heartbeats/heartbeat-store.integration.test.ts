/**
 * Integration tests for the heartbeat store — real temp directories,
 * real file I/O. Mirrors approval-store.integration.test.ts in shape.
 */

import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import {
  writeHeartbeat,
  readHeartbeat,
  listHeartbeats,
  removeHeartbeat,
  type HeartbeatPaths,
} from "./heartbeat-store.js";
import type { HeartbeatRecord } from "../shared/types/heartbeats.js";
import { withTmpRondel } from "../../../../tests/helpers/tmp.js";

function paths(stateDir: string): HeartbeatPaths {
  return { dir: join(stateDir, "heartbeats") };
}

function record(agent: string, overrides: Partial<HeartbeatRecord> = {}): HeartbeatRecord {
  return {
    agent,
    org: "global",
    status: "alive",
    updatedAt: new Date().toISOString(),
    intervalMs: 4 * 60 * 60 * 1000,
    ...overrides,
  };
}

describe("heartbeat-store", () => {
  it("writeHeartbeat → readHeartbeat round-trip", async () => {
    const tmp = withTmpRondel();
    const p = paths(tmp.stateDir);
    await mkdir(p.dir, { recursive: true });

    const r = record("kai", { status: "in flow", currentTask: "rewrite", notes: "see pr 42" });
    await writeHeartbeat(p, r);

    const read = await readHeartbeat(p, "kai");
    expect(read).toEqual(r);
  });

  it("writeHeartbeat overwrites an existing record atomically", async () => {
    const tmp = withTmpRondel();
    const p = paths(tmp.stateDir);
    await mkdir(p.dir, { recursive: true });

    await writeHeartbeat(p, record("kai", { status: "first" }));
    await writeHeartbeat(p, record("kai", { status: "second" }));

    const read = await readHeartbeat(p, "kai");
    expect(read?.status).toBe("second");
  });

  it("readHeartbeat returns undefined for unknown agent (no file)", async () => {
    const tmp = withTmpRondel();
    const p = paths(tmp.stateDir);
    await mkdir(p.dir, { recursive: true });

    const read = await readHeartbeat(p, "nobody");
    expect(read).toBeUndefined();
  });

  it("listHeartbeats on missing directory returns []", async () => {
    const tmp = withTmpRondel();
    // Intentionally do NOT mkdir — listHeartbeats must tolerate it.
    const p = paths(tmp.stateDir);
    const all = await listHeartbeats(p);
    expect(all).toEqual([]);
  });

  it("listHeartbeats skips malformed JSON without throwing", async () => {
    const tmp = withTmpRondel();
    const p = paths(tmp.stateDir);
    await mkdir(p.dir, { recursive: true });
    await writeHeartbeat(p, record("ok"));
    await writeFile(join(p.dir, "bad.json"), "{not valid json");

    const all = await listHeartbeats(p);
    expect(all.map((r) => r.agent)).toEqual(["ok"]);
  });

  it("listHeartbeats skips records that fail schema validation", async () => {
    const tmp = withTmpRondel();
    const p = paths(tmp.stateDir);
    await mkdir(p.dir, { recursive: true });
    await writeHeartbeat(p, record("ok"));
    // Missing required `updatedAt`.
    await writeFile(
      join(p.dir, "bogus.json"),
      JSON.stringify({ agent: "bogus", org: "global", status: "x", intervalMs: 1 }),
    );

    const all = await listHeartbeats(p);
    expect(all.map((r) => r.agent)).toEqual(["ok"]);
  });

  it("removeHeartbeat is idempotent", async () => {
    const tmp = withTmpRondel();
    const p = paths(tmp.stateDir);
    await mkdir(p.dir, { recursive: true });
    await writeHeartbeat(p, record("kai"));

    await removeHeartbeat(p, "kai");
    await removeHeartbeat(p, "kai"); // no throw

    expect(await readHeartbeat(p, "kai")).toBeUndefined();
  });

  it("rejects invalid agent names (path-traversal defense)", async () => {
    const tmp = withTmpRondel();
    const p = paths(tmp.stateDir);
    await mkdir(p.dir, { recursive: true });

    // Synthesize a record that would bypass the name-check if writeHeartbeat
    // read the agent from the record without validating.
    const bad = record("../escape");
    await expect(writeHeartbeat(p, bad)).rejects.toThrow(/Invalid agent name/);
  });
});
