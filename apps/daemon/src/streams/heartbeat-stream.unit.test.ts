/**
 * Unit tests for HeartbeatStreamSource.
 *
 * Verifies:
 *  - `asyncSnapshot()` pulls from the service and shapes the frame.
 *  - `subscribe()` fans out `heartbeat:updated` hook events as `delta` frames.
 *  - `dispose()` unhooks + drops clients.
 *  - A throwing client doesn't break others.
 *  - Stale client unsubscribe during fan-out is safe.
 */

import { describe, it, expect, vi } from "vitest";
import { HeartbeatStreamSource } from "./heartbeat-stream.js";
import { createHooks } from "../shared/hooks.js";
import type { HeartbeatService } from "../heartbeats/index.js";
import type { HeartbeatRecord } from "../shared/types/heartbeats.js";
import type { HeartbeatRecordWithHealth } from "../bridge/schemas.js";

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

function fakeService(records: readonly HeartbeatRecordWithHealth[]): HeartbeatService {
  return {
    readAllUnscoped: vi.fn(async () => records),
  } as unknown as HeartbeatService;
}

describe("HeartbeatStreamSource", () => {
  it("asyncSnapshot pulls from the service", async () => {
    const hooks = createHooks();
    const entry: HeartbeatRecordWithHealth = {
      ...record("kai"),
      health: "healthy",
      ageMs: 0,
    };
    const source = new HeartbeatStreamSource(hooks, fakeService([entry]));

    const frame = await source.asyncSnapshot();
    expect(frame.event).toBe("heartbeat.snapshot");
    if (frame.data.kind !== "snapshot") throw new Error("expected snapshot");
    expect(frame.data.entries).toEqual([entry]);

    source.dispose();
  });

  it("subscribe delivers a delta per heartbeat:updated with computed health", () => {
    const hooks = createHooks();
    const source = new HeartbeatStreamSource(hooks, fakeService([]));

    const received: unknown[] = [];
    const unsub = source.subscribe((f) => received.push(f));

    hooks.emit("heartbeat:updated", { record: record("kai") });

    expect(received).toHaveLength(1);
    const frame = received[0] as {
      event: string;
      data: { kind: "delta"; entry: HeartbeatRecordWithHealth };
    };
    expect(frame.event).toBe("heartbeat.delta");
    expect(frame.data.kind).toBe("delta");
    expect(frame.data.entry.agent).toBe("kai");
    expect(frame.data.entry.health).toBe("healthy");

    unsub();
    source.dispose();
  });

  it("no delta when there are no clients — avoids useless work", () => {
    const hooks = createHooks();
    const service = fakeService([]);
    const source = new HeartbeatStreamSource(hooks, service);

    // No subscribers attached. The hook should still fire without throwing.
    hooks.emit("heartbeat:updated", { record: record("kai") });

    // And asyncSnapshot still works.
    expect(source.getClientCount()).toBe(0);
    source.dispose();
  });

  it("a throwing client does not break others", () => {
    const hooks = createHooks();
    const source = new HeartbeatStreamSource(hooks, fakeService([]));

    const good: unknown[] = [];
    const bad = vi.fn(() => {
      throw new Error("boom");
    });
    source.subscribe(bad);
    source.subscribe((f) => good.push(f));

    hooks.emit("heartbeat:updated", { record: record("kai") });

    expect(bad).toHaveBeenCalledTimes(1);
    expect(good).toHaveLength(1);

    source.dispose();
  });

  it("unsubscribe during fan-out does not invalidate the iterator", () => {
    const hooks = createHooks();
    const source = new HeartbeatStreamSource(hooks, fakeService([]));

    let unsubSelf: (() => void) | null = null;
    const received: unknown[] = [];
    unsubSelf = source.subscribe(() => {
      // Unsubscribe self mid-fanout.
      unsubSelf?.();
    });
    source.subscribe((f) => received.push(f));

    hooks.emit("heartbeat:updated", { record: record("kai") });

    // The second subscriber must still receive the frame.
    expect(received).toHaveLength(1);

    source.dispose();
  });

  it("dispose drops all clients and unhooks", () => {
    const hooks = createHooks();
    const source = new HeartbeatStreamSource(hooks, fakeService([]));

    const received: unknown[] = [];
    source.subscribe((f) => received.push(f));

    source.dispose();
    expect(source.getClientCount()).toBe(0);

    hooks.emit("heartbeat:updated", { record: record("kai") });
    expect(received).toHaveLength(0);
  });
});
