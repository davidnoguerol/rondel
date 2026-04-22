/**
 * Integration test for `GET /events/tail` — the multiplex SSE endpoint.
 *
 * Scope: HTTP wire format end-to-end. The bridge handler builds the
 * `replay` callback from the multiplex's `buildReplay`, then delegates
 * to `handleSseRequest`. This test exercises the **composition** that
 * neither the multiplex unit test nor `sse-handler.integration.test.ts`
 * covers: do the snapshot frames arrive in topic-tagged envelopes, in
 * the right order, before live deltas, and does the connection survive
 * when one underlying snapshot throws?
 *
 * The "underlying snapshot throws" case is the load-bearing regression:
 * `TaskService.list` rejects with `unknown_agent` for the loopback
 * caller "web", which previously aborted the entire stream and produced
 * a 3-second open-snapshot-close-reconnect oscillation that surfaced as
 * a stuck "Connecting" indicator in the dashboard. The fix moved
 * snapshot delivery to best-effort per topic; this test locks that
 * contract at the HTTP boundary.
 *
 * Strategy: hand-rolled fake sources implementing `StreamSource<T>` so
 * we can drive deltas synchronously and force a snapshot to throw.
 * Avoids pulling in the real LedgerWriter / ConversationManager /
 * HeartbeatService / TaskService — those have their own per-source
 * tests, and the integration concern here is the bridge route, not the
 * per-source semantics.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setTimeout as delay } from "node:timers/promises";

import { Bridge } from "./bridge.js";
import { AgentManager } from "../agents/agent-manager.js";
import {
  MULTIPLEX_EVENT,
  MultiplexStreamSource,
  type MultiplexStreamSources,
  type MultiplexedFrameData,
} from "../streams/index.js";
import type { SseFrame } from "../streams/sse-types.js";
import type { AgentStateFrameData, AgentStateStreamSource } from "../streams/agent-state-stream.js";
import type { ApprovalStreamSource } from "../streams/approval-stream.js";
import type { HeartbeatFrameData, HeartbeatStreamSource } from "../streams/heartbeat-stream.js";
import type { LedgerStreamSource } from "../streams/ledger-stream.js";
import type { ScheduleFramePayload, ScheduleStreamSource } from "../streams/schedule-stream.js";
import type { TaskFrameData, TaskStreamSource } from "../streams/task-stream.js";
import type { ApprovalRecord } from "../shared/types/approvals.js";
import type { LedgerEvent } from "../ledger/ledger-types.js";
import { withTmpRondel, type TmpRondelHandle } from "../../tests/helpers/tmp.js";
import { createCapturingLogger } from "../../tests/helpers/logger.js";

// -----------------------------------------------------------------------------
// Fake sources — same shape used by multiplex-stream.unit.test.ts. Each
// fake exposes a synchronous `emit` so we can drive live deltas in tests.
// -----------------------------------------------------------------------------

interface FakeSource<T> {
  subscribe(send: (frame: SseFrame<T>) => void): () => void;
  emit(frame: SseFrame<T>): void;
}

function makeFake<T>(): FakeSource<T> {
  const subs = new Set<(frame: SseFrame<T>) => void>();
  return {
    subscribe(send) {
      subs.add(send);
      return () => {
        subs.delete(send);
      };
    },
    emit(frame) {
      for (const s of [...subs]) s(frame);
    },
  };
}

interface FakeBundle {
  approvals: FakeSource<ApprovalRecord>;
  agentsState: FakeSource<AgentStateFrameData>;
  tasks: FakeSource<TaskFrameData>;
  ledger: FakeSource<LedgerEvent>;
  schedules: FakeSource<ScheduleFramePayload>;
  heartbeats: FakeSource<HeartbeatFrameData>;
  sources: MultiplexStreamSources;
}

function makeFakes(opts: {
  failTasksSnapshot?: boolean;
} = {}): FakeBundle {
  const approvals = makeFake<ApprovalRecord>();
  const agentsState = makeFake<AgentStateFrameData>();
  const tasks = makeFake<TaskFrameData>();
  const ledger = makeFake<LedgerEvent>();
  const schedules = makeFake<ScheduleFramePayload>();
  const heartbeats = makeFake<HeartbeatFrameData>();

  const sources: MultiplexStreamSources = {
    approvals: { subscribe: approvals.subscribe } as unknown as ApprovalStreamSource,
    agentsState: {
      subscribe: agentsState.subscribe,
      snapshot: () => ({
        event: "agent_state.snapshot",
        data: { kind: "snapshot", entries: [] },
      }),
    } as unknown as AgentStateStreamSource,
    tasks: {
      subscribe: tasks.subscribe,
      asyncSnapshot: opts.failTasksSnapshot
        ? async () => {
            // Mimics TaskService.list rejecting with `unknown_agent` for
            // the loopback caller "web". This is the regression case.
            throw new Error("Unknown agent: web");
          }
        : async () => ({
            event: "task.snapshot",
            data: { kind: "snapshot", entries: [] },
          }),
    } as unknown as TaskStreamSource,
    ledger: { subscribe: ledger.subscribe } as unknown as LedgerStreamSource,
    schedules: { subscribe: schedules.subscribe } as unknown as ScheduleStreamSource,
    heartbeats: {
      subscribe: heartbeats.subscribe,
      asyncSnapshot: async () => ({
        event: "heartbeat.snapshot",
        data: { kind: "snapshot", entries: [] },
      }),
    } as unknown as HeartbeatStreamSource,
  };

  return { approvals, agentsState, tasks, ledger, schedules, heartbeats, sources };
}

// -----------------------------------------------------------------------------
// Bridge boot — minimal: only multiplex is wired, everything else
// undefined. The events/tail handler doesn't depend on the other
// services.
// -----------------------------------------------------------------------------

async function bootBridge(
  tmp: TmpRondelHandle,
  multiplex: MultiplexStreamSource,
): Promise<{ bridge: Bridge; url: string; mgr: AgentManager }> {
  const log = createCapturingLogger();
  const mgr = new AgentManager(log);
  await mgr.initialize(tmp.rondelHome, [], []);
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
    undefined, // heartbeats
    undefined, // tasks
    multiplex,
  );
  await bridge.start();
  return { bridge, url: bridge.getUrl(), mgr };
}

// -----------------------------------------------------------------------------
// SSE reader — splits on `\n\n` and parses `data:` lines. Returns the
// next N parsed frames, or rejects on timeout. Polls a small buffer so
// fragmented chunks don't lose frames.
// -----------------------------------------------------------------------------

interface SseHandle {
  readonly response: Response;
  /** Read until N data frames have been parsed, then resolve them. */
  readNDataFrames(n: number, timeoutMs: number): Promise<unknown[]>;
  /** Close the upstream connection. */
  close(): void;
}

async function openSse(url: string): Promise<SseHandle> {
  const controller = new AbortController();
  const response = await fetch(url, {
    headers: { Accept: "text/event-stream" },
    signal: controller.signal,
  });
  if (!response.body) throw new Error("SSE response has no body");

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let buffer = "";
  const queue: unknown[] = [];
  const waiters: Array<(frame: unknown) => void> = [];

  const consume = async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // SSE frames terminate with a blank line.
        let idx;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          for (const line of block.split("\n")) {
            const trimmed = line.startsWith("data:") ? line.slice(5).trim() : null;
            if (trimmed === null) continue;
            try {
              const parsed = JSON.parse(trimmed);
              if (waiters.length > 0) waiters.shift()!(parsed);
              else queue.push(parsed);
            } catch {
              // Non-JSON `data:` (e.g. `: heartbeat` is a comment, not data) —
              // skip without breaking the stream.
            }
          }
        }
      }
    } catch {
      // Reader closed; consumers see resolution via timeout.
    }
  };
  void consume();

  return {
    response,
    async readNDataFrames(n, timeoutMs) {
      const out: unknown[] = [];
      const start = Date.now();
      while (out.length < n) {
        if (queue.length > 0) {
          out.push(queue.shift());
          continue;
        }
        const remaining = timeoutMs - (Date.now() - start);
        if (remaining <= 0) {
          throw new Error(
            `Timed out waiting for ${n} frames (got ${out.length})`,
          );
        }
        const next = await Promise.race<unknown>([
          new Promise((resolve) => waiters.push(resolve)),
          delay(remaining).then(() => Symbol.for("timeout")),
        ]);
        if (next === Symbol.for("timeout")) {
          throw new Error(
            `Timed out waiting for ${n} frames (got ${out.length})`,
          );
        }
        out.push(next);
      }
      return out;
    },
    close() {
      controller.abort();
      reader.cancel().catch(() => {});
    },
  };
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe("Bridge — GET /events/tail (multiplex SSE)", () => {
  let tmp: TmpRondelHandle;
  let bridge: Bridge;
  let url: string;
  let mgr: AgentManager;
  let mux: MultiplexStreamSource;

  afterEach(() => {
    bridge?.stop();
    mgr?.stopAll();
    mux?.dispose();
  });

  it("delivers snapshot frames for every snapshot-bearing topic, then a live delta", async () => {
    tmp = withTmpRondel();
    const fakes = makeFakes();
    mux = new MultiplexStreamSource(fakes.sources);
    ({ bridge, url, mgr } = await bootBridge(tmp, mux));

    const sse = await openSse(`${url}/events/tail?callerAgent=web&isAdmin=true`);
    try {
      // 3 snapshots (agents-state, heartbeats, tasks) sent during the
      // prefix phase by buildReplay, in that order.
      const initial = (await sse.readNDataFrames(3, 2000)) as {
        event: string;
        data: MultiplexedFrameData;
      }[];

      expect(initial.map((f) => f.event)).toEqual([
        MULTIPLEX_EVENT,
        MULTIPLEX_EVENT,
        MULTIPLEX_EVENT,
      ]);
      expect(initial.map((f) => f.data.topic)).toEqual([
        "agents-state",
        "heartbeats",
        "tasks",
      ]);

      // Now drive a live delta on the schedules topic. It must arrive
      // wrapped in the topic envelope, after the prefix phase.
      const sched: SseFrame<ScheduleFramePayload> = {
        event: "schedule.created",
        data: {
          id: "sched_1",
          name: "x",
          owner: "alice",
          enabled: true,
          schedule: { kind: "every", interval: "5m" },
          prompt: "hi",
          sessionTarget: "isolated",
          source: "runtime",
          createdAtMs: 1_700_000_000_000,
        },
      };
      // Defer slightly so the prefix phase has finished and `liveSend`
      // has switched to direct write (handleSseRequest's contract).
      await delay(50);
      fakes.schedules.emit(sched);

      const [delta] = (await sse.readNDataFrames(1, 1000)) as {
        event: string;
        data: MultiplexedFrameData;
      }[];
      expect(delta.event).toBe(MULTIPLEX_EVENT);
      expect(delta.data.topic).toBe("schedules");
      expect(delta.data.frame.event).toBe("schedule.created");
    } finally {
      sse.close();
    }
  });

  it("survives a snapshot failure on one topic — connection stays open and other topics still flow", async () => {
    // Regression for the bug that surfaced as a stuck "Connecting"
    // indicator in the dashboard: TaskService.list throws
    // `unknown_agent` for the loopback caller "web", which used to
    // tear down the entire stream every 3 seconds.
    tmp = withTmpRondel();
    const fakes = makeFakes({ failTasksSnapshot: true });
    mux = new MultiplexStreamSource(fakes.sources);
    ({ bridge, url, mgr } = await bootBridge(tmp, mux));

    const sse = await openSse(`${url}/events/tail?callerAgent=web&isAdmin=true`);
    try {
      // Only 2 snapshots arrive (agents-state + heartbeats). Tasks
      // snapshot was swallowed by safeSnapshotAsync's catch.
      const initial = (await sse.readNDataFrames(2, 2000)) as {
        event: string;
        data: MultiplexedFrameData;
      }[];
      expect(initial.map((f) => f.data.topic)).toEqual([
        "agents-state",
        "heartbeats",
      ]);

      // Critical: connection must still be open. Drive a live ledger
      // delta and verify it arrives — proves the stream wasn't aborted
      // by the swallowed snapshot error.
      await delay(50);
      const ledgerEvent: LedgerEvent = {
        ts: "2026-04-22T15:00:00Z",
        agent: "alice",
        kind: "session_start",
        chatId: "c1",
        summary: "x",
      } as unknown as LedgerEvent;
      fakes.ledger.emit({ event: "ledger.appended", data: ledgerEvent });

      const [delta] = (await sse.readNDataFrames(1, 1000)) as {
        event: string;
        data: MultiplexedFrameData;
      }[];
      expect(delta.event).toBe(MULTIPLEX_EVENT);
      expect(delta.data.topic).toBe("ledger");
    } finally {
      sse.close();
    }
  });

  it("returns 503 when the multiplex isn't wired", async () => {
    tmp = withTmpRondel();
    const log = createCapturingLogger();
    mgr = new AgentManager(log);
    await mgr.initialize(tmp.rondelHome, [], []);
    bridge = new Bridge(mgr, log, tmp.rondelHome);
    await bridge.start();
    url = bridge.getUrl();

    const res = await fetch(`${url}/events/tail`);
    expect(res.status).toBe(503);
  });
});
