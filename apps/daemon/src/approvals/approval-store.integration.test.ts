import { describe, it, expect } from "vitest";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  writePending,
  writeResolved,
  readPending,
  readResolved,
  readAny,
  listPending,
  listResolved,
  removePending,
  type ApprovalPaths,
} from "./approval-store.js";
import type { ToolUseApprovalRecord } from "./types.js";
import { withTmpRondel } from "../../tests/helpers/tmp.js";

function paths(stateDir: string): ApprovalPaths {
  return {
    pendingDir: join(stateDir, "approvals", "pending"),
    resolvedDir: join(stateDir, "approvals", "resolved"),
  };
}

/** Counter-based test ID generator matching the real `appr_<epoch>_<hex>` format. */
let idSeq = 0;
function testId(label?: string): string {
  const hex = (++idSeq).toString(16).padStart(8, "0");
  return `appr_${label ?? "0000000000"}_${hex}`;
}

function makeRecord(overrides: Partial<ToolUseApprovalRecord> = {}): ToolUseApprovalRecord {
  return {
    requestId: testId(),
    status: "pending",
    agentName: "bot1",
    channelType: "telegram",
    chatId: "123",
    toolName: "Bash",
    toolInput: { command: "ls" },
    summary: "Bash: ls",
    reason: "dangerous_bash",
    createdAt: "2026-04-15T12:00:00.000Z",
    ...overrides,
  };
}

describe("approval-store", () => {
  it("writes and reads pending records", async () => {
    const tmp = withTmpRondel();
    const p = paths(tmp.stateDir);
    const record = makeRecord();

    await writePending(p, record);

    const loaded = await readPending(p, record.requestId);
    expect(loaded).toBeDefined();
    expect(loaded?.requestId).toBe(record.requestId);
    expect(loaded?.toolName).toBe("Bash");
    expect(loaded?.reason).toBe("dangerous_bash");
  });

  it("writes pending to pending/ directory, not resolved/", async () => {
    const tmp = withTmpRondel();
    const p = paths(tmp.stateDir);
    const id = testId("1713200042");
    await writePending(p, makeRecord({ requestId: id }));

    const pendingFile = await readFile(join(p.pendingDir, `${id}.json`), "utf-8");
    expect(JSON.parse(pendingFile).requestId).toBe(id);

    // Resolved dir shouldn't have it
    const resolvedStat = await stat(join(p.resolvedDir, `${id}.json`)).catch(() => null);
    expect(resolvedStat).toBeNull();
  });

  it("resolves: write pending, write resolved, remove pending", async () => {
    const tmp = withTmpRondel();
    const p = paths(tmp.stateDir);
    const record = makeRecord();
    await writePending(p, record);

    const resolved: ToolUseApprovalRecord = {
      ...record,
      status: "resolved",
      decision: "allow",
      resolvedAt: "2026-04-15T12:01:00.000Z",
      resolvedBy: "telegram:5948773741",
    };
    await writeResolved(p, resolved);
    await removePending(p, record.requestId);

    const pendingAfter = await readPending(p, record.requestId);
    expect(pendingAfter).toBeUndefined();

    const resolvedAfter = await readResolved(p, record.requestId);
    expect(resolvedAfter?.decision).toBe("allow");
    expect(resolvedAfter?.resolvedBy).toBe("telegram:5948773741");
  });

  it("readAny prefers resolved when both exist", async () => {
    const tmp = withTmpRondel();
    const p = paths(tmp.stateDir);
    const id = testId("1713200099");
    const pending = makeRecord({ requestId: id, summary: "PENDING VERSION" });
    const resolved = makeRecord({
      requestId: id,
      status: "resolved",
      summary: "RESOLVED VERSION",
      decision: "allow",
      resolvedAt: "2026-04-15T12:01:00.000Z",
    });
    await writePending(p, pending);
    await writeResolved(p, resolved);

    const loaded = await readAny(p, id);
    expect(loaded?.summary).toBe("RESOLVED VERSION");
    expect(loaded?.decision).toBe("allow");
  });

  it("listPending returns records sorted by createdAt ascending", async () => {
    const tmp = withTmpRondel();
    const p = paths(tmp.stateDir);
    const idA = testId("1713200001");
    const idB = testId("1713200002");
    const idC = testId("1713200003");
    await writePending(p, makeRecord({ requestId: idA, createdAt: "2026-04-15T12:00:02Z" }));
    await writePending(p, makeRecord({ requestId: idB, createdAt: "2026-04-15T12:00:01Z" }));
    await writePending(p, makeRecord({ requestId: idC, createdAt: "2026-04-15T12:00:03Z" }));

    const list = await listPending(p);
    expect(list.map((r) => r.requestId)).toEqual([idB, idA, idC]);
  });

  it("listResolved returns newest-first and honors the limit", async () => {
    const tmp = withTmpRondel();
    const p = paths(tmp.stateDir);
    const id1 = testId("1713200010");
    const id2 = testId("1713200020");
    const id3 = testId("1713200030");
    await writeResolved(p, makeRecord({
      requestId: id1, status: "resolved", createdAt: "2026-04-15T12:00:01Z", decision: "allow",
    }));
    await writeResolved(p, makeRecord({
      requestId: id2, status: "resolved", createdAt: "2026-04-15T12:00:03Z", decision: "deny",
    }));
    await writeResolved(p, makeRecord({
      requestId: id3, status: "resolved", createdAt: "2026-04-15T12:00:02Z", decision: "allow",
    }));

    const list = await listResolved(p);
    expect(list.map((r) => r.requestId)).toEqual([id2, id3, id1]);

    const limited = await listResolved(p, 2);
    expect(limited).toHaveLength(2);
    expect(limited[0].requestId).toBe(id2);
  });

  it("listPending returns empty when directory is missing", async () => {
    const tmp = withTmpRondel();
    const p = paths(tmp.stateDir);
    const list = await listPending(p);
    expect(list).toEqual([]);
  });

  it("removePending is idempotent", async () => {
    const tmp = withTmpRondel();
    const p = paths(tmp.stateDir);
    // Neither file exists yet — must not throw (uses a valid format)
    await expect(removePending(p, "appr_0000000000_00000000")).resolves.toBeUndefined();

    const id = testId("1713200050");
    await writePending(p, makeRecord({ requestId: id }));
    await removePending(p, id);
    // Second remove is a no-op
    await expect(removePending(p, id)).resolves.toBeUndefined();

    const files = await readdir(p.pendingDir).catch(() => [] as string[]);
    expect(files).not.toContain(`${id}.json`);
  });

  it("rejects invalid requestId format (path traversal protection)", async () => {
    const tmp = withTmpRondel();
    const p = paths(tmp.stateDir);

    // Traversal attempts
    await expect(readPending(p, "../../../etc/passwd")).rejects.toThrow("Invalid requestId format");
    await expect(readPending(p, "appr_123")).rejects.toThrow("Invalid requestId format");
    await expect(readPending(p, "")).rejects.toThrow("Invalid requestId format");
    await expect(readPending(p, "not_an_appr_id")).rejects.toThrow("Invalid requestId format");
  });
});
