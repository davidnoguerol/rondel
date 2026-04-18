/**
 * Scheduler behaviour beyond the basic happy path.
 *
 * Scope:
 *   1. Backoff math after a failed run — is `nextRunAtMs` pushed into the
 *      future correctly for every schedule kind? The existing
 *      scheduler-runtime.integration.test.ts only covers `at` one-shots
 *      with a successful runner. A regression here would manifest as a
 *      failing schedule hammering the runner in a tight loop instead
 *      of backing off.
 *   2. Declarative + runtime coexistence: when the scheduler starts
 *      with both a declarative job (from agent.json) and a runtime job
 *      (from the store), both must show up in the job summary.
 *   3. Delivery fallback: when `announce` delivery omits channelType
 *      and accountId, the scheduler falls back to the agent's primary
 *      channel binding. Covered indirectly by runtime tests today
 *      (they use `delivery: { mode: "none" }`). This test pins it
 *      directly.
 *
 * Uses the same stub pattern as scheduler-runtime.integration.test.ts —
 * no real Claude CLI processes.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Scheduler } from "./scheduler.js";
import { ScheduleStore } from "./schedule-store.js";
import { RondelHooks } from "../shared/hooks.js";
import type { CronJob, SubagentState } from "../shared/types/index.js";

const silentLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => silentLog,
} as const;

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

class FailingCronRunner {
  readonly runs: string[] = [];
  /** Simulate an error outcome — drives the backoff path in executeJob. */
  runIsolated(_agent: string, job: CronJob): Promise<{
    state: SubagentState;
    result?: string;
    error?: string;
    costUsd?: number;
  }> {
    this.runs.push(job.id);
    return Promise.resolve({ state: "failed" as const, error: "boom" });
  }
  getOrSpawnNamedSession(): null {
    return null;
  }
}

class OkCronRunner {
  readonly runs: string[] = [];
  runIsolated(_agent: string, job: CronJob) {
    this.runs.push(job.id);
    return Promise.resolve({ state: "completed" as const, result: "ok", costUsd: 0 });
  }
  getOrSpawnNamedSession(): null {
    return null;
  }
}

class StubAgentManager {
  constructor(
    private readonly declarativeCrons: readonly CronJob[] = [],
    private readonly primaryChannel: { channelType: string; accountId: string } | null = {
      channelType: "telegram",
      accountId: "bot1",
    },
  ) {}
  getAgentNames(): string[] {
    return ["bot1"];
  }
  getAgentDir(): string {
    return "/tmp/nonexistent";
  }
  getTemplate() {
    return {
      config: { agentName: "bot1", channels: [], crons: this.declarativeCrons },
    };
  }
  getPrimaryChannel() {
    return this.primaryChannel;
  }
}

class RecordingChannelRegistry {
  readonly sends: Array<{
    channelType: string;
    accountId: string;
    chatId: string;
    text: string;
  }> = [];
  async sendText(
    channelType: string,
    accountId: string,
    chatId: string,
    text: string,
  ): Promise<void> {
    this.sends.push({ channelType, accountId, chatId, text });
  }
}

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "sched-beh-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  while (dirs.length) {
    const d = dirs.pop()!;
    await rm(d, { recursive: true, force: true });
  }
});

async function makeScheduler(opts: {
  home: string;
  declarativeCrons?: readonly CronJob[];
  failing?: boolean;
  primaryChannel?: { channelType: string; accountId: string } | null;
}) {
  const store = new ScheduleStore(
    join(opts.home, "state", "schedules.json"),
    silentLog as never,
  );
  await store.init();
  const cronRunner = opts.failing ? new FailingCronRunner() : new OkCronRunner();
  const channels = new RecordingChannelRegistry();
  const agentManager = new StubAgentManager(
    opts.declarativeCrons ?? [],
    opts.primaryChannel === undefined
      ? { channelType: "telegram", accountId: "bot1" }
      : opts.primaryChannel,
  );
  const hooks = new RondelHooks();
  const scheduler = new Scheduler(
    agentManager as never,
    cronRunner as never,
    channels as never,
    hooks,
    opts.home,
    store,
    silentLog as never,
  );
  return { scheduler, store, cronRunner, channels, hooks };
}

function overdueJob(partial: Partial<CronJob> & { id: string; schedule: CronJob["schedule"] }): CronJob {
  return {
    name: "t",
    prompt: "go",
    sessionTarget: "isolated",
    source: "runtime",
    owner: "bot1",
    createdAtMs: Date.now(),
    delivery: { mode: "none" },
    deleteAfterRun: false, // don't auto-delete so backoff can push nextRun forward
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// 1. Backoff math across schedule kinds
// ---------------------------------------------------------------------------

describe("Scheduler — backoff after failure, per schedule kind", () => {
  it.each([
    [
      "every",
      (id: string) =>
        overdueJob({
          id,
          schedule: { kind: "every" as const, interval: "1h" },
        }),
    ],
    [
      "cron",
      (id: string) =>
        overdueJob({
          id,
          schedule: { kind: "cron" as const, expression: "*/5 * * * *" },
        }),
    ],
  ] as const)(
    "pushes nextRunAtMs into the future after a failure (kind=%s)",
    async (_label, makeJob) => {
      const home = tmp();
      const { scheduler, store, cronRunner, hooks } = await makeScheduler({
        home,
        failing: true,
      });
      const failed: string[] = [];
      hooks.on("cron:failed", ({ job }) => failed.push(job.id));

      // Job is already overdue — the scheduler runs it immediately on start
      // (missed-job catch-up path).
      const job = makeJob("sched_1700000000_ff11ff11");
      // Seed nextRunAt in the past so it's picked up as a missed job.
      // (start() calls initialFireAtMs for jobs without persisted state —
      // for recurring schedules that returns a future time, so we need to
      // insert via the store and then override nextRunAtMs after start via
      // the existing upsert machinery isn't possible. Instead we trigger
      // a run by calling triggerNow after start.)
      await store.add(job);
      await scheduler.start();
      try {
        const before = Date.now();
        const triggered = await scheduler.triggerNow(job.id);
        expect(triggered).toBe(true);

        // Wait long enough for the timer to fire and executeJob to complete.
        await new Promise((r) => setTimeout(r, 150));

        expect((cronRunner as FailingCronRunner).runs).toContain(job.id);
        expect(failed).toContain(job.id);

        const snapshot = scheduler.getJobStateSnapshot(job.id);
        expect(snapshot?.consecutiveErrors).toBeGreaterThan(0);
        // Backoff >= 30s for the first failure — nextRunAtMs must be well
        // past "now", not left at the firing time or at null.
        expect(snapshot?.nextRunAtMs).toBeDefined();
        expect(snapshot!.nextRunAtMs!).toBeGreaterThan(before + 20_000);
      } finally {
        await scheduler.stop();
      }
    },
  );
});

// ---------------------------------------------------------------------------
// 2. Declarative + runtime coexistence at startup
// ---------------------------------------------------------------------------

describe("Scheduler — declarative + runtime coexistence", () => {
  it("loads declarative crons from agent.json alongside runtime schedules from the store", async () => {
    const home = tmp();
    // A declarative job — lives in agent.json via the StubAgentManager.
    const declarative: CronJob = {
      id: "decl-daily",
      name: "Daily",
      schedule: { kind: "every", interval: "24h" },
      prompt: "d",
      enabled: true,
    };
    const { scheduler, store } = await makeScheduler({
      home,
      declarativeCrons: [declarative],
    });

    // A runtime job — lives in the store.
    const runtime: CronJob = overdueJob({
      id: "sched_1700000000_11aa22bb",
      schedule: { kind: "every", interval: "1h" },
    });
    await store.add(runtime);

    await scheduler.start();
    try {
      const summaries = scheduler.getJobSummaries();
      const byId = new Map(summaries.map((s) => [s.jobId, s]));
      // Both jobs must appear, each correctly tagged.
      expect(byId.get("decl-daily")?.source).toBe("declarative");
      expect(byId.get("sched_1700000000_11aa22bb")?.source).toBe("runtime");
    } finally {
      await scheduler.stop();
    }
  });

  it("start() seeds nextRunAtMs for runtime one-shots with past `at` timestamps", async () => {
    // Catch-up invariant: a runtime job whose `at` was missed during
    // downtime must fire on restart. The scheduler-runtime test proves
    // autodelete; this one pins the "no state persisted yet" path that
    // uses `initialFireAtMs` rather than `nextRunAtMs`.
    const home = tmp();
    const { scheduler, store, cronRunner } = await makeScheduler({ home });
    const past = Date.now() - 60_000;
    const job: CronJob = overdueJob({
      id: "sched_1700000000_22bb33cc",
      schedule: { kind: "at", at: new Date(past).toISOString() },
      deleteAfterRun: true,
    });
    await store.add(job);

    await scheduler.start();
    try {
      await new Promise((r) => setTimeout(r, 250));
      expect((cronRunner as OkCronRunner).runs).toContain(job.id);
    } finally {
      await scheduler.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Delivery fallback to primary channel binding
// ---------------------------------------------------------------------------

describe("Scheduler — delivery fallback", () => {
  it("uses the agent's primary channel when announce omits channelType/accountId", async () => {
    const home = tmp();
    const { scheduler, store, channels } = await makeScheduler({
      home,
      primaryChannel: { channelType: "telegram", accountId: "primary-bot" },
    });

    // chatId only — channelType and accountId must come from the agent's
    // primary channel binding. This is the code path for declarative crons
    // authored before the schema was extended.
    const job: CronJob = overdueJob({
      id: "sched_1700000000_33cc44dd",
      schedule: { kind: "at", at: new Date(Date.now() - 10_000).toISOString() },
      delivery: { mode: "announce", chatId: "chat-777" },
      deleteAfterRun: true,
    });
    await store.add(job);
    await scheduler.start();
    try {
      await new Promise((r) => setTimeout(r, 250));
      expect(channels.sends).toHaveLength(1);
      expect(channels.sends[0]).toMatchObject({
        channelType: "telegram",
        accountId: "primary-bot",
        chatId: "chat-777",
      });
    } finally {
      await scheduler.stop();
    }
  });

  it("prefers explicit channelType/accountId on the delivery spec when present", async () => {
    const home = tmp();
    const { scheduler, store, channels } = await makeScheduler({
      home,
      primaryChannel: { channelType: "telegram", accountId: "primary-bot" },
    });

    const job: CronJob = overdueJob({
      id: "sched_1700000000_44dd55ee",
      schedule: { kind: "at", at: new Date(Date.now() - 10_000).toISOString() },
      delivery: {
        mode: "announce",
        chatId: "chat-999",
        channelType: "web",
        accountId: "explicit-account",
      },
      deleteAfterRun: true,
    });
    await store.add(job);
    await scheduler.start();
    try {
      await new Promise((r) => setTimeout(r, 250));
      expect(channels.sends).toHaveLength(1);
      expect(channels.sends[0]).toMatchObject({
        channelType: "web",
        accountId: "explicit-account",
        chatId: "chat-999",
      });
    } finally {
      await scheduler.stop();
    }
  });

  it("drops the announce silently when no channel binding is available at all", async () => {
    // Agent with no primary channel + partial delivery spec = no send.
    // The scheduler logs a warning and moves on; a failing send must not
    // fail the run or clobber cron state.
    const home = tmp();
    const { scheduler, store, channels } = await makeScheduler({
      home,
      primaryChannel: null,
    });

    const job: CronJob = overdueJob({
      id: "sched_1700000000_55ee66ff",
      schedule: { kind: "at", at: new Date(Date.now() - 10_000).toISOString() },
      delivery: { mode: "announce", chatId: "chat-doesnt-matter" },
      deleteAfterRun: true,
    });
    await store.add(job);
    await scheduler.start();
    try {
      await new Promise((r) => setTimeout(r, 250));
      expect(channels.sends).toHaveLength(0);
    } finally {
      await scheduler.stop();
    }
  });
});
