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
  | "halt"
  | "approval_request"
  | "approval_decision"
  | "tool_call"
  | "schedule_created"
  | "schedule_updated"
  | "schedule_deleted"
  | "schedule_overdue"
  | "schedule_recovered"
  | "heartbeat_updated";

/**
 * Structured detail payload carried by `tool_call` events.
 *
 * Emitted when a first-class Rondel tool (rondel_bash, future
 * rondel_{read,write,edit}_file) finishes execution — success or error.
 * The summary on the LedgerEvent is a short human-readable line; this
 * object carries the machine-readable metadata.
 */
export interface ToolCallDetail {
  readonly toolName: string;
  readonly outcome: "success" | "error";
  readonly durationMs: number;
  readonly exitCode?: number;
  /** First 500 chars of stderr / error message. */
  readonly error?: string;
}

// ---------------------------------------------------------------------------
// Event schema
// ---------------------------------------------------------------------------

/**
 * A single ledger entry. Append-only, one per JSONL line.
 *
 * Invariant: `channelType` and `chatId` are a pair — both present for
 * conversation/session-bound events, both absent for system-wide events
 * (cron). A `chatId` without a `channelType` is ambiguous because the
 * same id string can occur on different channels (Telegram, web), and
 * every other layer of Rondel keys on the composite `(agentName,
 * channelType, chatId)`. Writers must always set them together or not
 * at all; readers can assume the invariant.
 */
export interface LedgerEvent {
  readonly ts: string;            // ISO 8601
  readonly agent: string;         // agentName
  readonly kind: LedgerEventKind;
  readonly channelType?: string;  // paired with chatId; omitted for system events
  readonly chatId?: string;       // paired with channelType; omitted for system events
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
  "approval_request", "approval_decision",
  "tool_call",
  "schedule_created", "schedule_updated", "schedule_deleted",
  "schedule_overdue", "schedule_recovered",
  "heartbeat_updated",
] as const;

export const LedgerQuerySchema = z.object({
  agent: z.string().optional(),
  since: z.string().optional(),
  kinds: z.array(z.string()).optional(),
  limit: z.number().int().min(1).max(500).optional(),
});

export type LedgerQueryParams = z.infer<typeof LedgerQuerySchema>;
