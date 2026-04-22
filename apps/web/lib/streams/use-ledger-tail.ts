"use client";

/**
 * Typed wrapper over `useStreamTopic` for the live ledger tail.
 *
 * Usage:
 *   const { events, status } = useLedgerTail("bot1");
 *
 * Pass `null` as the agent name to disable the subscription (e.g.
 * while the agent param hasn't resolved yet).
 *
 * =============================================================================
 * WHAT CHANGED IN v17 (API bump)
 * =============================================================================
 *
 * Pre-v17 this hook opened its own `EventSource` at `/api/bridge/
 * ledger/tail/:agent` with an optional `?since=` replay query. Post-
 * multiplex, all consumers share one connection and the server no
 * longer offers per-agent filtering or ?since replay — too little
 * volume on localhost to justify the server-side bookkeeping.
 *
 * Consequences this hook handles:
 *   - Per-agent filtering moves client-side (drop frames where
 *     `event.agent !== agent`).
 *   - ?since replay is gone. The ledger page already renders the
 *     initial historical slice via the server-side
 *     `bridge.ledger.query` call; live frames take over from there,
 *     and any events that arrived during the render window would be
 *     delivered on the live stream the moment the provider's
 *     subscription is open — which it is before the page's useEffect
 *     runs because the provider is mounted at the dashboard layout.
 *     The visible-gap concern that justified `?since=` doesn't apply
 *     here.
 */

import {
  LedgerStreamFrameSchema,
  type LedgerEvent,
  type RawSseFrame,
} from "@/lib/bridge";

import { useStreamTopic } from "./use-stream-topic";
import type { UseEventStreamResult } from "./use-event-stream";

export interface UseLedgerTailOptions {
  /**
   * Reserved. `?since=` replay is no longer supported server-side
   * after the v17 multiplex consolidation. Kept on the interface so
   * existing callers compile unchanged; the field is ignored.
   */
  readonly since?: string;
}

export function useLedgerTail(
  agent: string | null,
  _options: UseLedgerTailOptions = {},
): UseEventStreamResult<LedgerEvent> {
  // Build a parser closure over the agent filter. The parser is
  // captured in a ref inside `useStreamTopic`, so changing `agent`
  // between renders correctly drops frames from the previous agent
  // until the next subscribe cycle.
  const parse = (raw: RawSseFrame): LedgerEvent | null => {
    if (agent === null) return null;
    const parsed = LedgerStreamFrameSchema.safeParse(raw);
    if (!parsed.success) return null;
    const event = parsed.data.data;
    return event.agent === agent ? event : null;
  };

  return useStreamTopic<LedgerEvent>("ledger", parse);
}
