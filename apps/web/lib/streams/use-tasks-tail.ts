"use client";

/**
 * Typed wrapper over `useStreamTopic` for the live task board tail.
 *
 * Usage:
 *   const { events, status } = useTasksTail({
 *     callerAgent: "kai",
 *     isAdmin: true,
 *   });
 *
 * Each event is either a full snapshot (initial connect) or a delta
 * carrying one record + the audit event that drove it. Consumers
 * typically merge deltas into a Map keyed on record.id and re-render.
 *
 * =============================================================================
 * WHAT CHANGED IN v17 (API bump)
 * =============================================================================
 *
 * Pre-v17 this hook opened its own `EventSource` at
 * `/api/bridge/tasks/tail?callerAgent=…&isAdmin=…&org=…`. With the
 * multiplex, caller identity moves to the provider's single connect
 * URL and `org` filtering moves client-side. The `UseTasksTailOptions`
 * shape is kept stable so existing callers compile without changes;
 * only `org` is consumed here now (for the client-side filter). `callerAgent`
 * and `isAdmin` are accepted but unused — the provider forwards the
 * web's admin identity once for the whole session.
 */

import {
  TaskStreamFrameSchema,
  type TaskAuditEvent,
  type TaskRecord,
  type RawSseFrame,
} from "@/lib/bridge/schemas";

import { useStreamTopic } from "./use-stream-topic";
import type { UseEventStreamResult } from "./use-event-stream";

export type TaskTailEvent =
  | { readonly kind: "snapshot"; readonly entries: readonly TaskRecord[] }
  | {
      readonly kind: "delta";
      readonly entry: TaskRecord;
      readonly event: TaskAuditEvent;
    };

export interface UseTasksTailOptions {
  /** Retained for API compatibility. Ignored post-v17. */
  readonly callerAgent: string;
  /** Retained for API compatibility. Ignored post-v17. */
  readonly isAdmin?: boolean;
  /** Client-side filter on task org. Only this field is still honored. */
  readonly org?: string;
}

export function useTasksTail(
  opts: UseTasksTailOptions | null,
): UseEventStreamResult<TaskTailEvent> {
  const orgFilter = opts?.org;

  // Parser filters by org client-side; server delivers everything.
  const parse = (raw: RawSseFrame): TaskTailEvent | null => {
    if (!opts) return null;
    const parsed = TaskStreamFrameSchema.safeParse(raw);
    if (!parsed.success) return null;
    const data = parsed.data.data;
    if (data.kind === "snapshot") {
      // Filter the snapshot entries by org here so the reducer sees a
      // scoped initial state. Mirrors the server-side filter that used
      // to live on /tasks/tail.
      const entries = orgFilter
        ? data.entries.filter((e) => e.org === orgFilter)
        : data.entries;
      return { kind: "snapshot", entries };
    }
    if (orgFilter && data.entry.org !== orgFilter) return null;
    return { kind: "delta", entry: data.entry, event: data.event };
  };

  return useStreamTopic<TaskTailEvent>("tasks", parse);
}
