/**
 * Live approval stream source.
 *
 * Subscribes once to the `approval:requested` / `approval:resolved` hook
 * events fired by ApprovalService and fans each one out to N in-process
 * SSE clients (the web `/approvals` page). Filtering — e.g. per-agent —
 * happens at the client boundary in `handleSseRequest`, NOT here.
 *
 * One instance lives for the daemon's lifetime. Disposing the source
 * removes the hook listeners and drops every active client.
 *
 * Mirrors `ledger-stream.ts` exactly: same fan-out shape, same per-
 * listener error boundary, same SSE frame envelope.
 */

import type { RondelHooks } from "../shared/hooks.js";
import type { ApprovalRecord } from "../shared/types/approvals.js";

import type { SseFrame, StreamSource } from "./sse-types.js";

/** Wire-level event tags — kept stable across daemon versions. */
const APPROVAL_REQUESTED_EVENT = "approval.requested";
const APPROVAL_RESOLVED_EVENT = "approval.resolved";

export class ApprovalStreamSource implements StreamSource<ApprovalRecord> {
  private readonly clients = new Set<(frame: SseFrame<ApprovalRecord>) => void>();
  private readonly unsubscribeFromHooks: (() => void)[] = [];

  constructor(hooks: RondelHooks) {
    const onRequested = ({ record }: { record: ApprovalRecord }): void => {
      this.emitFrame({ event: APPROVAL_REQUESTED_EVENT, data: record });
    };
    const onResolved = ({ record }: { record: ApprovalRecord }): void => {
      this.emitFrame({ event: APPROVAL_RESOLVED_EVENT, data: record });
    };
    hooks.on("approval:requested", onRequested);
    hooks.on("approval:resolved", onResolved);
    this.unsubscribeFromHooks.push(() => hooks.off("approval:requested", onRequested));
    this.unsubscribeFromHooks.push(() => hooks.off("approval:resolved", onResolved));
  }

  subscribe(send: (frame: SseFrame<ApprovalRecord>) => void): () => void {
    this.clients.add(send);
    return () => {
      this.clients.delete(send);
    };
  }

  // No `snapshot()` — the initial list of pending + resolved approvals
  // comes from the existing GET /approvals endpoint (rendered server-
  // side by the `/approvals` RSC page). The stream only carries deltas.

  dispose(): void {
    for (const undo of this.unsubscribeFromHooks) {
      try {
        undo();
      } catch {
        // Hook off() semantics aren't ours to enforce here.
      }
    }
    this.unsubscribeFromHooks.length = 0;
    this.clients.clear();
  }

  getClientCount(): number {
    return this.clients.size;
  }

  private emitFrame(frame: SseFrame<ApprovalRecord>): void {
    if (this.clients.size === 0) return;
    // Snapshot the client set before iterating so an unsubscribe during
    // fan-out (e.g. EPIPE on a dead socket) doesn't invalidate the
    // iterator.
    for (const send of [...this.clients]) {
      try {
        send(frame);
      } catch {
        // Per-client error must not affect other clients. The sender
        // closure is bound to a response that may have already torn
        // down — `handleSseRequest` will clean it up via its
        // `req.close` / `res.error` listeners.
      }
    }
  }
}
