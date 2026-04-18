/**
 * Schedule watchdog — silent-failure detection for the Scheduler.
 *
 * The scheduler is robust against restart (persisted state, missed-job
 * catchup on `start()`) but there are classes of failure it cannot
 * self-detect while running:
 *
 *  - OS sleep pausing Node timers → timer fires late, no one notices
 *  - Job stuck in exponential backoff → fires every 60 min, user sees silence
 *  - Never-fired startup bug → `nextRunAtMs === undefined` after insert
 *
 * The watchdog runs a periodic scan over the scheduler's job summaries,
 * classifies each job, and emits transition events (`schedule:overdue`
 * and `schedule:recovered`). The `LedgerWriter` persists them; SSE clients
 * see them live.
 *
 * Transition-only emission is the key invariant: steady states don't
 * emit. Without this, a chronically broken job would spam the ledger
 * every scan interval.
 *
 * The watchdog does NOT implement scheduling itself. It observes and
 * reports. Optional self-heal (`selfHeal: true`) calls `scheduler.rearm()`
 * on timer_drift — safe because armTimer is idempotent.
 */

import type { RondelHooks } from "../shared/hooks.js";
import type { Logger } from "../shared/logger.js";
import type { ScheduleOverdueReason } from "../shared/hooks.js";

// ---------------------------------------------------------------------------
// Defaults — tuned for single-operator deployments. Tune via constructor
// options if deployments need different tolerances.
// ---------------------------------------------------------------------------

/** How often to scan all jobs for overdue conditions. */
export const DEFAULT_SCAN_INTERVAL_MS = 2 * 60 * 1000; // 2 min

/**
 * How far past `nextRunAtMs` a job has to be before it's flagged as overdue.
 * Must be wider than DEFAULT_SCAN_INTERVAL_MS to absorb scanner jitter.
 */
export const DEFAULT_GRACE_MS = 5 * 60 * 1000; // 5 min

/**
 * Consecutive errors at which a job is considered "stuck in backoff."
 * Matches the first long bucket in `getBackoffDelay` (5 min at errors=3).
 */
export const DEFAULT_BACKOFF_THRESHOLD = 3;

// ---------------------------------------------------------------------------
// Narrow scheduler view — the watchdog depends only on this interface, not
// the concrete Scheduler class. Keeps the boundary testable.
// ---------------------------------------------------------------------------

export interface WatchdogJobSummary {
  readonly agentName: string;
  readonly jobId: string;
  readonly jobName: string;
  readonly enabled: boolean;
  readonly consecutiveErrors: number;
  readonly lastRunAtMs?: number;
  readonly nextRunAtMs?: number;
}

export interface SchedulerView {
  getJobSummaries(): readonly WatchdogJobSummary[];
  /** Optional self-heal entry point. The watchdog only calls this when `selfHeal` is enabled. */
  rearm?(): void;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ScheduleWatchdogOptions {
  readonly scheduler: SchedulerView;
  readonly hooks: RondelHooks;
  readonly log: Logger;
  readonly scanIntervalMs?: number;
  readonly graceMs?: number;
  readonly backoffThreshold?: number;
  /**
   * When true, the watchdog calls `scheduler.rearm()` on every `timer_drift`
   * detection. `armTimer()` is idempotent so this is safe to repeat.
   *
   * Recommendation: leave off for the first week of production to collect
   * signal-quality data. Flip on once overdue events are proven to
   * correlate with real failures.
   */
  readonly selfHeal?: boolean;
  /** Injectable clock — for tests. Defaults to Date.now. */
  readonly now?: () => number;
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

interface OverdueState {
  readonly since: number;
  readonly reason: ScheduleOverdueReason;
}

function stateKey(agentName: string, jobId: string): string {
  return `${agentName}:${jobId}`;
}

// ---------------------------------------------------------------------------
// Watchdog
// ---------------------------------------------------------------------------

export class ScheduleWatchdog {
  private readonly scheduler: SchedulerView;
  private readonly hooks: RondelHooks;
  private readonly log: Logger;
  private readonly scanIntervalMs: number;
  private readonly graceMs: number;
  private readonly backoffThreshold: number;
  private readonly selfHeal: boolean;
  private readonly now: () => number;

  private readonly overdueJobs = new Map<string, OverdueState>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(options: ScheduleWatchdogOptions) {
    this.scheduler = options.scheduler;
    this.hooks = options.hooks;
    this.log = options.log.child("watchdog");
    this.scanIntervalMs = options.scanIntervalMs ?? DEFAULT_SCAN_INTERVAL_MS;
    this.graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
    this.backoffThreshold = options.backoffThreshold ?? DEFAULT_BACKOFF_THRESHOLD;
    this.selfHeal = options.selfHeal ?? false;
    this.now = options.now ?? Date.now;
  }

  /**
   * Start periodic scanning. First scan fires after `scanIntervalMs` —
   * not immediately — so the scheduler has time to finish its own
   * startup-time missed-job catchup before we start classifying.
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    const timer = setInterval(() => {
      try {
        this.scanOnce();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log.warn(`Watchdog scan threw: ${msg}`);
      }
    }, this.scanIntervalMs);
    // Don't keep the event loop alive on shutdown.
    timer.unref();
    this.timer = timer;
    this.log.info(
      `Schedule watchdog started (scan=${this.scanIntervalMs}ms, grace=${this.graceMs}ms, ` +
        `backoffThreshold=${this.backoffThreshold}, selfHeal=${this.selfHeal})`,
    );
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.overdueJobs.clear();
  }

  /**
   * Run a single scan pass. Exposed for tests; callers in production
   * should rely on the interval driven by `start()`.
   */
  scanOnce(): void {
    const summaries = this.scheduler.getJobSummaries();
    const now = this.now();
    const seen = new Set<string>();

    for (const job of summaries) {
      const key = stateKey(job.agentName, job.jobId);
      seen.add(key);

      // Disabled jobs can't be overdue — they're supposed to be silent.
      if (!job.enabled) {
        this.transitionToHealthy(job, now);
        continue;
      }

      const reason = this.classify(job, now);
      if (reason === null) {
        this.transitionToHealthy(job, now);
      } else {
        this.transitionToOverdue(job, reason, now);
      }
    }

    // Clean up entries for jobs that disappeared (auto-deleted one-shots,
    // explicit removal, agent deletion). No `recovered` event — the job
    // is gone, not fixed. Signaling recovery for a deleted job would be
    // misleading.
    for (const key of [...this.overdueJobs.keys()]) {
      if (!seen.has(key)) {
        this.overdueJobs.delete(key);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Classification
  // -------------------------------------------------------------------------

  /**
   * Classify a job. Returns the overdue reason or null for healthy.
   *
   * Priority (most actionable first):
   *   1. stuck_in_backoff — consecutiveErrors >= threshold
   *   2. never_fired — overdue AND no recorded lastRunAtMs
   *   3. timer_drift — overdue AND has run at least once before
   *   4. healthy
   */
  private classify(job: WatchdogJobSummary, now: number): ScheduleOverdueReason | null {
    if (job.consecutiveErrors >= this.backoffThreshold) {
      return "stuck_in_backoff";
    }
    // A job with no scheduled fire (disabled briefly, or between a
    // completed one-shot and its deletion) is not overdue.
    if (job.nextRunAtMs === undefined) {
      return null;
    }
    const overdueByMs = now - job.nextRunAtMs;
    if (overdueByMs <= this.graceMs) {
      return null;
    }
    return job.lastRunAtMs === undefined ? "never_fired" : "timer_drift";
  }

  // -------------------------------------------------------------------------
  // State transitions — emission gate
  // -------------------------------------------------------------------------

  private transitionToOverdue(
    job: WatchdogJobSummary,
    reason: ScheduleOverdueReason,
    now: number,
  ): void {
    const key = stateKey(job.agentName, job.jobId);
    const existing = this.overdueJobs.get(key);

    // Steady state — already overdue with the same reason. Suppress.
    if (existing && existing.reason === reason) {
      this.maybeSelfHeal(reason);
      return;
    }

    // Either fresh overdue or reason transition. Emit.
    this.overdueJobs.set(key, { since: now, reason });

    const expectedAtMs = job.nextRunAtMs;
    const overdueByMs =
      expectedAtMs !== undefined ? Math.max(0, now - expectedAtMs) : 0;

    this.hooks.emit("schedule:overdue", {
      agentName: job.agentName,
      jobId: job.jobId,
      jobName: job.jobName,
      reason,
      expectedAtMs,
      observedAtMs: now,
      overdueByMs,
      consecutiveErrors: job.consecutiveErrors,
    });

    this.log.warn(
      `Schedule "${job.agentName}:${job.jobId}" overdue — reason=${reason}, ` +
        `overdueByMs=${overdueByMs}, consecutiveErrors=${job.consecutiveErrors}`,
    );

    this.maybeSelfHeal(reason);
  }

  private transitionToHealthy(job: WatchdogJobSummary, now: number): void {
    const key = stateKey(job.agentName, job.jobId);
    const existing = this.overdueJobs.get(key);
    if (!existing) return;

    this.overdueJobs.delete(key);
    this.hooks.emit("schedule:recovered", {
      agentName: job.agentName,
      jobId: job.jobId,
      jobName: job.jobName,
      recoveredAtMs: now,
      wasOverdueForMs: Math.max(0, now - existing.since),
      previousReason: existing.reason,
    });

    this.log.info(
      `Schedule "${job.agentName}:${job.jobId}" recovered — was overdue for ` +
        `${Math.round((now - existing.since) / 1000)}s (${existing.reason})`,
    );
  }

  // -------------------------------------------------------------------------
  // Self-heal — only for timer_drift. stuck_in_backoff is a state the
  // scheduler is already handling correctly (the job is backing off per
  // design); nudging armTimer wouldn't fix the root cause. never_fired
  // indicates a deeper bug that rearm() alone probably won't resolve,
  // but rearming at least gives the timer a chance to recover.
  // -------------------------------------------------------------------------

  private maybeSelfHeal(reason: ScheduleOverdueReason): void {
    if (!this.selfHeal) return;
    if (reason === "stuck_in_backoff") return;
    if (this.scheduler.rearm) {
      this.scheduler.rearm();
    }
  }
}
