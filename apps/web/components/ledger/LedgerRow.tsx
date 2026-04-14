import { Badge } from "@/components/ui/Badge";
import type { LedgerEvent } from "@/lib/bridge";

const KIND_LABEL: Record<string, string> = {
  user_message: "user msg",
  agent_response: "response",
  inter_agent_sent: "sent",
  inter_agent_received: "received",
  subagent_spawned: "subagent spawn",
  subagent_result: "subagent result",
  cron_completed: "cron ok",
  cron_failed: "cron fail",
  session_start: "session start",
  session_resumed: "session resume",
  session_reset: "session reset",
  crash: "crash",
  halt: "halt",
};

const KIND_TONE = (kind: string) => {
  if (kind === "crash" || kind === "halt" || kind === "cron_failed") return "danger" as const;
  if (kind === "session_reset") return "warning" as const;
  if (kind === "user_message" || kind === "agent_response") return "neutral" as const;
  return "info" as const;
};

/**
 * One ledger event. Timestamp left, kind badge, summary, channel/chat hint.
 * Kept deliberately plain — a live dashboard will have hundreds of
 * these, so we avoid expensive per-row rendering.
 */
export function LedgerRow({ event }: { event: LedgerEvent }) {
  const timeLabel = new Date(event.ts).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  // Invariant (see LedgerEvent): channelType and chatId are a pair. We
  // only need to check one — checking both keeps TS narrow without extra
  // runtime work. System events (cron) skip the hint entirely.
  return (
    <li className="grid grid-cols-[auto_auto_1fr_auto] items-start gap-3 px-5 py-3 border-b border-border last:border-b-0">
      <time
        dateTime={event.ts}
        className="font-mono text-xs text-ink-subtle tabular-nums"
        title={event.ts}
      >
        {timeLabel}
      </time>
      <Badge tone={KIND_TONE(event.kind)}>{KIND_LABEL[event.kind] ?? event.kind}</Badge>
      <p className="text-sm text-ink truncate" title={event.summary}>
        {event.summary}
      </p>
      {event.channelType && event.chatId && (
        <span className="font-mono text-[11px] text-ink-subtle">
          {event.channelType} · chat {event.chatId}
        </span>
      )}
    </li>
  );
}
