import { Cron } from "croner";
import type { CronJob, CronSchedule } from "../shared/types/index.js";

/** Maximum ms representable by a JS Date — ±8.64e15 per ECMA-262. */
const MAX_SAFE_TIME_MS = 8_640_000_000_000_000;

/**
 * Parse a duration string like "30s", "5m", "1h", "24h", "2h30m", "7d" to
 * milliseconds. Supports combinations of days (d), hours (h), minutes (m),
 * seconds (s). Throws on invalid input or zero duration.
 *
 * This is the authoritative parser for all interval-like durations used by
 * the scheduler. Shared between `kind: "every"` (as the interval) and
 * `kind: "at"` (for relative offsets like "20m").
 */
export function parseInterval(interval: string): number {
  const pattern = /^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/;
  const match = interval.match(pattern);
  if (!match || match[0] === "") {
    throw new Error(
      `Invalid interval format: "${interval}" (expected e.g. "30s", "5m", "1h", "24h", "2h30m")`,
    );
  }

  const [, days, hours, minutes, seconds] = match;
  const ms =
    parseInt(days ?? "0", 10) * 86_400_000 +
    parseInt(hours ?? "0", 10) * 3_600_000 +
    parseInt(minutes ?? "0", 10) * 60_000 +
    parseInt(seconds ?? "0", 10) * 1_000;

  if (ms === 0) {
    throw new Error(`Interval must be greater than zero: "${interval}"`);
  }

  return ms;
}

/**
 * A parsed schedule ready for execution. All schedule kinds share this
 * interface so the scheduler only has to know how to ask for "the next run
 * time", not which kind it's dealing with.
 */
export interface ParsedSchedule {
  /**
   * Compute the next fire time strictly AFTER `fromMs`. Returns null if the
   * schedule has no future runs (one-shot already fired, cron with no
   * match in the permitted range, etc.).
   *
   * Use this after a job has fired at least once — it's what keeps
   * recurring schedules ticking and prevents a one-shot from firing twice.
   */
  nextRunAtMs(fromMs: number): number | null;
  /**
   * Compute the *initial* fire time for a job that has never fired before.
   * For recurring schedules this is the same as `nextRunAtMs`. For one-shot
   * `at` schedules, this returns the configured fire time even if it's in
   * the past — so a daemon that was down at fire time catches up on the
   * next restart instead of silently dropping the job.
   */
  initialFireAtMs(fromMs: number): number | null;
  /** True iff this schedule fires at most once (`kind: "at"`). */
  readonly isOneShot: boolean;
  /**
   * The schedule after normalization. Relative `at` strings ("20m") are
   * resolved to absolute ISO at parse time so storage is always canonical.
   * Every other kind passes through unchanged.
   */
  readonly normalized: CronSchedule;
}

/** Regex that admits anything `parseInterval` would accept. */
const RELATIVE_INTERVAL_PATTERN = /^\d+[dhms](?:\d+[dhms])*$/;

function parseAtToMs(at: string, nowMs: number): number {
  let absMs: number;
  if (RELATIVE_INTERVAL_PATTERN.test(at)) {
    absMs = nowMs + parseInterval(at);
  } else {
    absMs = Date.parse(at);
    if (Number.isNaN(absMs)) {
      throw new Error(
        `Invalid "at" value: "${at}" (expected ISO 8601 like "2026-04-19T08:00:00Z" or a relative offset like "20m")`,
      );
    }
  }
  // ECMA-262 caps Date at ±8.64e15 ms. A relative offset like "9999999999999m"
  // overflows — reject it with a clear error instead of letting the caller
  // hit a later `new Date(absMs).toISOString()` RangeError.
  if (!Number.isFinite(absMs) || Math.abs(absMs) > MAX_SAFE_TIME_MS) {
    throw new Error(`"at" value out of range: "${at}" (max ±2^53 ms from epoch)`);
  }
  return absMs;
}

/**
 * Normalize and validate a schedule, returning an executor that knows how
 * to compute its next fire time. Throws on malformed schedules — callers
 * should use this at the system boundary (Zod .refine, scheduler load) so
 * bad schedules never reach the timer loop.
 */
export function parseSchedule(schedule: CronSchedule, nowMs: number = Date.now()): ParsedSchedule {
  switch (schedule.kind) {
    case "every": {
      const intervalMs = parseInterval(schedule.interval);
      const nextFn = (fromMs: number): number => fromMs + intervalMs;
      return {
        isOneShot: false,
        normalized: schedule,
        nextRunAtMs: nextFn,
        initialFireAtMs: nextFn,
      };
    }

    case "at": {
      const absMs = parseAtToMs(schedule.at, nowMs);
      const normalized: CronSchedule = { kind: "at", at: new Date(absMs).toISOString() };
      return {
        isOneShot: true,
        normalized,
        nextRunAtMs: (fromMs) => (absMs > fromMs ? absMs : null),
        // One-shot catch-up: a past `at` still fires once on next restart.
        // The scheduler puts it in the missed-jobs queue and it runs with
        // the standard 5-second stagger.
        initialFireAtMs: () => absMs,
      };
    }

    case "cron": {
      // Validate by constructing a Cron instance. Croner throws synchronously
      // on malformed expressions (and on invalid IANA timezones).
      const cron = new Cron(schedule.expression, {
        timezone: schedule.timezone,
        // `paused: true` prevents croner from scheduling a real setTimeout
        // inside its constructor — we only use it as a pure "next run"
        // calculator; the scheduler owns timing.
        paused: true,
      });
      const nextFn = (fromMs: number): number | null => {
        const next = cron.nextRun(new Date(fromMs));
        return next ? next.getTime() : null;
      };
      return {
        isOneShot: false,
        normalized: schedule,
        nextRunAtMs: nextFn,
        initialFireAtMs: nextFn,
      };
    }
  }
}

/**
 * One-line human description of a schedule, shared by the scheduler log
 * output, the ledger writer, and anything else that wants a readable tag.
 *
 * Accepts a `CronJob` (rather than just the schedule) because the scheduler
 * wants "every 1h" / "at 2026-04-19T08:00:00Z" / `cron "0 8 * * *" (America/Sao_Paulo)`
 * in the same format a ledger entry uses — avoiding a second duplicated
 * helper with subtly different wording.
 */
export function describeSchedule(job: Pick<CronJob, "schedule">): string {
  const { schedule } = job;
  switch (schedule.kind) {
    case "every":
      return `every ${schedule.interval}`;
    case "at":
      return `at ${schedule.at}`;
    case "cron":
      return `cron "${schedule.expression}"${schedule.timezone ? ` (${schedule.timezone})` : ""}`;
  }
}
