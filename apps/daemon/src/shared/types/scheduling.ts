// --- Cron / Scheduler ---

export interface CronJob {
  readonly id: string;
  readonly name: string;
  readonly enabled?: boolean; // default: true
  /** If true, the job is removed after its first successful run. Default: true for `kind: "at"`, false otherwise. */
  readonly deleteAfterRun?: boolean;
  readonly schedule: CronSchedule;
  readonly prompt: string;
  readonly sessionTarget?: CronSessionTarget; // default: "isolated"
  readonly delivery?: CronDelivery;
  readonly model?: string;
  readonly timeoutMs?: number;

  /**
   * Runtime metadata. Declarative jobs (loaded from agent.json) omit these.
   * Runtime jobs (created via `rondel_schedule_create`) populate them.
   */
  readonly source?: CronJobSource;
  /** Agent that created this runtime job (runtime jobs only). */
  readonly owner?: string;
  /** ms epoch when the job was created (runtime jobs only). */
  readonly createdAtMs?: number;
}

export type CronJobSource = "declarative" | "runtime";

/**
 * Discriminated union of schedule kinds.
 *
 * - `every`: recurring at a fixed interval ("30s", "5m", "1h", "2h30m", "7d").
 * - `at`: one-shot at a specific time. Accepts ISO 8601 ("2026-04-19T08:00:00Z")
 *   or a relative offset from now ("20m", "1h30m"). Relative forms are
 *   resolved to absolute ISO at creation time and stored as ISO.
 * - `cron`: standard 5-field cron expression ("0 8 * * *"), evaluated via
 *   the `croner` library. Optional IANA timezone (e.g., "America/Sao_Paulo");
 *   defaults to the daemon's local timezone.
 */
export type CronSchedule =
  | { readonly kind: "every"; readonly interval: string }
  | { readonly kind: "at"; readonly at: string }
  | { readonly kind: "cron"; readonly expression: string; readonly timezone?: string };

export type CronSessionTarget = "isolated" | `session:${string}`;

/**
 * Where the scheduler delivers the job's result text.
 *
 * `announce` routes the text to a channel. `channelType` and `accountId` may
 * be omitted — the scheduler falls back to the agent's primary channel
 * binding (preserving today's behaviour for declarative jobs). Runtime jobs
 * typically carry all three so they can route back to the exact chat where
 * the schedule was created, even if the agent later speaks on multiple
 * channels.
 */
export type CronDelivery =
  | { readonly mode: "none" }
  | {
      readonly mode: "announce";
      readonly chatId: string;
      readonly channelType?: string;
      readonly accountId?: string;
    };

export type CronRunStatus = "ok" | "error" | "skipped";

export interface CronJobState {
  lastRunAtMs?: number;
  nextRunAtMs?: number;
  consecutiveErrors: number;
  lastStatus?: CronRunStatus;
  lastError?: string;
  lastDurationMs?: number;
  lastCostUsd?: number;
}

export interface CronRunResult {
  readonly status: CronRunStatus;
  readonly result?: string;
  readonly error?: string;
  readonly costUsd?: number;
  readonly durationMs: number;
}
