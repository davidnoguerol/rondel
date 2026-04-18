"use client";

/**
 * Client-side view over the live schedules tail.
 *
 * Takes the server-rendered initial list, subscribes to the SSE stream
 * via `useSchedulesTail`, and renders cards. Per-card actions (Run now,
 * Enable toggle, Delete) call Server Actions directly — no optimistic
 * UI; the SSE frame updates the card once the daemon confirms.
 *
 * Layout is presentational only. No data fetching, no state beyond the
 * delete-confirm dialog for each card.
 */

import { useEffect, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import type { ScheduleSummary } from "@/lib/bridge";

import { useSchedulesTail } from "@/lib/streams/use-schedules-tail";

import {
  deleteScheduleAction,
  runScheduleNowAction,
  toggleScheduleEnabledAction,
} from "./actions";
import { CreateScheduleDialog } from "./CreateScheduleDialog";
import { EditScheduleDialog } from "./EditScheduleDialog";
import {
  formatDelivery,
  formatRelativeTime,
  formatScheduleKind,
  formatStatusBadge,
} from "./format";

export interface SchedulesViewProps {
  readonly agent: string;
  readonly initial: readonly ScheduleSummary[];
}

export function SchedulesView({ agent, initial }: SchedulesViewProps) {
  const { schedules, status } = useSchedulesTail({ agent, initial });

  return (
    <div className="p-8 max-w-4xl mx-auto">
      <header className="mb-8 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Schedules</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Durable runtime schedules for <code className="font-mono">{agent}</code> — reminders,
            recurring tasks, one-shots. Survives daemon restarts.
          </p>
        </div>
        <CreateScheduleDialog agent={agent} />
      </header>

      <div className="mb-3 flex items-baseline gap-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {schedules.length} schedule{schedules.length === 1 ? "" : "s"}
        </span>
        <LiveIndicator status={status} />
      </div>

      {schedules.length === 0 ? (
        <EmptyState agent={agent} />
      ) : (
        <ul className="space-y-3">
          {schedules.map((s) => (
            <li key={s.id}>
              <ScheduleCard agent={agent} schedule={s} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// -----------------------------------------------------------------------------
// Card
// -----------------------------------------------------------------------------

function ScheduleCard({ agent, schedule }: { agent: string; schedule: ScheduleSummary }) {
  const badge = formatStatusBadge(schedule.lastStatus);

  return (
    <Card className={schedule.enabled ? "" : "opacity-60"}>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <CardTitle className="truncate text-base">{schedule.name}</CardTitle>
            <p className="mt-1 font-mono text-xs text-muted-foreground">
              {formatScheduleKind(schedule.schedule)}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <EnabledToggle agent={agent} schedule={schedule} />
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="line-clamp-3 rounded-md bg-muted px-3 py-2 font-mono text-xs text-foreground">
          {schedule.prompt}
        </p>

        <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-xs">
          <Stat label="Next run" value={<RelativeTs ms={schedule.nextRunAtMs} />} />
          <Stat label="Last run" value={<RelativeTs ms={schedule.lastRunAtMs} />} />
          <Stat
            label="Last status"
            value={<span className={`font-mono font-semibold ${badge.className}`}>{badge.label}</span>}
          />
          <Stat label="Delivery" value={<span className="font-mono">{formatDelivery(schedule.delivery)}</span>} />
        </div>

        <div className="flex items-center justify-end gap-2 pt-2">
          <EditScheduleDialog agent={agent} schedule={schedule} />
          <RunNowButton agent={agent} scheduleId={schedule.id} />
          <DeleteButton agent={agent} schedule={schedule} />
        </div>
      </CardContent>
    </Card>
  );
}

// -----------------------------------------------------------------------------
// Action buttons
// -----------------------------------------------------------------------------

function EnabledToggle({ agent, schedule }: { agent: string; schedule: ScheduleSummary }) {
  const [pending, startTransition] = useTransition();
  return (
    <Switch
      aria-label={schedule.enabled ? "Disable schedule" : "Enable schedule"}
      checked={schedule.enabled}
      disabled={pending}
      onCheckedChange={(next) => {
        startTransition(async () => {
          await toggleScheduleEnabledAction(agent, schedule.id, next);
        });
      }}
    />
  );
}

function RunNowButton({ agent, scheduleId }: { agent: string; scheduleId: string }) {
  const [pending, startTransition] = useTransition();
  return (
    <Button
      size="sm"
      variant="secondary"
      disabled={pending}
      onClick={() => {
        startTransition(async () => {
          await runScheduleNowAction(agent, scheduleId);
        });
      }}
    >
      {pending ? "Triggering…" : "Run now"}
    </Button>
  );
}

function DeleteButton({ agent, schedule }: { agent: string; schedule: ScheduleSummary }) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="destructive">
          Delete
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Delete schedule</DialogTitle>
          <DialogDescription>
            Remove <code className="font-mono">{schedule.name}</code>? This cannot be undone — the
            schedule will stop firing immediately.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={pending}
            onClick={() => {
              startTransition(async () => {
                await deleteScheduleAction(agent, schedule.id);
                setOpen(false);
              });
            }}
          >
            {pending ? "Deleting…" : "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// -----------------------------------------------------------------------------
// Small presentational helpers
// -----------------------------------------------------------------------------

function EmptyState({ agent }: { agent: string }) {
  return (
    <div className="rounded-md border border-dashed border-border px-6 py-10 text-center">
      <p className="text-sm text-muted-foreground">
        No schedules for <code className="font-mono">{agent}</code> yet.
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        Click <span className="font-semibold">New schedule</span>, or have the agent create one via
        the <code className="font-mono">rondel_schedule_create</code> tool.
      </p>
    </div>
  );
}

function LiveIndicator({ status }: { status: "connecting" | "open" | "error" | "closed" }) {
  const className =
    status === "open"
      ? "text-success"
      : status === "error"
        ? "text-destructive"
        : "text-muted-foreground";
  const label = status === "open" ? "live" : status;
  return <span className={`text-xs ${className}`}>· {label}</span>;
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</span>
      <span className="text-xs">{value}</span>
    </div>
  );
}

/**
 * Client-only relative timestamp — avoids SSR/CSR hydration mismatch
 * and ticks every 30s so "in 4m" keeps decaying visibly. Mirrors the
 * `ClientTime` pattern in approvals-live-view.
 */
function RelativeTs({ ms }: { ms: number | undefined }) {
  const [, setNow] = useState(0);
  useEffect(() => {
    const handle = setInterval(() => setNow((n) => n + 1), 30_000);
    return () => clearInterval(handle);
  }, []);

  if (ms === undefined) {
    return <span className="text-muted-foreground">—</span>;
  }
  return (
    <span suppressHydrationWarning title={new Date(ms).toISOString()}>
      {formatRelativeTime(ms)}
    </span>
  );
}
