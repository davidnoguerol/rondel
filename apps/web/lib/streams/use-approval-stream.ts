"use client";

/**
 * Typed wrapper over `useStreamTopic` for the live approval tail.
 *
 * Usage:
 *   const { pending, resolved, status } = useApprovalStream({
 *     initialPending: ..., initialResolved: ...,
 *   });
 *
 * The daemon's initial list is fetched server-side by the `/approvals`
 * RSC page and passed in as `initialPending` / `initialResolved`. This
 * hook subscribes to the `approvals` topic on the shared multiplex
 * (one EventSource across the whole dashboard) and folds each frame
 * into the local state:
 *
 *   approval.requested  → prepend to pending
 *   approval.resolved   → remove from pending, prepend to resolved
 *
 * Lifecycle concerns (reconnect, cleanup, strict-mode safety) are
 * inherited from the provider.
 */

import { useMemo } from "react";

import {
  ApprovalStreamFrameSchema,
  type ApprovalRecord,
  type ApprovalStreamFrame,
  type RawSseFrame,
} from "@/lib/bridge";

import { useStreamTopic } from "./use-stream-topic";

export type ApprovalStreamStatus =
  | "connecting"
  | "open"
  | "error"
  | "closed";

export interface UseApprovalStreamOptions {
  readonly initialPending: readonly ApprovalRecord[];
  readonly initialResolved: readonly ApprovalRecord[];
  /** Cap the resolved list so long-running tabs don't grow the DOM forever. */
  readonly resolvedLimit?: number;
}

export interface UseApprovalStreamResult {
  readonly pending: readonly ApprovalRecord[];
  readonly resolved: readonly ApprovalRecord[];
  readonly status: ApprovalStreamStatus;
}

export function useApprovalStream(
  options: UseApprovalStreamOptions,
): UseApprovalStreamResult {
  const { initialPending, initialResolved } = options;
  const resolvedLimit = options.resolvedLimit ?? 50;

  const { events, status } = useStreamTopic<ApprovalStreamFrame>(
    "approvals",
    parseApprovalFrame,
  );

  // Fold the event log into (pending, resolved). We rebuild from the
  // initial server-rendered lists on every frame batch so the reducer
  // is stateless and immune to duplicate deliveries (a reconnect can
  // replay frames the browser already saw — handler must be idempotent).
  const { pending, resolved } = useMemo(() => {
    let pendingMap = new Map(initialPending.map((r) => [r.requestId, r]));
    let resolvedList = [...initialResolved];

    for (const frame of events) {
      const record = frame.data;
      if (frame.event === "approval.requested") {
        pendingMap.set(record.requestId, record);
        continue;
      }
      if (frame.event === "approval.resolved") {
        pendingMap.delete(record.requestId);
        // Replace any existing entry for this id (re-deliveries) so we
        // don't double up, then prepend (newest first).
        resolvedList = resolvedList.filter((r) => r.requestId !== record.requestId);
        resolvedList = [record, ...resolvedList];
      }
    }

    if (resolvedList.length > resolvedLimit) {
      resolvedList = resolvedList.slice(0, resolvedLimit);
    }

    // Stable order for pending: newest createdAt first. The server's
    // initial list is already sorted that way, and incoming `requested`
    // frames arrive in chronological order, but we re-sort here to
    // tolerate any reorder during replay.
    const pending = [...pendingMap.values()].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );

    return { pending, resolved: resolvedList };
  }, [events, initialPending, initialResolved, resolvedLimit]);

  return { pending, resolved, status };
}

function parseApprovalFrame(raw: RawSseFrame): ApprovalStreamFrame | null {
  const parsed = ApprovalStreamFrameSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
