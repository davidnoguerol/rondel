/**
 * Pure reducer behind `useSchedulesTail`. Extracted from the hook file
 * so the pure-logic test can import this alone — without transitively
 * pulling in the multiplex provider (a `.tsx` file) through the hook's
 * React surface.
 *
 * Same pattern as `use-conversation-tail.parser.test.ts` → its parser
 * module: isolate the testable pure function so tests run in the plain
 * Node environment without DOM or JSX transform concerns.
 */

import type { ScheduleStreamFrame, ScheduleSummary } from "@/lib/bridge";

/**
 * Pure reducer — takes the server-rendered initial list, the buffered
 * stream frames, and the owner filter; returns the current list.
 * Idempotent under replay: calling it with the same frames twice
 * returns the same result.
 *
 * `agent` is the owner filter — frames for other owners are dropped.
 * This is CORRECTNESS, not hygiene: the underlying schedules topic is
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
