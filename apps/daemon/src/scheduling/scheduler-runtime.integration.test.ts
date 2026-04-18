/**
 * End-to-end-ish test of the Scheduler merging runtime schedules from the
 * store with declarative ones from agent configs. Uses stubs for the
 * AgentManager / CronRunner / ChannelRegistry so the test runs synchronously
 * without spawning real processes.
 *
 * The focus is behaviour the service unit test can't prove: that the
 * Scheduler picks up runtime jobs on start, fires them at the right time,
 * auto-deletes `deleteAfterRun` one-shots from the ScheduleStore, and
 * respects the enabled flag.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Scheduler } from "./scheduler.js";
import { ScheduleStore } from "./schedule-store.js";
import { RondelHooks } from "../shared/hooks.js";
import type { CronJob } from "../shared/types/index.js";

const silentLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => silentLog,
} as const;

class StubCronRunner {
  readonly runs: string[] = [];
  runIsolated(_agent: string, job: CronJob) {
    this.runs.push(job.id);
    return Promise.resolve({ state: "completed" as const, result: "ok", costUsd: 0 });
  }
  getOrSpawnNamedSession() {
    return null;
  }
}

class StubAgentManager {
  getAgentNames() {
    return ["bot1"];
  }
  getAgentDir() {
    return "/tmp/nonexistent";
  }
  getTemplate() {
    return { config: { agentName: "bot1", channels: [], crons: [] } };
  }
  getPrimaryChannel() {
    return { channelType: "telegram", accountId: "bot1" };
  }
}

class StubChannelRegistry {
  readonly sends: Array<{ chatId: string; text: string }> = [];
  async sendText(_channelType: string, _accountId: string, chatId: string, text: string) {
    this.sends.push({ chatId, text });
  }
}

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "sched-rt-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  while (dirs.length) {
    const d = dirs.pop()!;
    await rm(d, { recursive: true, force: true });
  }
});

async function makeScheduler(homeDir: string) {
  const store = new ScheduleStore(join(homeDir, "state", "schedules.json"), silentLog as never);
  await store.init();
  const cronRunner = new StubCronRunner();
  const channels = new StubChannelRegistry();
  const agentManager = new StubAgentManager();
  const hooks = new RondelHooks();
  const scheduler = new Scheduler(
    agentManager as never,
    cronRunner as never,
    channels as never,
    hooks,
    homeDir,
    store,
    silentLog as never,
  );
  return { scheduler, store, cronRunner, channels, hooks };
}

function oneShotJob(id: string, atMs: number): CronJob {
  return {
    id,
    name: "wake",
    schedule: { kind: "at", at: new Date(atMs).toISOString() },
    prompt: "go",
    sessionTarget: "isolated",
    source: "runtime",
    owner: "bot1",
    createdAtMs: Date.now(),
    deleteAfterRun: true,
    delivery: { mode: "none" },
  };
}

describe("Scheduler + ScheduleStore — runtime schedules", () => {
  it("loads runtime schedules from the store on start", async () => {
    const home = tmp();
    const { scheduler, store } = await makeScheduler(home);
    const job = oneShotJob("sched_1745000000_aa11aa11", Date.now() + 60_000);
    await store.add(job);
    await scheduler.start();
    try {
      const summaries = scheduler.getJobSummaries();
      expect(summaries.find((s) => s.jobId === job.id)?.source).toBe("runtime");
    } finally {
      await scheduler.stop();
    }
  });

  it("fires an overdue runtime one-shot on start and auto-deletes it", async () => {
    const home = tmp();
    const { scheduler, store, cronRunner, hooks } = await makeScheduler(home);
    const deletions: string[] = [];
    hooks.on("schedule:deleted", ({ job, reason }) => {
      deletions.push(`${job.id}:${reason}`);
    });
    const past = Date.now() - 10_000;
    const job = oneShotJob("sched_1745000000_bb22bb22", past);
    await store.add(job);
    await scheduler.start();

    // Wait long enough for the missed-job pass + autoDelete's async work.
    await new Promise((r) => setTimeout(r, 250));

    expect(cronRunner.runs).toContain(job.id);
    expect(store.getById(job.id)).toBeUndefined();
    expect(deletions).toContain(`${job.id}:ran_once`);
    await scheduler.stop();
  });

  it("upsertRuntimeJob adds a runtime job at runtime without restart", async () => {
    const home = tmp();
    const { scheduler, store } = await makeScheduler(home);
    await scheduler.start();
    try {
      const job = oneShotJob("sched_1745000000_cc33cc33", Date.now() + 3_600_000);
      // Real path: service.create persists + calls upsertRuntimeJob.
      await store.add(job);
      scheduler.upsertRuntimeJob(job);
      const summary = scheduler.getJobSummaries().find((s) => s.jobId === job.id);
      expect(summary).toBeDefined();
      expect(summary?.source).toBe("runtime");
      expect(summary?.nextRunAtMs).toBeGreaterThan(Date.now());
    } finally {
      await scheduler.stop();
    }
  });

  it("autoDelete does NOT emit schedule:deleted when the store entry is already gone", async () => {
    // Race simulation: the user-initiated rondel_schedule_delete wins,
    // then the post-run autoDelete path runs second. autoDelete should
    // observe `remove() === false` and stay silent — otherwise the
    // ledger gets two deleted events for one schedule.
    const home = tmp();
    const { scheduler, store, hooks } = await makeScheduler(home);
    const emissions: string[] = [];
    hooks.on("schedule:deleted", ({ job, reason }) => {
      emissions.push(`${job.id}:${reason}`);
    });
    const past = Date.now() - 10_000;
    const job = oneShotJob("sched_1745000000_ee55ee55", past);
    await store.add(job);
    // Simulate the user-delete winning the race by removing the store
    // entry BEFORE scheduler.start() fires the missed job.
    await store.remove(job.id);
    await scheduler.start();
    await new Promise((r) => setTimeout(r, 250));
    // No emissions — the schedule was already removed before autoDelete ran.
    expect(emissions).not.toContain(`${job.id}:ran_once`);
    await scheduler.stop();
  });

  it("emits schedule:ran with fresh post-run state for runtime jobs", async () => {
    // The UI's live tail relies on this: lastStatus / lastRunAtMs / the
    // next recomputed nextRunAtMs should all be present in the hook
    // payload so the web reducer can upsert without a refetch. Declarative
    // jobs are covered by `cron:completed`/`cron:failed` and must NOT
    // produce this event (kept silent to match the UI surface).
    const home = tmp();
    const { scheduler, store, hooks } = await makeScheduler(home);
    const runs: Array<{ id: string; lastStatus?: string; lastRunAtMs?: number }> = [];
    hooks.on("schedule:ran", ({ job, state }) => {
      runs.push({ id: job.id, lastStatus: state.lastStatus, lastRunAtMs: state.lastRunAtMs });
    });
    const past = Date.now() - 10_000;
    const job = oneShotJob("sched_1745000000_ff66ff66", past);
    await store.add(job);
    await scheduler.start();
    await new Promise((r) => setTimeout(r, 250));

    expect(runs).toHaveLength(1);
    expect(runs[0].id).toBe(job.id);
    expect(runs[0].lastStatus).toBe("ok");
    expect(runs[0].lastRunAtMs).toBeGreaterThan(0);

    await scheduler.stop();
  });

  it("removeRuntimeJob drops the job from the active set", async () => {
    const home = tmp();
    const { scheduler, store } = await makeScheduler(home);
    const job = oneShotJob("sched_1745000000_dd44dd44", Date.now() + 3_600_000);
    await store.add(job);
    await scheduler.start();
    try {
      expect(scheduler.getJobSummaries().find((s) => s.jobId === job.id)).toBeDefined();
      scheduler.removeRuntimeJob(job.id);
      expect(scheduler.getJobSummaries().find((s) => s.jobId === job.id)).toBeUndefined();
    } finally {
      await scheduler.stop();
    }
  });
});
