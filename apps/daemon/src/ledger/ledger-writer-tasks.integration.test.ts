/**
 * Ledger writer — task board lifecycle events.
 *
 * Covers the seven `task:*` hook handlers. Each should:
 *   - append exactly one entry per hook emission
 *   - key the ledger row appropriately (assignedTo for most; createdBy
 *     for task:created so the creator's ledger records the dispatch)
 *   - NOT attach channelType/chatId (task events are org-wide)
 *   - carry a useful summary + structured detail payload
 */

import { describe, it, expect } from "vitest";
import { withTmpRondel } from "../../../../tests/helpers/tmp.js";
import { createHooks } from "../shared/hooks.js";
import type { TaskRecord } from "../shared/types/tasks.js";
import { LedgerWriter } from "./ledger-writer.js";
import type { LedgerEvent } from "./ledger-types.js";

function capture(writer: LedgerWriter): LedgerEvent[] {
  const captured: LedgerEvent[] = [];
  writer.onAppended((e) => captured.push(e));
  return captured;
}

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    version: 1,
    id: "task_1_abcd",
    org: "eng",
    title: "ship doc",
    description: "",
    status: "pending",
    priority: "high",
    createdBy: "alice",
    assignedTo: "bob",
    createdAt: "2026-04-20T12:00:00Z",
    updatedAt: "2026-04-20T12:00:00Z",
    blockedBy: [],
    blocks: [],
    externalAction: false,
    outputs: [],
    ...overrides,
  };
}

describe("LedgerWriter — task:* hooks", () => {
  it("task:created logs to the creator's ledger", () => {
    const tmp = withTmpRondel();
    const hooks = createHooks();
    const writer = new LedgerWriter(tmp.stateDir, hooks);
    const entries = capture(writer);

    hooks.emit("task:created", { record: task() });

    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("task_created");
    expect(entries[0].agent).toBe("alice");
    expect(entries[0].channelType).toBeUndefined();
    expect(entries[0].chatId).toBeUndefined();
    expect(entries[0].summary).toContain("ship doc");
    expect(entries[0].summary).toContain("bob");
    const detail = entries[0].detail as Record<string, unknown>;
    expect(detail.taskId).toBe("task_1_abcd");
    expect(detail.assignedTo).toBe("bob");
  });

  it("task:claimed logs to the assignee's ledger", () => {
    const tmp = withTmpRondel();
    const hooks = createHooks();
    const writer = new LedgerWriter(tmp.stateDir, hooks);
    const entries = capture(writer);

    hooks.emit("task:claimed", {
      record: task({ status: "in_progress", claimedAt: "2026-04-20T12:05:00Z" }),
    });

    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("task_claimed");
    expect(entries[0].agent).toBe("bob");
    expect(entries[0].summary).toContain("ship doc");
  });

  it("task:updated reflects the current status in the summary", () => {
    const tmp = withTmpRondel();
    const hooks = createHooks();
    const writer = new LedgerWriter(tmp.stateDir, hooks);
    const entries = capture(writer);

    hooks.emit("task:updated", {
      record: task({ status: "pending" }),
    });

    expect(entries[0].summary).toContain("[pending]");
  });

  it("task:blocked surfaces the blockedReason in the summary", () => {
    const tmp = withTmpRondel();
    const hooks = createHooks();
    const writer = new LedgerWriter(tmp.stateDir, hooks);
    const entries = capture(writer);

    hooks.emit("task:blocked", {
      record: task({ status: "blocked", blockedReason: "waiting on analyst" }),
    });

    expect(entries[0].kind).toBe("task_blocked");
    expect(entries[0].summary).toContain("waiting on analyst");
    const detail = entries[0].detail as Record<string, unknown>;
    expect(detail.reason).toBe("waiting on analyst");
  });

  it("task:completed records the result and output count", () => {
    const tmp = withTmpRondel();
    const hooks = createHooks();
    const writer = new LedgerWriter(tmp.stateDir, hooks);
    const entries = capture(writer);

    hooks.emit("task:completed", {
      record: task({
        status: "completed",
        completedAt: "2026-04-20T13:00:00Z",
        result: "shipped v1",
        outputs: [{ type: "file", path: "/tmp/doc.md" }],
      }),
    });

    expect(entries[0].kind).toBe("task_completed");
    expect(entries[0].summary).toContain("shipped v1");
    const detail = entries[0].detail as Record<string, unknown>;
    expect(detail.outputs).toBe(1);
    expect(detail.completedAt).toBe("2026-04-20T13:00:00Z");
  });

  it("task:cancelled records the cancellation reason", () => {
    const tmp = withTmpRondel();
    const hooks = createHooks();
    const writer = new LedgerWriter(tmp.stateDir, hooks);
    const entries = capture(writer);

    hooks.emit("task:cancelled", {
      record: task({ status: "cancelled", blockedReason: "no longer needed" }),
    });

    expect(entries[0].kind).toBe("task_cancelled");
    expect(entries[0].summary).toContain("no longer needed");
  });

  it("task:stale attaches the staleness classification", () => {
    const tmp = withTmpRondel();
    const hooks = createHooks();
    const writer = new LedgerWriter(tmp.stateDir, hooks);
    const entries = capture(writer);

    hooks.emit("task:stale", {
      record: task({ status: "pending" }),
      staleness: "stale_pending",
    });

    expect(entries[0].kind).toBe("task_stale");
    expect(entries[0].summary).toContain("stale_pending");
    const detail = entries[0].detail as Record<string, unknown>;
    expect(detail.staleness).toBe("stale_pending");
  });

  it("each emit produces one entry (no coalescing)", () => {
    const tmp = withTmpRondel();
    const hooks = createHooks();
    const writer = new LedgerWriter(tmp.stateDir, hooks);
    const entries = capture(writer);

    hooks.emit("task:created", { record: task({ id: "task_1_a" }) });
    hooks.emit("task:created", { record: task({ id: "task_1_b" }) });
    hooks.emit("task:claimed", {
      record: task({ id: "task_1_a", status: "in_progress" }),
    });
    expect(entries).toHaveLength(3);
  });
});
