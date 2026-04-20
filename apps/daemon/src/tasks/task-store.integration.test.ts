/**
 * Integration tests for the task store — file I/O + atomic claim race
 * + audit append concurrency. No mocks; uses `withTmpRondel` for an
 * isolated tmpdir per test.
 */

import { describe, it, expect } from "vitest";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  appendAudit,
  assertOrgName,
  assertTaskId,
  listAllTasks,
  listTasks,
  readAudit,
  readClaim,
  readTask,
  releaseClaim,
  removeTask,
  tryClaim,
  writeTask,
  type TaskPaths,
} from "./task-store.js";
import type { TaskAuditEntry, TaskRecord } from "../shared/types/tasks.js";
import { withTmpRondel } from "../../../../tests/helpers/tmp.js";

function paths(stateDir: string): TaskPaths {
  return { rootDir: join(stateDir, "tasks") };
}

let idSeq = 0;
function testId(): string {
  const hex = (++idSeq).toString(16).padStart(8, "0");
  return `task_${Date.now()}_${hex}`;
}

function makeRecord(overrides: Partial<TaskRecord> & { id?: string; org?: string } = {}): TaskRecord {
  const id = overrides.id ?? testId();
  const org = overrides.org ?? "global";
  return {
    version: 1,
    id,
    org,
    title: "T",
    description: "",
    status: "pending",
    priority: "normal",
    createdBy: "alice",
    assignedTo: "alice",
    createdAt: "2026-04-20T12:00:00Z",
    updatedAt: "2026-04-20T12:00:00Z",
    blockedBy: [],
    blocks: [],
    externalAction: false,
    outputs: [],
    ...overrides,
    id,
    org,
  };
}

// ---------------------------------------------------------------------------
// ID / org gatekeeping
// ---------------------------------------------------------------------------

describe("task-store — id + org gatekeeping", () => {
  it("rejects malformed task ids (path traversal protection)", () => {
    expect(() => assertTaskId("../../../etc/passwd")).toThrow("Invalid task id");
    expect(() => assertTaskId("")).toThrow("Invalid task id");
    expect(() => assertTaskId("task_abc_def")).toThrow("Invalid task id");
    expect(() => assertTaskId("task_123")).toThrow("Invalid task id");
  });

  it("accepts a valid task id", () => {
    expect(() => assertTaskId("task_123_abcd1234")).not.toThrow();
  });

  it("rejects crafted org names", () => {
    expect(() => assertOrgName("../escape")).toThrow("Invalid org name");
    expect(() => assertOrgName("")).toThrow("Invalid org name");
    expect(() => assertOrgName("/absolute")).toThrow("Invalid org name");
  });

  it("accepts standard org names", () => {
    expect(() => assertOrgName("global")).not.toThrow();
    expect(() => assertOrgName("engineering")).not.toThrow();
    expect(() => assertOrgName("my-org_42")).not.toThrow();
  });

  it("throws at the store boundary when a write is attempted with a bad id", async () => {
    const tmp = withTmpRondel();
    const p = paths(tmp.stateDir);
    const record = makeRecord({ id: "bogus" });
    await expect(writeTask(p, record)).rejects.toThrow("Invalid task id");
  });

  it("throws at the store boundary when a read is attempted with a bad id", async () => {
    const tmp = withTmpRondel();
    const p = paths(tmp.stateDir);
    await expect(readTask(p, "global", "../../oops")).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Task record — write / read / list / remove
// ---------------------------------------------------------------------------

describe("task-store — record CRUD", () => {
  it("writes and reads back a record", async () => {
    const tmp = withTmpRondel();
    const p = paths(tmp.stateDir);
    const record = makeRecord({ title: "hello" });
    await writeTask(p, record);
    const loaded = await readTask(p, record.org, record.id);
    expect(loaded).toBeDefined();
    expect(loaded?.title).toBe("hello");
  });

  it("returns undefined for a missing task file", async () => {
    const tmp = withTmpRondel();
    const p = paths(tmp.stateDir);
    const loaded = await readTask(p, "global", testId());
    expect(loaded).toBeUndefined();
  });

  it("returns undefined for a malformed record (does not throw)", async () => {
    const tmp = withTmpRondel();
    const p = paths(tmp.stateDir);
    const record = makeRecord();
    await writeTask(p, record);
    // Corrupt the file
    const filePath = join(p.rootDir, record.org, `${record.id}.json`);
    await writeFile(filePath, "not json at all");
    const loaded = await readTask(p, record.org, record.id);
    expect(loaded).toBeUndefined();
  });

  it("returns undefined when schema validation fails", async () => {
    const tmp = withTmpRondel();
    const p = paths(tmp.stateDir);
    const record = makeRecord();
    await writeTask(p, record);
    const filePath = join(p.rootDir, record.org, `${record.id}.json`);
    await writeFile(filePath, JSON.stringify({ version: 1, id: record.id, org: record.org }));
    const loaded = await readTask(p, record.org, record.id);
    expect(loaded).toBeUndefined();
  });

  it("listTasks returns every valid record in the org dir, skipping non-task files", async () => {
    const tmp = withTmpRondel();
    const p = paths(tmp.stateDir);
    const a = makeRecord();
    const b = makeRecord();
    await writeTask(p, a);
    await writeTask(p, b);
    // Drop a junk file — must not explode or be returned
    await writeFile(join(p.rootDir, "global", "not-a-task.txt"), "junk");
    const list = await listTasks(p, "global");
    expect(list).toHaveLength(2);
    expect(list.map((t) => t.id).sort()).toEqual([a.id, b.id].sort());
  });

  it("listTasks returns [] for a missing org directory", async () => {
    const tmp = withTmpRondel();
    const p = paths(tmp.stateDir);
    const list = await listTasks(p, "global");
    expect(list).toEqual([]);
  });

  it("listAllTasks flattens every org", async () => {
    const tmp = withTmpRondel();
    const p = paths(tmp.stateDir);
    await writeTask(p, makeRecord({ org: "engineering" }));
    await writeTask(p, makeRecord({ org: "finance" }));
    const all = await listAllTasks(p);
    expect(all).toHaveLength(2);
  });

  it("removeTask deletes the file and is idempotent", async () => {
    const tmp = withTmpRondel();
    const p = paths(tmp.stateDir);
    const record = makeRecord();
    await writeTask(p, record);
    await removeTask(p, record.org, record.id);
    const loaded = await readTask(p, record.org, record.id);
    expect(loaded).toBeUndefined();
    // Idempotent
    await expect(removeTask(p, record.org, record.id)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Claim lockfile — O_EXCL
// ---------------------------------------------------------------------------

describe("task-store — claim lockfile", () => {
  it("first claim wins; second loses with holder info", async () => {
    const tmp = withTmpRondel();
    const p = paths(tmp.stateDir);
    const record = makeRecord();
    await writeTask(p, record);

    const first = await tryClaim(p, record.org, record.id, "alice");
    const second = await tryClaim(p, record.org, record.id, "bob");

    expect(first.claimed).toBe(true);
    expect(second.claimed).toBe(false);
    expect(second.holderAgent).toBe("alice");
    expect(second.holderAt).toBeDefined();
  });

  it("is idempotent when the same agent re-claims", async () => {
    const tmp = withTmpRondel();
    const p = paths(tmp.stateDir);
    const record = makeRecord();
    await writeTask(p, record);
    const first = await tryClaim(p, record.org, record.id, "alice");
    const second = await tryClaim(p, record.org, record.id, "alice");
    expect(first.claimed).toBe(true);
    expect(second.claimed).toBe(true);
  });

  it("N=20 concurrent claims produce exactly one winner", async () => {
    const tmp = withTmpRondel();
    const p = paths(tmp.stateDir);
    const record = makeRecord();
    await writeTask(p, record);

    const agents = Array.from({ length: 20 }, (_, i) => `agent_${i}`);
    const results = await Promise.all(
      agents.map((a) => tryClaim(p, record.org, record.id, a)),
    );

    const winners = results.filter((r) => r.claimed);
    expect(winners).toHaveLength(1);

    const losers = results.filter((r) => !r.claimed);
    expect(losers).toHaveLength(19);
    for (const l of losers) {
      expect(l.holderAgent).toBeDefined();
      // Holder must be one of the agents — not a made-up name
      expect(agents).toContain(l.holderAgent);
    }
  });

  it("releaseClaim unlocks and allows a subsequent claim", async () => {
    const tmp = withTmpRondel();
    const p = paths(tmp.stateDir);
    const record = makeRecord();
    await writeTask(p, record);
    await tryClaim(p, record.org, record.id, "alice");
    await releaseClaim(p, record.org, record.id);
    const after = await tryClaim(p, record.org, record.id, "bob");
    expect(after.claimed).toBe(true);
  });

  it("releaseClaim is idempotent when no lock exists", async () => {
    const tmp = withTmpRondel();
    const p = paths(tmp.stateDir);
    const record = makeRecord();
    await writeTask(p, record);
    await expect(releaseClaim(p, record.org, record.id)).resolves.toBeUndefined();
  });

  it("readClaim returns the current holder + timestamp", async () => {
    const tmp = withTmpRondel();
    const p = paths(tmp.stateDir);
    const record = makeRecord();
    await writeTask(p, record);
    await tryClaim(p, record.org, record.id, "alice");
    const holder = await readClaim(p, record.org, record.id);
    expect(holder?.agent).toBe("alice");
    expect(holder?.ts).toBeDefined();
  });

  it("readClaim returns undefined when unclaimed", async () => {
    const tmp = withTmpRondel();
    const p = paths(tmp.stateDir);
    const record = makeRecord();
    await writeTask(p, record);
    const holder = await readClaim(p, record.org, record.id);
    expect(holder).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Audit log — append-only JSONL
// ---------------------------------------------------------------------------

describe("task-store — audit log", () => {
  function makeAudit(overrides: Partial<TaskAuditEntry> = {}): TaskAuditEntry {
    return {
      ts: "2026-04-20T12:00:00Z",
      event: "created",
      by: "alice",
      ...overrides,
    };
  }

  it("appends entries in order", async () => {
    const tmp = withTmpRondel();
    const p = paths(tmp.stateDir);
    const record = makeRecord();
    await writeTask(p, record);
    await appendAudit(p, record.org, record.id, makeAudit({ event: "created" }));
    await appendAudit(p, record.org, record.id, makeAudit({ event: "claimed", by: "bob" }));
    await appendAudit(p, record.org, record.id, makeAudit({ event: "completed", by: "bob" }));

    const audit = await readAudit(p, record.org, record.id);
    expect(audit.map((e) => e.event)).toEqual(["created", "claimed", "completed"]);
  });

  it("returns [] for a task with no audit log", async () => {
    const tmp = withTmpRondel();
    const p = paths(tmp.stateDir);
    const record = makeRecord();
    await writeTask(p, record);
    const audit = await readAudit(p, record.org, record.id);
    expect(audit).toEqual([]);
  });

  it("skips malformed audit lines but returns the good ones", async () => {
    const tmp = withTmpRondel();
    const p = paths(tmp.stateDir);
    const record = makeRecord();
    await writeTask(p, record);
    await appendAudit(p, record.org, record.id, makeAudit({ event: "created" }));

    // Corrupt one line in the middle, then append a second good line
    const auditFile = join(p.rootDir, record.org, "audit", `${record.id}.jsonl`);
    const existing = await readFile(auditFile, "utf-8");
    await writeFile(auditFile, existing + "{this is not valid json\n" + JSON.stringify({ ts: "2026-04-20T13:00:00Z", event: "claimed", by: "bob" }) + "\n");

    const audit = await readAudit(p, record.org, record.id);
    expect(audit.map((e) => e.event)).toEqual(["created", "claimed"]);
  });

  it("concurrent appends land all lines intact", async () => {
    const tmp = withTmpRondel();
    const p = paths(tmp.stateDir);
    const record = makeRecord();
    await writeTask(p, record);

    // 50 concurrent appends; POSIX appendFile is atomic for small
    // records so all lines should be present and parseable.
    const entries = Array.from({ length: 50 }, (_, i) =>
      makeAudit({
        ts: `2026-04-20T12:00:${String(i).padStart(2, "0")}Z`,
        event: "updated",
        by: `agent_${i}`,
      }),
    );
    await Promise.all(entries.map((e) => appendAudit(p, record.org, record.id, e)));

    const audit = await readAudit(p, record.org, record.id);
    expect(audit).toHaveLength(50);
    const byAgents = audit.map((e) => e.by);
    expect(new Set(byAgents).size).toBe(50); // all distinct
  });
});

// ---------------------------------------------------------------------------
// Directory helpers
// ---------------------------------------------------------------------------

describe("task-store — directory init", () => {
  it("creates org dirs on first write", async () => {
    const tmp = withTmpRondel();
    const p = paths(tmp.stateDir);
    const record = makeRecord({ org: "engineering" });
    await writeTask(p, record);

    // All four subdirs (org + claims + audit) should exist, though the
    // pending-approvals JSON only lands when the pending-approval-store
    // writes.
    const orgEntries = await readdir(join(p.rootDir, "engineering"));
    expect(orgEntries).toContain(".claims");
    expect(orgEntries).toContain("audit");
    expect(orgEntries.some((f) => f.endsWith(".json"))).toBe(true);
  });
});
