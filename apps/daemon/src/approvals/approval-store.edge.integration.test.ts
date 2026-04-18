import { describe, it, expect } from "vitest";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  writePending,
  writeResolved,
  readPending,
  readAny,
  listPending,
  listResolved,
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

// IDs must match /^appr_\d+_[a-f0-9]+$/ per assertRequestId()
let idCounter = 0;
function nextId(prefix = "appr"): string {
  idCounter++;
  return `${prefix}_${1000000 + idCounter}_abcd${idCounter.toString(16).padStart(4, "0")}`;
}

function makeToolUseRecord(overrides: Partial<ToolUseApprovalRecord> = {}): ToolUseApprovalRecord {
  return {
    requestId: nextId(),
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

describe("approval-store — malformed JSON handling", () => {
  it("returns undefined when a pending file contains invalid JSON", async () => {
    const tmp = withTmpRondel();
    const p = paths(tmp.stateDir);

    const id = nextId();
    await writePending(p, makeToolUseRecord({ requestId: id }));
    // Corrupt the file after writing
    writeFileSync(join(p.pendingDir, `${id}.json`), "{ broken json !!!");

    const result = await readPending(p, id);
    expect(result).toBeUndefined();
  });

  it("skips malformed files in listPending without crashing", async () => {
    const tmp = withTmpRondel();
    const p = paths(tmp.stateDir);

    const goodId = nextId();
    await writePending(p, makeToolUseRecord({ requestId: goodId }));
    // Write a corrupt file alongside the good one
    writeFileSync(join(p.pendingDir, "appr_999_bad1.json"), "NOT JSON AT ALL");

    const list = await listPending(p);
    expect(list).toHaveLength(1);
    expect(list[0].requestId).toBe(goodId);
  });

  it("skips malformed files in listResolved without crashing", async () => {
    const tmp = withTmpRondel();
    const p = paths(tmp.stateDir);

    const goodId = nextId();
    await writeResolved(p, makeToolUseRecord({ requestId: goodId, status: "resolved", decision: "allow" }));
    writeFileSync(join(p.resolvedDir, "appr_999_bad2.json"), "{{{");

    const list = await listResolved(p);
    expect(list).toHaveLength(1);
    expect(list[0].requestId).toBe(goodId);
  });
});

describe("approval-store — non-json files in directories", () => {
  it("listPending ignores non-.json files", async () => {
    const tmp = withTmpRondel();
    const p = paths(tmp.stateDir);

    const id = nextId();
    await writePending(p, makeToolUseRecord({ requestId: id }));
    // Write non-json files — should be ignored
    writeFileSync(join(p.pendingDir, "notes.txt"), "some notes");
    writeFileSync(join(p.pendingDir, ".DS_Store"), "");

    const list = await listPending(p);
    expect(list).toHaveLength(1);
    expect(list[0].requestId).toBe(id);
  });
});

describe("approval-store — readAny edge cases", () => {
  it("throws for a requestId that doesn't match the expected format", async () => {
    const tmp = withTmpRondel();
    const p = paths(tmp.stateDir);
    mkdirSync(p.pendingDir, { recursive: true });
    mkdirSync(p.resolvedDir, { recursive: true });

    await expect(readAny(p, "nonexistent")).rejects.toThrow(/Invalid requestId format/);
  });

  it("returns undefined for a valid-format id that doesn't exist on disk", async () => {
    const tmp = withTmpRondel();
    const p = paths(tmp.stateDir);
    mkdirSync(p.pendingDir, { recursive: true });
    mkdirSync(p.resolvedDir, { recursive: true });

    const result = await readAny(p, "appr_9999999_abcdef00");
    expect(result).toBeUndefined();
  });

  it("returns pending record when only pending exists", async () => {
    const tmp = withTmpRondel();
    const p = paths(tmp.stateDir);
    const id = nextId();
    await writePending(p, makeToolUseRecord({ requestId: id }));

    const result = await readAny(p, id);
    expect(result).toBeDefined();
    expect(result?.status).toBe("pending");
  });
});

describe("approval-store — listResolved with limit=0", () => {
  it("returns empty array with limit 0", async () => {
    const tmp = withTmpRondel();
    const p = paths(tmp.stateDir);
    const id = nextId();
    await writeResolved(p, makeToolUseRecord({ requestId: id, status: "resolved", decision: "allow", createdAt: "2026-04-15T12:00:01Z" }));

    const list = await listResolved(p, 0);
    expect(list).toEqual([]);
  });

  it("returns all records when limit is undefined", async () => {
    const tmp = withTmpRondel();
    const p = paths(tmp.stateDir);
    for (let i = 0; i < 5; i++) {
      const id = nextId();
      await writeResolved(p, makeToolUseRecord({ requestId: id, status: "resolved", decision: "allow", createdAt: `2026-04-15T12:00:0${i}Z` }));
    }
    const list = await listResolved(p);
    expect(list).toHaveLength(5);
  });
});

describe("approval-store — requestId validation", () => {
  it("rejects path-traversal attempts in requestId", async () => {
    const tmp = withTmpRondel();
    const p = paths(tmp.stateDir);
    mkdirSync(p.pendingDir, { recursive: true });

    await expect(readPending(p, "../../../etc/passwd")).rejects.toThrow(/Invalid requestId format/);
  });

  it("rejects empty requestId", async () => {
    const tmp = withTmpRondel();
    const p = paths(tmp.stateDir);
    mkdirSync(p.pendingDir, { recursive: true });

    await expect(readPending(p, "")).rejects.toThrow(/Invalid requestId format/);
  });
});

