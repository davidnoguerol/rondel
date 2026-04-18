"use client";

import { useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
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
  approval_request: "approval req",
  approval_decision: "approval",
  tool_call: "tool call",
  schedule_created: "schedule +",
  schedule_updated: "schedule ~",
  schedule_deleted: "schedule −",
};

const KIND_VARIANT = (kind: string) => {
  if (kind === "crash" || kind === "halt" || kind === "cron_failed") return "destructive" as const;
  if (kind === "session_reset") return "warning" as const;
  if (kind === "user_message" || kind === "agent_response") return "secondary" as const;
  return "info" as const;
};

/**
 * One ledger event. Timestamp left, kind badge, summary, channel/chat hint.
 * Kept deliberately plain — a live dashboard will have hundreds of
 * these, so we avoid expensive per-row rendering.
 */
export function LedgerRow({ event }: { event: LedgerEvent }) {
  // Invariant (see LedgerEvent): channelType and chatId are a pair. We
  // only need to check one — checking both keeps TS narrow without extra
  // runtime work. System events (cron) skip the hint entirely.
  return (
    <li className="grid grid-cols-[auto_auto_1fr_auto] items-start gap-3 px-5 py-3 border-b border-border last:border-b-0">
      <ClientTime ts={event.ts} />
      <Badge variant={KIND_VARIANT(event.kind)}>{KIND_LABEL[event.kind] ?? event.kind}</Badge>
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

/**
 * Locale- and timezone-dependent timestamps are rendered client-only so
 * SSR and the first client render always emit the same HTML. Server
 * emits an empty placeholder; the effect fills it with the user's local
 * HH:MM:SS on the tick after hydration.
 */
function ClientTime({ ts }: { readonly ts: string }) {
  const [label, setLabel] = useState<string>("");
  useEffect(() => {
    try {
      setLabel(
        new Date(ts).toLocaleTimeString(undefined, {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        }),
      );
    } catch {
      setLabel("");
    }
  }, [ts]);
  return (
    <time
      dateTime={ts}
      className="font-mono text-xs text-ink-subtle tabular-nums"
      title={ts}
    >
      {label}
    </time>
  );
}
