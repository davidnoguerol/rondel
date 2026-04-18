"use client";

/**
 * Typed wrapper over `useEventStream` for the live schedules tail.
 *
 * The daemon's initial list is fetched server-side by the schedules RSC
 * page and passed in as `initial`. This hook subscribes to
 * `/api/bridge/schedules/tail` and folds each frame into the current
 * list — upsert by id for created/updated/ran, remove for deleted.
 *
 * =============================================================================
 * IMPORTANT — OWNER FILTERING
 * =============================================================================
 *
 * `/schedules/tail` is a GLOBAL stream — every subscriber receives frames
 * for every agent's schedules (mirroring the ApprovalStreamSource pattern,
 * which IS a global surface). The schedules UI is per-agent, so we must
 * filter frames by `owner` before merging. Without this, agent A's
 * schedules page would render agent B's `schedule.created` events.
 *
 * The initial list is safe — it comes from `bridge.schedules.list(agent)`
 * on the server, which is already scoped by agent.
 *
 * All lifecycle concerns (reconnect, cleanup on unmount, strict-mode
 * double-mount safety) are inherited from `useEventStream`.
 *
 * Reducer is stateless — we rebuild from `initial` each frame batch so
 * duplicate frames after a reconnect can't leave us with stale or
 * doubled entries. This matches `use-approval-stream` exactly.
 */

import { useMemo } from "react";

import {
  ScheduleStreamFrameSchema,
  type ScheduleStreamFrame,
  type ScheduleSummary,
} from "@/lib/bridge";

import { useEventStream, type StreamStatus } from "./use-event-stream";

export interface UseSchedulesTailOptions {
  /** Agent whose schedules this view is rendering. Used to filter frames. */
  readonly agent: string;
  readonly initial: readonly ScheduleSummary[];
}

export interface UseSchedulesTailResult {
  readonly schedules: readonly ScheduleSummary[];
  readonly status: StreamStatus;
}

export function useSchedulesTail(options: UseSchedulesTailOptions): UseSchedulesTailResult {
  const { agent, initial } = options;

  const { events, status } = useEventStream<ScheduleStreamFrame>(
    "/api/bridge/schedules/tail",
    parseScheduleFrame,
  );

  // Rebuild from the server-rendered initial list on every frame batch.
  // See `foldScheduleFrames` below for the reducer — extracted as a pure
  // function so its idempotency and owner-filtering can be unit-tested
  // without mounting the hook in a DOM environment.
  const schedules = useMemo(
    () => foldScheduleFrames(initial, events, agent),
    [events, initial, agent],
  );

  return { schedules, status };
}

/**
 * Pure reducer — takes the server-rendered initial list, the buffered
 * stream frames, and the owner filter; returns the current list.
 * Idempotent under replay: calling it with the same frames twice
 * returns the same result.
 *
 * `agent` is the owner filter — frames for other owners are dropped.
 * This is CORRECTNESS, not hygiene: the underlying SSE stream is
 * global, and the schedules UI is per-agent. An unfiltered reducer
 * leaks other agents' schedules into this agent's view.
 */
export function foldScheduleFrames(
  initial: readonly ScheduleSummary[],
  frames: readonly ScheduleStreamFrame[],
  agent: string,
): readonly ScheduleSummary[] {
  const byId = new Map<string, ScheduleSummary>(initial.map((s) => [s.id, s]));
  for (const frame of frames) {
    // Drop frames belonging to another agent. `owner` is optional on the
    // wire (declarative jobs don't have one), but runtime jobs — the only
    // kind this stream emits — always carry it. An undefined owner here
    // means something upstream is broken; dropping is the safe default.
    if (frame.data.owner !== agent) continue;

    const id = frame.data.id;
    if (frame.event === "schedule.deleted") {
      byId.delete(id);
      continue;
    }
    // created / updated / ran all carry a full ScheduleSummary — upsert.
    byId.set(id, frame.data);
  }

  // Stable display order: newest first by createdAtMs, then by id.
  return [...byId.values()].sort((a, b) => {
    const byCreated = (b.createdAtMs ?? 0) - (a.createdAtMs ?? 0);
    if (byCreated !== 0) return byCreated;
    return a.id.localeCompare(b.id);
  });
}

function parseScheduleFrame(raw: unknown): ScheduleStreamFrame | null {
  const parsed = ScheduleStreamFrameSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
