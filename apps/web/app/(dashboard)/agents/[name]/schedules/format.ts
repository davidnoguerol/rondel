/**
 * Pure formatters for the schedules UI. Kept outside any component so
 * the view stays declarative and these can be unit-tested in isolation
 * if they grow.
 */

import type { ScheduleKind, ScheduleStatus } from "@/lib/bridge";

/**
 * Human-readable one-liner for a schedule kind.
 *
 *   every    → "every 5m"
 *   at       → "at 2026-05-01 09:00"
 *   cron     → "cron 0 8 * * * (America/Sao_Paulo)"
 */
export function formatScheduleKind(kind: ScheduleKind): string {
  switch (kind.kind) {
    case "every":
      return `every ${kind.interval}`;
    case "at":
      return `at ${formatAtValue(kind.at)}`;
    case "cron":
      return kind.timezone ? `cron ${kind.expression} (${kind.timezone})` : `cron ${kind.expression}`;
  }
}

function formatAtValue(raw: string): string {
  // ISO 8601 → compact local-ish rendering. Relative offsets like "20m"
  // are already resolved to ISO at creation time; if we see one here, pass
  // it through unchanged.
  const ts = Date.parse(raw);
  if (Number.isNaN(ts)) return raw;
  const date = new Date(ts);
  const iso = date.toISOString();
  return iso.replace("T", " ").replace(/:\d{2}\.\d{3}Z$/, "Z");
}

/**
 * Relative time label ("in 4m", "2h ago", "—"). `ms` is an absolute
 * epoch in milliseconds; `now` is an override seam for tests.
 */
export function formatRelativeTime(ms: number | undefined, now: number = Date.now()): string {
  if (ms === undefined) return "—";
  const diff = ms - now;
  const abs = Math.abs(diff);
  const suffix = diff >= 0 ? "in " : "";
  const postfix = diff >= 0 ? "" : " ago";
  const label = formatDurationMs(abs);
  return `${suffix}${label}${postfix}`;
}

function formatDurationMs(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  const days = Math.round(hours / 24);
  return `${days}d`;
}

/**
 * Small color + label bundle for a lastStatus chip. Callers can use
 * whichever field fits their component (e.g. just the className for a
 * colored dot, or both for a tooltip label).
 */
export function formatStatusBadge(status: ScheduleStatus | undefined): {
  label: string;
  className: string;
} {
  switch (status) {
    case "ok":
      return { label: "OK", className: "text-success" };
    case "error":
      return { label: "ERROR", className: "text-destructive" };
    case "skipped":
      return { label: "SKIPPED", className: "text-muted-foreground" };
    default:
      return { label: "—", className: "text-muted-foreground" };
  }
}

/** Short human-readable delivery summary for the card. */
export function formatDelivery(
  delivery: { mode: "none" } | { mode: "announce"; chatId: string; channelType?: string; accountId?: string } | undefined,
): string {
  if (!delivery || delivery.mode === "none") return "no delivery";
  const channel = delivery.channelType ? `${delivery.channelType}:` : "";
  return `→ ${channel}${delivery.chatId}`;
}
