"use client";

/**
 * Read-only live task board.
 *
 * Columns: pending | in_progress | blocked | completed | cancelled
 * (last two collapsed by default). Each column is a vertical list of
 * cards — card shows title, assignee, priority chip, and short age.
 *
 * Data flow:
 *   - Server-rendered initial list via `bridge.tasks.list(...)`.
 *   - Client-side SSE via `useTasksTail` folds deltas into a Map keyed
 *     on record.id. Terminal states arrive as deltas and can be
 *     toggled visible.
 *   - The whole thing refreshes purely from stream events — no
 *     router.refresh(), no polling.
 */

import { useEffect, useState } from "react";
import { useTasksTail } from "@/lib/streams";
import type { TaskRecord } from "@/lib/bridge";

const STATUS_COLUMNS: readonly TaskRecord["status"][] = [
  "pending",
  "in_progress",
  "blocked",
  "completed",
  "cancelled",
];

const STATUS_LABEL: Record<TaskRecord["status"], string> = {
  pending: "Pending",
  in_progress: "In progress",
  blocked: "Blocked",
  completed: "Completed",
  cancelled: "Cancelled",
};

const PRIORITY_COLOR: Record<TaskRecord["priority"], string> = {
  urgent: "bg-red-500/15 text-red-400 ring-1 ring-red-500/30",
  high: "bg-orange-500/15 text-orange-400 ring-1 ring-orange-500/30",
  normal: "bg-muted text-muted-foreground ring-1 ring-border",
  low: "bg-muted/50 text-muted-foreground ring-1 ring-border",
};

export function TasksLiveBoard({
  initial,
  callerAgent,
}: {
  readonly initial: readonly TaskRecord[];
  readonly callerAgent: string;
}) {
  const [showTerminal, setShowTerminal] = useState(false);
  const [tasks, setTasks] = useState<Map<string, TaskRecord>>(
    () => new Map(initial.map((t) => [t.id, t])),
  );

  // Subscribe to deltas. Snapshot replaces the map wholesale; deltas
  // upsert by id. Terminal states stay in the map but render in the
  // collapsed columns.
  const { events } = useTasksTail({ callerAgent, isAdmin: true });
  useEffect(() => {
    if (events.length === 0) return;
    setTasks((prev) => {
      const next = new Map(prev);
      for (const evt of events) {
        if (evt.kind === "snapshot") {
          next.clear();
          for (const t of evt.entries) next.set(t.id, t);
        } else {
          next.set(evt.entry.id, evt.entry);
        }
      }
      return next;
    });
  }, [events]);

  const now = Date.now();
  const grouped = groupByStatus(Array.from(tasks.values()));

  const visibleColumns = showTerminal
    ? STATUS_COLUMNS
    : STATUS_COLUMNS.filter((s) => s !== "completed" && s !== "cancelled");

  return (
    <div>
      <div className="mb-3 flex items-center gap-3 text-sm">
        <span className="text-muted-foreground">{tasks.size} tasks</span>
        <button
          type="button"
          className="rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
          onClick={() => setShowTerminal((v) => !v)}
        >
          {showTerminal ? "Hide" : "Show"} completed & cancelled
        </button>
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3 lg:grid-cols-5">
        {visibleColumns.map((status) => (
          <Column
            key={status}
            status={status}
            tasks={grouped[status] ?? []}
            now={now}
          />
        ))}
      </div>
    </div>
  );
}

function Column({
  status,
  tasks,
  now,
}: {
  readonly status: TaskRecord["status"];
  readonly tasks: readonly TaskRecord[];
  readonly now: number;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {STATUS_LABEL[status]}
        </h2>
        <span className="text-xs text-muted-foreground">{tasks.length}</span>
      </div>
      <ul className="space-y-2">
        {tasks.length === 0 ? (
          <li className="text-xs italic text-muted-foreground/60">Empty</li>
        ) : (
          tasks.map((t) => <Card key={t.id} task={t} now={now} />)
        )}
      </ul>
    </div>
  );
}

function Card({ task, now }: { readonly task: TaskRecord; readonly now: number }) {
  const ageLabel = formatAge(now - Date.parse(task.updatedAt));
  return (
    <li className="rounded-md border border-border/60 bg-background p-2 text-sm">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="truncate font-medium" title={task.title}>
          {task.title}
        </span>
        <span
          className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${PRIORITY_COLOR[task.priority]}`}
        >
          {task.priority}
        </span>
      </div>
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span className="truncate" title={`assigned to ${task.assignedTo}`}>
          → {task.assignedTo}
        </span>
        <span>{ageLabel}</span>
      </div>
      {task.blockedReason && task.status === "blocked" ? (
        <div className="mt-1 text-xs text-red-400/80">
          {task.blockedReason}
        </div>
      ) : null}
    </li>
  );
}

function groupByStatus(
  tasks: readonly TaskRecord[],
): Partial<Record<TaskRecord["status"], TaskRecord[]>> {
  const out: Partial<Record<TaskRecord["status"], TaskRecord[]>> = {};
  for (const t of tasks) {
    const bucket = out[t.status] ?? (out[t.status] = []);
    bucket.push(t);
  }
  // Stable-sort within each bucket by updatedAt desc (most recent on top).
  for (const s of STATUS_COLUMNS) {
    const bucket = out[s];
    if (bucket) bucket.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  return out;
}

function formatAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}
