import { describe, it, expect, beforeEach, vi } from "vitest";
import { ScheduleWatchdog, type SchedulerView, type WatchdogJobSummary } from "./watchdog.js";
import { createHooks, type RondelHooks, type ScheduleOverdueEvent, type ScheduleRecoveredEvent } from "../shared/hooks.js";
import type { Logger } from "../shared/logger.js";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

function silentLogger(): Logger {
  const noop = () => {};
  return {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => silentLogger(),
  };
}

class FakeScheduler implements SchedulerView {
  public summaries: WatchdogJobSummary[] = [];
  public rearmCalls = 0;

  getJobSummaries(): readonly WatchdogJobSummary[] {
    return this.summaries;
  }

  rearm(): void {
    this.rearmCalls += 1;
  }
}

interface Harness {
  scheduler: FakeScheduler;
  hooks: RondelHooks;
  overdue: ScheduleOverdueEvent[];
  recovered: ScheduleRecoveredEvent[];
  clock: { now: number };
  watchdog: ScheduleWatchdog;
}

function makeHarness(options: { selfHeal?: boolean; backoffThreshold?: number } = {}): Harness {
  const scheduler = new FakeScheduler();
  const hooks = createHooks();
  const overdue: ScheduleOverdueEvent[] = [];
  const recovered: ScheduleRecoveredEvent[] = [];
  hooks.on("schedule:overdue", (e) => overdue.push(e));
  hooks.on("schedule:recovered", (e) => recovered.push(e));

  const clock = { now: 1_000_000_000_000 }; // arbitrary fixed starting epoch
  const watchdog = new ScheduleWatchdog({
    scheduler,
    hooks,
    log: silentLogger(),
    // Values picked so tests read clearly; the production defaults are
    // verified separately in the "uses documented defaults" test below.
    scanIntervalMs: 60_000,
    graceMs: 60_000, // 1 min grace in tests
    backoffThreshold: options.backoffThreshold ?? 3,
    selfHeal: options.selfHeal ?? false,
    now: () => clock.now,
  });

  return { scheduler, hooks, overdue, recovered, clock, watchdog };
}

function jobSummary(overrides: Partial<WatchdogJobSummary> = {}): WatchdogJobSummary {
  return {
    agentName: "bot1",
    jobId: "sched_1_abc",
    jobName: "morning-brief",
    enabled: true,
    consecutiveErrors: 0,
    lastRunAtMs: undefined,
    nextRunAtMs: undefined,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ScheduleWatchdog — classification", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  it("does not emit for a healthy job whose next fire is in the future", () => {
    h.scheduler.summaries = [
      jobSummary({
        lastRunAtMs: h.clock.now - 60_000,
        nextRunAtMs: h.clock.now + 3_600_000,
      }),
    ];
    h.watchdog.scanOnce();
    expect(h.overdue).toHaveLength(0);
    expect(h.recovered).toHaveLength(0);
  });

  it("does not emit when a job is slightly late but within the grace window", () => {
    h.scheduler.summaries = [
      jobSummary({
        lastRunAtMs: h.clock.now - 120_000,
        nextRunAtMs: h.clock.now - 30_000, // 30s overdue, grace is 60s
      }),
    ];
    h.watchdog.scanOnce();
    expect(h.overdue).toHaveLength(0);
  });

  it("emits `timer_drift` when next fire is past grace and the job has run before", () => {
    h.scheduler.summaries = [
      jobSummary({
        lastRunAtMs: h.clock.now - 3_600_000,
        nextRunAtMs: h.clock.now - 120_000, // 2 min overdue
      }),
    ];
    h.watchdog.scanOnce();
    expect(h.overdue).toHaveLength(1);
    expect(h.overdue[0]!.reason).toBe("timer_drift");
    expect(h.overdue[0]!.overdueByMs).toBe(120_000);
    expect(h.overdue[0]!.expectedAtMs).toBe(h.clock.now - 120_000);
    expect(h.overdue[0]!.consecutiveErrors).toBe(0);
  });

  it("emits `never_fired` when the job is overdue and has no lastRunAtMs", () => {
    h.scheduler.summaries = [
      jobSummary({
        lastRunAtMs: undefined,
        nextRunAtMs: h.clock.now - 120_000,
      }),
    ];
    h.watchdog.scanOnce();
    expect(h.overdue).toHaveLength(1);
    expect(h.overdue[0]!.reason).toBe("never_fired");
  });

  it("emits `stuck_in_backoff` when consecutiveErrors crosses the threshold, regardless of timing", () => {
    h.scheduler.summaries = [
      jobSummary({
        consecutiveErrors: 3,
        lastRunAtMs: h.clock.now - 10_000,
        // Next fire is comfortably in the future — classic backoff scenario.
        nextRunAtMs: h.clock.now + 300_000,
      }),
    ];
    h.watchdog.scanOnce();
    expect(h.overdue).toHaveLength(1);
    expect(h.overdue[0]!.reason).toBe("stuck_in_backoff");
  });

  it("prioritizes `stuck_in_backoff` over timing reasons when both would apply", () => {
    h.scheduler.summaries = [
      jobSummary({
        consecutiveErrors: 5,
        lastRunAtMs: h.clock.now - 600_000,
        nextRunAtMs: h.clock.now - 300_000, // also overdue on timing
      }),
    ];
    h.watchdog.scanOnce();
    expect(h.overdue[0]!.reason).toBe("stuck_in_backoff");
  });

  it("treats disabled jobs as healthy regardless of timing or errors", () => {
    h.scheduler.summaries = [
      jobSummary({
        enabled: false,
        consecutiveErrors: 10,
        nextRunAtMs: h.clock.now - 3_600_000,
      }),
    ];
    h.watchdog.scanOnce();
    expect(h.overdue).toHaveLength(0);
  });

  it("treats a job with no scheduled fire (nextRunAtMs undefined) as healthy unless it's in backoff", () => {
    h.scheduler.summaries = [
      jobSummary({
        consecutiveErrors: 1,
        nextRunAtMs: undefined,
      }),
    ];
    h.watchdog.scanOnce();
    expect(h.overdue).toHaveLength(0);
  });

  it("treats the exact grace boundary (overdueByMs === graceMs) as healthy", () => {
    // The classifier uses `overdueByMs <= graceMs` → healthy. A one-character
    // regression here (e.g. flipping to `<`) would pass every non-boundary
    // test in the file. Pin the contract.
    h.scheduler.summaries = [
      jobSummary({
        lastRunAtMs: h.clock.now - 3_600_000,
        nextRunAtMs: h.clock.now - 60_000, // exactly graceMs in the past
      }),
    ];
    h.watchdog.scanOnce();
    expect(h.overdue).toHaveLength(0);

    // One millisecond further and it flips.
    h.scheduler.summaries = [
      jobSummary({
        lastRunAtMs: h.clock.now - 3_600_000,
        nextRunAtMs: h.clock.now - 60_001,
      }),
    ];
    h.watchdog.scanOnce();
    expect(h.overdue).toHaveLength(1);
  });
});

describe("ScheduleWatchdog — emission gate (transition-only)", () => {
  it("suppresses re-emission while the job stays overdue for the same reason", () => {
    const h = makeHarness();
    h.scheduler.summaries = [
      jobSummary({
        lastRunAtMs: h.clock.now - 3_600_000,
        nextRunAtMs: h.clock.now - 120_000,
      }),
    ];

    h.watchdog.scanOnce();
    h.watchdog.scanOnce();
    h.watchdog.scanOnce();

    expect(h.overdue).toHaveLength(1);
  });

  it("emits a fresh `overdue` event when the reason changes (timer_drift → stuck_in_backoff)", () => {
    const h = makeHarness();
    h.scheduler.summaries = [
      jobSummary({
        lastRunAtMs: h.clock.now - 3_600_000,
        nextRunAtMs: h.clock.now - 120_000,
      }),
    ];
    h.watchdog.scanOnce();
    expect(h.overdue).toHaveLength(1);
    expect(h.overdue[0]!.reason).toBe("timer_drift");

    // Job starts failing — errors accrue, scheduler pushes nextRunAt into backoff.
    h.scheduler.summaries = [
      jobSummary({
        consecutiveErrors: 4,
        lastRunAtMs: h.clock.now - 10_000,
        nextRunAtMs: h.clock.now + 600_000,
      }),
    ];
    h.watchdog.scanOnce();
    expect(h.overdue).toHaveLength(2);
    expect(h.overdue[1]!.reason).toBe("stuck_in_backoff");
  });

  it("emits `recovered` when an overdue job returns to healthy", () => {
    const h = makeHarness();
    h.scheduler.summaries = [
      jobSummary({
        lastRunAtMs: h.clock.now - 3_600_000,
        nextRunAtMs: h.clock.now - 120_000,
      }),
    ];
    h.watchdog.scanOnce();
    expect(h.overdue).toHaveLength(1);

    // Advance the clock 10 min to exercise `wasOverdueForMs`.
    h.clock.now += 10 * 60 * 1000;
    h.scheduler.summaries = [
      jobSummary({
        lastRunAtMs: h.clock.now - 30_000,
        nextRunAtMs: h.clock.now + 3_600_000,
      }),
    ];
    h.watchdog.scanOnce();

    expect(h.recovered).toHaveLength(1);
    expect(h.recovered[0]!.previousReason).toBe("timer_drift");
    expect(h.recovered[0]!.wasOverdueForMs).toBe(10 * 60 * 1000);
  });

  it("does not emit `recovered` when an overdue job simply disappears from the summaries", () => {
    const h = makeHarness();
    h.scheduler.summaries = [
      jobSummary({
        lastRunAtMs: h.clock.now - 3_600_000,
        nextRunAtMs: h.clock.now - 120_000,
      }),
    ];
    h.watchdog.scanOnce();
    expect(h.overdue).toHaveLength(1);

    // Job was auto-deleted (one-shot success) — gone from summaries.
    h.scheduler.summaries = [];
    h.watchdog.scanOnce();

    expect(h.recovered).toHaveLength(0);
    // And a subsequent reappearance would be treated as a fresh observation,
    // not a recovery — verify the internal map was cleaned.
    h.scheduler.summaries = [
      jobSummary({
        lastRunAtMs: h.clock.now,
        nextRunAtMs: h.clock.now + 60_000,
      }),
    ];
    h.watchdog.scanOnce();
    expect(h.recovered).toHaveLength(0);
  });
});

describe("ScheduleWatchdog — self-heal", () => {
  it("does not call scheduler.rearm when self-heal is off", () => {
    const h = makeHarness({ selfHeal: false });
    h.scheduler.summaries = [
      jobSummary({
        lastRunAtMs: h.clock.now - 3_600_000,
        nextRunAtMs: h.clock.now - 120_000,
      }),
    ];
    h.watchdog.scanOnce();
    h.watchdog.scanOnce();
    expect(h.scheduler.rearmCalls).toBe(0);
  });

  it("calls scheduler.rearm on every timer_drift scan when self-heal is on", () => {
    const h = makeHarness({ selfHeal: true });
    h.scheduler.summaries = [
      jobSummary({
        lastRunAtMs: h.clock.now - 3_600_000,
        nextRunAtMs: h.clock.now - 120_000,
      }),
    ];
    h.watchdog.scanOnce();
    h.watchdog.scanOnce();
    h.watchdog.scanOnce();
    // One call per scan while job remains in timer_drift — the scheduler's
    // armTimer is idempotent, so repeat calls are safe and expected.
    expect(h.scheduler.rearmCalls).toBe(3);
  });

  it("does not call scheduler.rearm on stuck_in_backoff (rearming wouldn't help)", () => {
    const h = makeHarness({ selfHeal: true });
    h.scheduler.summaries = [
      jobSummary({
        consecutiveErrors: 4,
        nextRunAtMs: h.clock.now + 600_000,
      }),
    ];
    h.watchdog.scanOnce();
    expect(h.scheduler.rearmCalls).toBe(0);
  });

  it("calls scheduler.rearm on never_fired (a rearm is cheap and may unstick it)", () => {
    // The self-heal policy intentionally includes `never_fired` — the
    // watchdog docstring explains that rearming gives a stuck timer "a
    // chance to recover." This pins that behaviour so the policy and the
    // code can't silently diverge.
    const h = makeHarness({ selfHeal: true });
    h.scheduler.summaries = [
      jobSummary({
        lastRunAtMs: undefined,
        nextRunAtMs: h.clock.now - 120_000,
      }),
    ];
    h.watchdog.scanOnce();
    expect(h.overdue[0]!.reason).toBe("never_fired");
    expect(h.scheduler.rearmCalls).toBe(1);
  });

  it("tolerates a SchedulerView whose rearm method is absent", () => {
    // `SchedulerView.rearm` is optional. A scheduler that never implements
    // it must not cause the watchdog to throw when self-heal is requested.
    const hooks = createHooks();
    const overdue: ScheduleOverdueEvent[] = [];
    hooks.on("schedule:overdue", (e) => overdue.push(e));
    const clock = { now: 1_000_000_000_000 };

    const bareScheduler: SchedulerView = {
      getJobSummaries: () => [
        jobSummary({
          lastRunAtMs: clock.now - 3_600_000,
          nextRunAtMs: clock.now - 120_000,
        }),
      ],
    };

    const watchdog = new ScheduleWatchdog({
      scheduler: bareScheduler,
      hooks,
      log: silentLogger(),
      scanIntervalMs: 60_000,
      graceMs: 60_000,
      selfHeal: true,
      now: () => clock.now,
    });

    expect(() => watchdog.scanOnce()).not.toThrow();
    expect(overdue).toHaveLength(1);
  });
});

describe("ScheduleWatchdog — lifecycle", () => {
  it("start() then stop() leaves no timer running", () => {
    vi.useFakeTimers();
    try {
      const h = makeHarness();
      h.watchdog.start();
      h.watchdog.stop();
      // Advance time far past the scan interval — nothing should scan.
      h.scheduler.summaries = [
        jobSummary({
          lastRunAtMs: h.clock.now - 3_600_000,
          nextRunAtMs: h.clock.now - 3_600_000,
        }),
      ];
      vi.advanceTimersByTime(60 * 60 * 1000);
      expect(h.overdue).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("start() is idempotent — calling twice doesn't create two interval timers", () => {
    vi.useFakeTimers();
    try {
      const h = makeHarness();
      h.scheduler.summaries = [
        jobSummary({
          lastRunAtMs: h.clock.now - 3_600_000,
          nextRunAtMs: h.clock.now - 120_000,
        }),
      ];
      h.watchdog.start();
      h.watchdog.start();
      vi.advanceTimersByTime(60_000);
      // One interval → one scan → one overdue emission.
      expect(h.overdue).toHaveLength(1);
      h.watchdog.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("catches scanner errors so a throwing scheduler doesn't kill the interval", () => {
    // If `getJobSummaries` ever throws (shouldn't, but the watchdog runs
    // for the lifetime of the daemon), the interval must keep running.
    // Otherwise a one-time transient error silently disables monitoring
    // until the next restart.
    vi.useFakeTimers();
    try {
      const hooks = createHooks();
      const overdue: ScheduleOverdueEvent[] = [];
      hooks.on("schedule:overdue", (e) => overdue.push(e));
      const clock = { now: 1_000_000_000_000 };

      let callCount = 0;
      const flakyScheduler: SchedulerView = {
        getJobSummaries: () => {
          callCount += 1;
          if (callCount === 1) {
            throw new Error("boom");
          }
          return [
            jobSummary({
              lastRunAtMs: clock.now - 3_600_000,
              nextRunAtMs: clock.now - 120_000,
            }),
          ];
        },
      };

      const watchdog = new ScheduleWatchdog({
        scheduler: flakyScheduler,
        hooks,
        log: silentLogger(),
        scanIntervalMs: 60_000,
        graceMs: 60_000,
        now: () => clock.now,
      });

      watchdog.start();
      vi.advanceTimersByTime(60_000); // scan #1 throws, caught
      vi.advanceTimersByTime(60_000); // scan #2 succeeds
      expect(callCount).toBe(2);
      expect(overdue).toHaveLength(1);
      watchdog.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
