/**
 * Heartbeat types.
 *
 * A heartbeat is a per-agent liveness record written to
 * `state/heartbeats/{agentName}.json` by the agent itself during its
 * 4-hour discipline turn (see `rondel-heartbeat` framework skill).
 *
 * One file per agent, mutable, overwritten in place — same shape
 * as the inbox and approval stores. The ledger carries history;
 * the record carries "right now."
 *
 * Pure types, no runtime imports.
 */

// ---------------------------------------------------------------------------
// Record
// ---------------------------------------------------------------------------

export interface HeartbeatRecord {
  readonly agent: string;
  /** Owning org name, or `"global"` for unaffiliated agents. */
  readonly org: string;
  /** Short free-form status string set by the agent on its check-in. */
  readonly status: string;
  /** One-line summary of what the agent is currently working on. */
  readonly currentTask?: string;
  /** ISO 8601 — the only timestamp on the record. */
  readonly updatedAt: string;
  /** Interval (ms) the cron was firing when this was written — lets consumers compute an expected-next. */
  readonly intervalMs: number;
  /** Optional longer free-form note the agent left for future-itself. */
  readonly notes?: string;
}

// ---------------------------------------------------------------------------
// Health classification
// ---------------------------------------------------------------------------

/**
 * Health classification for a heartbeat record.
 *
 * - `healthy` — age ≤ 5h (the cron is firing on schedule)
 * - `stale`   — 5h < age ≤ 24h (at least one beat missed; still reachable)
 * - `down`    — age > 24h (the agent has been silent for more than a day)
 *
 * "missing" (no record at all) is surfaced separately in the readAll
 * response — not a health tier because there's no record to classify.
 */
export type HealthStatus = "healthy" | "stale" | "down";
