// --- Cron / Scheduler ---

export interface CronJob {
  readonly id: string;
  readonly name: string;
  readonly enabled?: boolean; // default: true
  readonly schedule: CronSchedule;
  readonly prompt: string;
  readonly sessionTarget?: CronSessionTarget; // default: "isolated"
  readonly delivery?: CronDelivery;
  readonly model?: string;
  readonly timeoutMs?: number;
}

export interface CronSchedule {
  readonly kind: "every";
  readonly interval: string; // e.g. "30s", "5m", "1h", "24h", "2h30m"
}

export type CronSessionTarget = "isolated" | `session:${string}`;

export type CronDelivery =
  | { readonly mode: "none" }
  | { readonly mode: "announce"; readonly chatId: string };

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
