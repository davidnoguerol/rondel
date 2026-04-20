/**
 * Integration tests for the pending-approval store — round-trip
 * persistence, restart survival, corruption recovery, version
 * mismatch handling.
 */

import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { PendingApprovalStore } from "./pending-approval-store.js";
import { pendingApprovalsPath, type TaskPaths } from "./task-store.js";
import type { PendingApprovalEntry } from "../shared/types/tasks.js";
import { createLogger, type Logger } from "../shared/logger.js";
import { withTmpRondel } from "../../../../tests/helpers/tmp.js";

function paths(stateDir: string): TaskPaths {
  return { rootDir: join(stateDir, "tasks") };
}

function silent(): Logger {
  return createLogger("test", "error");
}

function makeEntry(overrides: Partial<PendingApprovalEntry> = {}): PendingApprovalEntry {
  return {
    taskId: "task_1_00000001",
    approvalRequestId: "appr_1_abcd",
    org: "global",
    createdAt: "2026-04-20T12:00:00Z",
    completionInput: { result: "done", outputs: [] },
    ...overrides,
  };
}

describe("pending-approval-store", () => {
  it("throws if used before init", () => {
    const tmp = withTmpRondel();
    const store = new PendingApprovalStore(paths(tmp.stateDir), silent());
    expect(() => store.list("global")).toThrow(/init/);
  });

  it("round-trips add → list → remove within one init", async () => {
    const tmp = withTmpRondel();
    const store = new PendingApprovalStore(paths(tmp.stateDir), silent());
    await store.init();

    await store.add("global", makeEntry());
    expect(store.list("global")).toHaveLength(1);
    expect(store.findByTaskId("global", "task_1_00000001")).toBeDefined();
    expect(store.findByApprovalId("appr_1_abcd")).toBeDefined();

    await store.remove("global", "task_1_00000001");
    expect(store.list("global")).toEqual([]);
    expect(store.findByApprovalId("appr_1_abcd")).toBeUndefined();
  });

  it("survives a simulated restart (new store reads what the old one wrote)", async () => {
    const tmp = withTmpRondel();
    const p = paths(tmp.stateDir);

    const first = new PendingApprovalStore(p, silent());
    await first.init();
    await first.add("engineering", makeEntry({
      taskId: "task_2_00000002",
      approvalRequestId: "appr_2_ffff",
      org: "engineering",
    }));

    // Simulate daemon restart: construct a second store on the same path.
    const second = new PendingApprovalStore(p, silent());
    await second.init();

    const entries = second.list("engineering");
    expect(entries).toHaveLength(1);
    expect(entries[0].approvalRequestId).toBe("appr_2_ffff");
    expect(second.findByApprovalId("appr_2_ffff")).toBeDefined();
  });

  it("listAll flattens across orgs", async () => {
    const tmp = withTmpRondel();
    const store = new PendingApprovalStore(paths(tmp.stateDir), silent());
    await store.init();
    await store.add("engineering", makeEntry({ taskId: "task_3_01", org: "engineering" }));
    await store.add("finance", makeEntry({ taskId: "task_3_02", org: "finance", approvalRequestId: "appr_3_a" }));
    expect(store.listAll()).toHaveLength(2);
  });

  it("replaces a prior entry for the same (org, taskId) — re-completion after denial", async () => {
    const tmp = withTmpRondel();
    const store = new PendingApprovalStore(paths(tmp.stateDir), silent());
    await store.init();
    const taskId = "task_4_00000004";
    await store.add("global", makeEntry({ taskId, approvalRequestId: "appr_first" }));
    await store.add("global", makeEntry({ taskId, approvalRequestId: "appr_second" }));
    const entries = store.list("global");
    expect(entries).toHaveLength(1);
    expect(entries[0].approvalRequestId).toBe("appr_second");
  });

  it("remove is idempotent", async () => {
    const tmp = withTmpRondel();
    const store = new PendingApprovalStore(paths(tmp.stateDir), silent());
    await store.init();
    await expect(store.remove("global", "task_missing_00000000")).resolves.toBeUndefined();
  });

  it("starts empty when the file is corrupt JSON (no throw, logs warning)", async () => {
    const tmp = withTmpRondel();
    const p = paths(tmp.stateDir);
    // Pre-seed a corrupt file
    await mkdir(join(p.rootDir, "global"), { recursive: true });
    await writeFile(pendingApprovalsPath(p, "global"), "{not json", "utf-8");

    const store = new PendingApprovalStore(p, silent());
    await expect(store.init()).resolves.toBeUndefined();
    expect(store.list("global")).toEqual([]);

    // A subsequent add overwrites cleanly.
    await store.add("global", makeEntry());
    expect(store.list("global")).toHaveLength(1);
  });

  it("starts empty on a version mismatch", async () => {
    const tmp = withTmpRondel();
    const p = paths(tmp.stateDir);
    await mkdir(join(p.rootDir, "global"), { recursive: true });
    await writeFile(
      pendingApprovalsPath(p, "global"),
      JSON.stringify({ version: 99, entries: [makeEntry()] }),
      "utf-8",
    );

    const store = new PendingApprovalStore(p, silent());
    await store.init();
    expect(store.list("global")).toEqual([]);
  });

  it("persists an empty file after the last entry is removed (explicit {entries: []})", async () => {
    const tmp = withTmpRondel();
    const p = paths(tmp.stateDir);
    const store = new PendingApprovalStore(p, silent());
    await store.init();
    await store.add("global", makeEntry());
    await store.remove("global", "task_1_00000001");

    const raw = await readFile(pendingApprovalsPath(p, "global"), "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed).toEqual({ version: 1, entries: [] });
  });
});
