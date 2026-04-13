"use client";

/**
 * Typed wrapper over `useEventStream` for the live ledger tail.
 *
 * Usage:
 *   const { events, status } = useLedgerTail("bot1", { since: lastTs });
 *
 * Pass `null` as the agent name to disable the connection (e.g. when the
 * agent param hasn't resolved yet). Pass `since` as an ISO 8601 timestamp
 * to backfill events newer than that cursor before the live flow attaches.
 */

import {
  LedgerStreamFrameSchema,
  type LedgerEvent,
} from "@/lib/bridge";

import { useEventStream, type UseEventStreamResult } from "./use-event-stream";

export interface UseLedgerTailOptions {
  /**
   * ISO 8601 timestamp. The daemon will replay every event newer than
   * this cursor before attaching the live stream — closes the gap
   * between the page's server-rendered historical fetch and the first
   * live frame.
   */
  readonly since?: string;
}

export function useLedgerTail(
  agent: string | null,
  options: UseLedgerTailOptions = {},
): UseEventStreamResult<LedgerEvent> {
  const url = agent ? buildUrl(agent, options.since) : null;
  return useEventStream<LedgerEvent>(url, parseLedgerFrame);
}

function buildUrl(agent: string, since: string | undefined): string {
  // Always go through the same-origin proxy at /api/bridge/...
  // The middleware loopback gate and origin check apply automatically.
  const path = `/api/bridge/ledger/tail/${encodeURIComponent(agent)}`;
  if (!since) return path;
  const qs = new URLSearchParams({ since }).toString();
  return `${path}?${qs}`;
}

function parseLedgerFrame(raw: unknown): LedgerEvent | null {
  const parsed = LedgerStreamFrameSchema.safeParse(raw);
  return parsed.success ? parsed.data.data : null;
}
