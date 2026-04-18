/**
 * Live schedule stream source.
 *
 * Subscribes once to the schedule lifecycle hooks fired by `ScheduleService`
 * and `Scheduler`, and fans each one out to N in-process SSE clients (the
 * web `/agents/:name/schedules` page). Each frame carries a ScheduleSummary
 * — the exact shape returned by `GET /schedules` — so the web reducer can
 * upsert-by-id without a separate refetch.
 *
 * `schedule.deleted` extends the summary with a `reason` field mirroring
 * the `schedule:deleted` hook payload.
 *
 * One instance lives for the daemon's lifetime. Disposing the source
 * removes every hook listener and drops every active client.
 *
 * Mirrors `approval-stream.ts` exactly: same fan-out shape, same per-
 * listener error boundary, same SSE frame envelope.
 */

import type { RondelHooks } from "../shared/hooks.js";
import {
  summarizeSchedule,
  type ScheduleStateSnapshot,
  type ScheduleSummary,
} from "../scheduling/schedule-service.js";
import type { CronJob } from "../shared/types/index.js";

import type { SseFrame, StreamSource } from "./sse-types.js";

/** Payload extension on `schedule.deleted` frames — mirrors the hook payload. */
export interface ScheduleDeletedFramePayload extends ScheduleSummary {
  readonly reason: "requested" | "ran_once" | "owner_deleted";
}

/** Union of possible frame payload shapes this source emits. */
export type ScheduleFramePayload = ScheduleSummary | ScheduleDeletedFramePayload;

const SCHEDULE_CREATED_EVENT = "schedule.created";
const SCHEDULE_UPDATED_EVENT = "schedule.updated";
const SCHEDULE_DELETED_EVENT = "schedule.deleted";
const SCHEDULE_RAN_EVENT = "schedule.ran";

/**
 * Dependency used to build summaries on created/updated events, where the
 * scheduler's in-memory snapshot is the authoritative state. For `ran`
 * frames the fresh post-run state is carried in the hook payload, so this
 * lookup isn't used. For `deleted`, the scheduler has already dropped
 * the job — snapshot is `undefined` and the summary carries only cached
 * job fields.
 */
export interface ScheduleSnapshotLookup {
  getJobStateSnapshot(jobId: string): ScheduleStateSnapshot | undefined;
}

export class ScheduleStreamSource implements StreamSource<ScheduleFramePayload> {
  private readonly clients = new Set<(frame: SseFrame<ScheduleFramePayload>) => void>();
  private readonly unsubscribeFromHooks: (() => void)[] = [];

  constructor(hooks: RondelHooks, private readonly snapshotLookup: ScheduleSnapshotLookup) {
    const onCreated = ({ job }: { job: CronJob }): void => {
      if (!this.shouldEmit(job)) return;
      const summary = summarizeSchedule(job, this.snapshotLookup.getJobStateSnapshot(job.id));
      this.emitFrame({ event: SCHEDULE_CREATED_EVENT, data: summary });
    };
    const onUpdated = ({ job }: { job: CronJob }): void => {
      if (!this.shouldEmit(job)) return;
      const summary = summarizeSchedule(job, this.snapshotLookup.getJobStateSnapshot(job.id));
      this.emitFrame({ event: SCHEDULE_UPDATED_EVENT, data: summary });
    };
    const onDeleted = (
      { job, reason }: { job: CronJob; reason: "requested" | "ran_once" | "owner_deleted" },
    ): void => {
      if (!this.shouldEmit(job)) return;
      // Scheduler has already dropped the job — no live state to fetch.
      const summary = summarizeSchedule(job, undefined);
      this.emitFrame({
        event: SCHEDULE_DELETED_EVENT,
        data: { ...summary, reason },
      });
    };
    const onRan = (
      { job, state }: { job: CronJob; state: ScheduleStateSnapshot },
    ): void => {
      if (!this.shouldEmit(job)) return;
      // Fresh post-run state carried in the hook payload — authoritative.
      const summary = summarizeSchedule(job, state);
      this.emitFrame({ event: SCHEDULE_RAN_EVENT, data: summary });
    };

    hooks.on("schedule:created", onCreated);
    hooks.on("schedule:updated", onUpdated);
    hooks.on("schedule:deleted", onDeleted);
    hooks.on("schedule:ran", onRan);
    this.unsubscribeFromHooks.push(() => hooks.off("schedule:created", onCreated));
    this.unsubscribeFromHooks.push(() => hooks.off("schedule:updated", onUpdated));
    this.unsubscribeFromHooks.push(() => hooks.off("schedule:deleted", onDeleted));
    this.unsubscribeFromHooks.push(() => hooks.off("schedule:ran", onRan));
  }

  subscribe(send: (frame: SseFrame<ScheduleFramePayload>) => void): () => void {
    this.clients.add(send);
    return () => {
      this.clients.delete(send);
    };
  }

  // No `snapshot()` — the initial list of schedules comes from the
  // existing GET /schedules endpoint (rendered server-side by the RSC
  // page). The stream only carries deltas.

  dispose(): void {
    for (const undo of this.unsubscribeFromHooks) {
      try {
        undo();
      } catch {
        // Hook off() semantics aren't ours to enforce here.
      }
    }
    this.unsubscribeFromHooks.length = 0;
    this.clients.clear();
  }

  getClientCount(): number {
    return this.clients.size;
  }

  /**
   * Declarative crons from agent.json aren't in `ScheduleStore` and don't
   * appear in GET /schedules — so the UI would receive stream events for
   * entries it has no record of. Filter them out here.
   */
  private shouldEmit(job: CronJob): boolean {
    return (job.source ?? "runtime") === "runtime";
  }

  private emitFrame(frame: SseFrame<ScheduleFramePayload>): void {
    if (this.clients.size === 0) return;
    // Snapshot the client set before iterating so an unsubscribe during
    // fan-out (e.g. EPIPE on a dead socket) doesn't invalidate the
    // iterator.
    for (const send of [...this.clients]) {
      try {
        send(frame);
      } catch {
        // Per-client error must not affect other clients. The sender
        // closure is bound to a response that may have already torn
        // down — `handleSseRequest` will clean it up via its
        // `req.close` / `res.error` listeners.
      }
    }
  }
}
