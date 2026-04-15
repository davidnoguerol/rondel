"use client";

import { useEffect, useState } from "react";
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
 *
 * Timestamps are rendered client-only via `ClientTimestamp`. The parent
 * LedgerStream is a Client Component but the initial historical events
 * are seeded by a Server Component, so LedgerRow is still rendered
 * during SSR. `toLocaleTimeString` depends on locale + timezone, both
 * of which differ between the server (UTC) and the browser — rendering
 * it at SSR time would crash React with a hydration mismatch on every
 * row. Same precedent and pattern as commit 6c4a412 (web-chat messages).
 */
export function LedgerRow({ event }: { event: LedgerEvent }) {
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
        <ClientTimestamp ts={event.ts} />
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

/**
 * Render a locale- and timezone-dependent timestamp only after mount so
 * SSR and the first client render always agree. Empty placeholder on the
 * server; real "HH:MM:SS" on the client. `suppressHydrationWarning`
 * silences the single-node text diff for the very first paint — the
 * server renders "" and the client briefly renders "" before the effect
 * populates the real value on the next tick.
 */
function ClientTimestamp({ ts }: { readonly ts: string }) {
  const [label, setLabel] = useState<string>("");
  useEffect(() => {
    try {
      const d = new Date(ts);
      setLabel(
        d.toLocaleTimeString(undefined, {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        }),
      );
    } catch {
      setLabel("");
    }
  }, [ts]);
  return <span suppressHydrationWarning>{label}</span>;
}
