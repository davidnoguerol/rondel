/**
 * Conversation Ledger types.
 *
 * The ledger is a structured, append-only JSONL log of business-level events
 * across all agents. One file per agent at state/ledger/{agentName}.jsonl.
 * Events carry summaries (not full content) — the ledger is an index,
 * not a transcript.
 *
 * Pure types — no runtime imports.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Event kinds
// ---------------------------------------------------------------------------

export type LedgerEventKind =
  | "user_message"
  | "agent_response"
  | "inter_agent_sent"
  | "inter_agent_received"
  | "subagent_spawned"
  | "subagent_result"
  | "cron_completed"
  | "cron_failed"
  | "session_start"
  | "session_resumed"
  | "session_reset"
  | "crash"
  | "halt";

// ---------------------------------------------------------------------------
// Event schema
// ---------------------------------------------------------------------------

/** A single ledger entry. Append-only, one per JSONL line. */
export interface LedgerEvent {
  readonly ts: string;            // ISO 8601
  readonly agent: string;         // agentName
  readonly kind: LedgerEventKind;
  readonly chatId?: string;       // conversation context (omitted for system events)
  readonly summary: string;       // human-readable, 1-2 sentences max
  readonly detail?: unknown;      // kind-specific structured metadata
}

// ---------------------------------------------------------------------------
// Query schema (Zod — validated at system boundary)
// ---------------------------------------------------------------------------

/** Valid event kinds for query filtering. */
export const LEDGER_EVENT_KINDS: readonly LedgerEventKind[] = [
  "user_message", "agent_response",
  "inter_agent_sent", "inter_agent_received",
  "subagent_spawned", "subagent_result",
  "cron_completed", "cron_failed",
  "session_start", "session_resumed", "session_reset",
  "crash", "halt",
] as const;

export const LedgerQuerySchema = z.object({
  agent: z.string().optional(),
  since: z.string().optional(),
  kinds: z.array(z.string()).optional(),
  limit: z.number().int().min(1).max(500).optional(),
});

export type LedgerQueryParams = z.infer<typeof LedgerQuerySchema>;
