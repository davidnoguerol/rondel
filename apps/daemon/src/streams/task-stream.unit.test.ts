/**
 * Unit tests for TaskStreamSource. Mirrors heartbeat-stream.unit.test.ts.
 */

import { describe, it, expect, vi } from "vitest";
import { TaskStreamSource } from "./task-stream.js";
import { createHooks } from "../shared/hooks.js";
import type { TaskService } from "../tasks/index.js";
import type { TaskRecord } from "../shared/types/tasks.js";

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    version: 1,
    id: "task_1_abcd",
    org: "eng",
    title: "x",
    description: "",
    status: "pending",
    priority: "normal",
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

function fakeService(list: readonly TaskRecord[]): TaskService {
  return {
    list: vi.fn(async () => list),
  } as unknown as TaskService;
}

describe("TaskStreamSource", () => {
  it("asyncSnapshot pulls non-terminal tasks via service.list", async () => {
    const hooks = createHooks();
    const entry = task();
    const source = new TaskStreamSource(hooks, fakeService([entry]));
    const frame = await source.asyncSnapshot({ agentName: "bob", isAdmin: false });
    expect(frame.event).toBe("task.snapshot");
    if (frame.data.kind !== "snapshot") throw new Error("expected snapshot");
    expect(frame.data.entries).toEqual([entry]);
    source.dispose();
  });

  it("delivers a delta per task:* event with the audit-event tag", () => {
    const hooks = createHooks();
    const source = new TaskStreamSource(hooks, fakeService([]));

    const received: Array<{ event: string; data: { kind: string; event?: string } }> = [];
    source.subscribe((f) => received.push(f as never));

    hooks.emit("task:created", { record: task() });
    hooks.emit("task:claimed", { record: task({ status: "in_progress" }) });
    hooks.emit("task:completed", { record: task({ status: "completed" }) });

    expect(received).toHaveLength(3);
    expect(received.map((f) => f.data.event)).toEqual(["created", "claimed", "completed"]);
    source.dispose();
  });

  it("does not emit task:stale as a delta", () => {
    const hooks = createHooks();
    const source = new TaskStreamSource(hooks, fakeService([]));
    const received: unknown[] = [];
    source.subscribe((f) => received.push(f));

    hooks.emit("task:stale", { record: task(), staleness: "stale_pending" });

    expect(received).toEqual([]);
    source.dispose();
  });

  it("a throwing client does not break other clients", () => {
    const hooks = createHooks();
    const source = new TaskStreamSource(hooks, fakeService([]));
    const bad = vi.fn(() => { throw new Error("boom"); });
    const good: unknown[] = [];
    source.subscribe(bad);
    source.subscribe((f) => good.push(f));
    hooks.emit("task:created", { record: task() });
    expect(bad).toHaveBeenCalledTimes(1);
    expect(good).toHaveLength(1);
    source.dispose();
  });

  it("unsubscribe during fan-out does not invalidate the iterator", () => {
    const hooks = createHooks();
    const source = new TaskStreamSource(hooks, fakeService([]));
    let unsubSelf: (() => void) | null = null;
    const received: unknown[] = [];
    unsubSelf = source.subscribe(() => unsubSelf?.());
    source.subscribe((f) => received.push(f));
    hooks.emit("task:created", { record: task() });
    expect(received).toHaveLength(1);
    source.dispose();
  });

  it("dispose drops clients and unhooks", () => {
    const hooks = createHooks();
    const source = new TaskStreamSource(hooks, fakeService([]));
    const received: unknown[] = [];
    source.subscribe((f) => received.push(f));
    source.dispose();
    hooks.emit("task:created", { record: task() });
    expect(received).toEqual([]);
    expect(source.getClientCount()).toBe(0);
  });
});
