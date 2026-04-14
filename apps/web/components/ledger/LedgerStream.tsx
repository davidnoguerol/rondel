"use client";

/**
 * Client-side merged ledger view — historical + live in one timeline.
 *
 * The parent (a Server Component on the ledger page) fetches the
 * historical events server-side via `bridge.ledger.query()` and passes
 * them in as `initialEvents`. We open an SSE tail with `?since=<ts>`
 * pinned to the newest historical event so the daemon backfills the
 * gap between the RSC fetch and the SSE attach. From there, we render
 * the merged list in newest-first order.
 *
 * The merging logic is small but exact:
 *   1. Start state is `initialEvents` (already newest-first).
 *   2. New events from `useLedgerTail` arrive append-only. We dedupe
 *      against the merged list using a `(ts, kind, chatId, summary,
 *      detail-hash)` tuple — ts alone is not enough because ledger
 *      events have no monotonic sequence number and same-ms collisions
 *      are possible. Summaries are truncated server-side, so chatty
 *      agents can produce two distinct events with the same truncated
 *      summary at the same ms; including chatId and a cheap detail
 *      hash shrinks the collision window to effectively zero for M2
 *      until the daemon assigns event ids.
 *   3. We sort the merged list by `ts` descending on every change. For
 *      M2's bounded list (~600 max), this is fine; if it ever shows up
 *      in profiles, switch to insertion-into-a-sorted-list.
 */

import { useMemo } from "react";

import type { LedgerEvent } from "@/lib/bridge";
import { useLedgerTail } from "@/lib/streams";

import { LedgerRow } from "./LedgerRow";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { LiveDot } from "./LiveDot";

interface LedgerStreamProps {
  agent: string;
  initialEvents: readonly LedgerEvent[];
}

export function LedgerStream({ agent, initialEvents }: LedgerStreamProps) {
  // Anchor the SSE backfill cursor to the newest historical event we have.
  // If the page rendered with zero historical events (new agent), the
  // tail starts from "now" with no replay.
  const since = initialEvents[0]?.ts;

  const { events: liveEvents, status } = useLedgerTail(agent, { since });

  // Merge initial + live, dedupe, sort newest-first.
  const merged = useMemo(() => {
    const all: LedgerEvent[] = [...initialEvents];
    const seen = new Set<string>(initialEvents.map(dedupeKey));
    for (const event of liveEvents) {
      const key = dedupeKey(event);
      if (seen.has(key)) continue;
      seen.add(key);
      all.push(event);
    }
    // Newest first — string ts comparison is correct for ISO 8601.
    all.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
    return all;
  }, [initialEvents, liveEvents]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <span className="flex items-center gap-2">
            Events
            <span className="text-ink-subtle font-normal">({merged.length})</span>
            <span className="ml-auto inline-flex items-center gap-1.5">
              <LiveDot status={status} />
              <span className="text-[11px] font-normal text-ink-muted">
                {labelFor(status)}
              </span>
            </span>
          </span>
        </CardTitle>
      </CardHeader>
      <CardBody className="p-0">
        {merged.length === 0 ? (
          <div className="px-5 py-8 text-center">
            <p className="text-sm text-ink-muted">
              No ledger events for this agent yet.
            </p>
            <p className="text-xs text-ink-subtle mt-1">
              Events appear here as the agent sends and receives messages,
              spawns subagents, or runs crons.
            </p>
          </div>
        ) : (
          <ul>
            {merged.map((event, idx) => (
              <LedgerRow
                key={`${event.ts}-${event.kind}-${idx}`}
                event={event}
              />
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

function dedupeKey(event: LedgerEvent): string {
  // Cheap stable fingerprint of `detail` — JSON.stringify is fine at this
  // volume (bounded ~600 events) and gives us collision resistance for
  // free when two events share ts/kind/channelType/chatId/summary but
  // differ in their structured payload. `detail` is `unknown`, so we
  // stringify defensively. channelType is part of the key because chatIds
  // are not globally unique across channels — the same id can occur on
  // Telegram and web, and merging them here would hide real events.
  let detailFingerprint = "";
  if (event.detail !== undefined) {
    try {
      detailFingerprint = JSON.stringify(event.detail);
    } catch {
      detailFingerprint = "_";
    }
  }
  return `${event.ts}|${event.kind}|${event.channelType ?? ""}|${event.chatId ?? ""}|${event.summary}|${detailFingerprint}`;
}

function labelFor(status: "connecting" | "open" | "error" | "closed"): string {
  switch (status) {
    case "open":
      return "live";
    case "connecting":
      return "connecting…";
    case "error":
      return "reconnecting…";
    case "closed":
      return "offline";
  }
}
