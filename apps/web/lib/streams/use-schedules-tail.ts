"use client";

/**
 * Typed wrapper over `useStreamTopic` for the live schedules feed.
 *
 * The daemon's initial list is fetched server-side by the schedules RSC
 * page and passed in as `initial`. This hook subscribes to the
 * `schedules` topic on the shared multiplex and folds each frame into
 * the current list — upsert by id for created/updated/ran, remove for
 * deleted.
 *
 * =============================================================================
 * IMPORTANT — OWNER FILTERING
 * =============================================================================
 *
 * The `schedules` topic is GLOBAL — every subscriber receives frames
 * for every agent's schedules (mirroring the approval topic, which IS a
 * global surface). The schedules UI is per-agent, so we must filter
 * frames by `owner` before merging. Without this, agent A's schedules
 * page would render agent B's `schedule.created` events.
 *
 * The initial list is safe — it comes from `bridge.schedules.list(agent)`
 * on the server, which is already scoped by agent.
 *
 * Lifecycle concerns (reconnect, cleanup, strict-mode safety) are
 * inherited from the multiplex provider.
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
  type RawSseFrame,
} from "@/lib/bridge";

import { useStreamTopic } from "./use-stream-topic";
import type { StreamStatus } from "./use-event-stream";
import { foldScheduleFrames } from "./fold-schedule-frames";

// Re-exported for back-compat with any callers that import the reducer
// from here. The reducer itself lives in `fold-schedule-frames.ts` so
// pure-logic tests can load it without pulling in the React/JSX surface.
export { foldScheduleFrames };

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

  const { events, status } = useStreamTopic<ScheduleStreamFrame>(
    "schedules",
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

function parseScheduleFrame(raw: RawSseFrame): ScheduleStreamFrame | null {
  const parsed = ScheduleStreamFrameSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
