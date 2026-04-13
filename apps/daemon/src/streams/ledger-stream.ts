/**
 * Live ledger stream source.
 *
 * Subscribes once to `LedgerWriter.onAppended` and fans each new event
 * out to N in-process clients (HTTP SSE responses, internal observers,
 * eventual test fixtures, …). Filtering — by agent or by event kind —
 * happens at the client boundary in `handleSseRequest`, NOT here.
 *
 * One instance lives for the daemon's lifetime. Multiple `/ledger/tail`
 * requests (per-agent or system-wide) all share this single upstream
 * subscription. Disposing the source removes the LedgerWriter listener
 * and drops every active client.
 */

import type { LedgerEvent } from "../ledger/ledger-types.js";
import type { LedgerWriter } from "../ledger/ledger-writer.js";

import type { SseFrame, StreamSource } from "./sse-types.js";

/** Wire-level event tag — kept stable across daemon versions. */
const LEDGER_APPENDED_EVENT = "ledger.appended";

export class LedgerStreamSource implements StreamSource<LedgerEvent> {
  private readonly clients = new Set<(frame: SseFrame<LedgerEvent>) => void>();
  private readonly unsubscribeFromWriter: () => void;

  constructor(ledgerWriter: LedgerWriter) {
    this.unsubscribeFromWriter = ledgerWriter.onAppended((event) => {
      // Snapshot the client set before iterating so an unsubscribe
      // during fan-out (e.g. EPIPE on a dead socket) doesn't invalidate
      // the iterator.
      if (this.clients.size === 0) return;
      const frame: SseFrame<LedgerEvent> = {
        event: LEDGER_APPENDED_EVENT,
        data: event,
      };
      for (const send of [...this.clients]) {
        try {
          send(frame);
        } catch {
          // Per-client error must not affect other clients. The sender
          // closure is bound to a response that may have already torn
          // down — `handleSseRequest` will clean it up via the
          // `req.close` / `res.error` listeners.
        }
      }
    });
  }

  subscribe(send: (frame: SseFrame<LedgerEvent>) => void): () => void {
    this.clients.add(send);
    return () => {
      this.clients.delete(send);
    };
  }

  // No `snapshot()` — the ledger is append-only. Initial state on the
  // ledger page comes from the existing /ledger/query GET endpoint
  // (rendered server-side by RSC) plus an optional `?since=<ts>` replay
  // handled at the bridge handler layer, NOT here.

  dispose(): void {
    this.unsubscribeFromWriter();
    this.clients.clear();
  }

  getClientCount(): number {
    return this.clients.size;
  }
}
