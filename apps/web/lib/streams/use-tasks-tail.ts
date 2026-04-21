"use client";

/**
 * Typed wrapper over `useEventStream` for the live task board tail.
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
 */

import {
  TaskStreamFrameSchema,
  type TaskAuditEvent,
  type TaskRecord,
} from "@/lib/bridge/schemas";

import { useEventStream, type UseEventStreamResult } from "./use-event-stream";

export type TaskTailEvent =
  | { readonly kind: "snapshot"; readonly entries: readonly TaskRecord[] }
  | {
      readonly kind: "delta";
      readonly entry: TaskRecord;
      readonly event: TaskAuditEvent;
    };

export interface UseTasksTailOptions {
  readonly callerAgent: string;
  readonly isAdmin?: boolean;
  readonly org?: string;
}

export function useTasksTail(
  opts: UseTasksTailOptions | null,
): UseEventStreamResult<TaskTailEvent> {
  const url = opts ? buildUrl(opts) : null;
  return useEventStream<TaskTailEvent>(url, parseTaskFrame);
}

function buildUrl(opts: UseTasksTailOptions): string {
  const params = new URLSearchParams({ callerAgent: opts.callerAgent });
  if (opts.isAdmin) params.set("isAdmin", "true");
  if (opts.org) params.set("org", opts.org);
  return `/api/bridge/tasks/tail?${params.toString()}`;
}

function parseTaskFrame(raw: unknown): TaskTailEvent | null {
  const parsed = TaskStreamFrameSchema.safeParse(raw);
  if (!parsed.success) return null;
  const data = parsed.data.data;
  if (data.kind === "snapshot") return { kind: "snapshot", entries: data.entries };
  return { kind: "delta", entry: data.entry, event: data.event };
}
