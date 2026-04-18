import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScheduleService, type ScheduleCaller, type SchedulerControl } from "./schedule-service.js";
import { ScheduleStore } from "./schedule-store.js";
import { RondelHooks } from "../shared/hooks.js";
import type { CronJob } from "../shared/types/index.js";
import type { OrgResolution } from "../shared/org-isolation.js";

const silentLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => silentLog,
} as const;

class StubScheduler implements SchedulerControl {
  readonly upserts: CronJob[] = [];
  readonly upsertOptions: Array<{ rearmTiming?: boolean } | undefined> = [];
  readonly removes: string[] = [];
  readonly triggered: string[] = [];
  triggerNowResult = true;

  get lastUpsertArgs(): [CronJob, { rearmTiming?: boolean } | undefined] | undefined {
    const n = this.upserts.length;
    if (n === 0) return undefined;
    return [this.upserts[n - 1]!, this.upsertOptions[n - 1]];
  }

  upsertRuntimeJob(job: CronJob, options?: { rearmTiming?: boolean }): void {
    this.upserts.push(job);
    this.upsertOptions.push(options);
  }
  removeRuntimeJob(id: string): void {
    this.removes.push(id);
  }
  async triggerNow(id: string): Promise<boolean> {
    this.triggered.push(id);
    return this.triggerNowResult;
  }
  getJobStateSnapshot(): undefined {
    return undefined;
  }
}

// Reasonable test fixture: global "bot1", same-org "org-a/alice" + "org-a/alpha",
// and a cross-org "org-b/bob".
const orgMap: Record<string, OrgResolution> = {
  bot1: { status: "global" },
  alice: { status: "org", orgName: "org-a" },
  alpha: { status: "org", orgName: "org-a" },
  bob: { status: "org", orgName: "org-b" },
};
const orgLookup = (name: string) => orgMap[name] ?? { status: "unknown" };
const isKnown = (name: string) => orgMap[name] !== undefined;

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "sched-svc-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  while (dirs.length) {
    const d = dirs.pop()!;
    await rm(d, { recursive: true, force: true });
  }
});

async function makeService(): Promise<{
  service: ScheduleService;
  store: ScheduleStore;
  scheduler: StubScheduler;
  hooks: RondelHooks;
}> {
  const dir = tmp();
  const store = new ScheduleStore(join(dir, "schedules.json"), silentLog as never);
  await store.init();
  const scheduler = new StubScheduler();
  const hooks = new RondelHooks();
  const service = new ScheduleService({
    store,
    scheduler,
    hooks,
    log: silentLog as never,
    orgLookup,
    isKnownAgent: isKnown,
  });
  return { service, store, scheduler, hooks };
}

const selfCaller = (agent = "bot1", overrides: Partial<ScheduleCaller> = {}): ScheduleCaller => ({
  agentName: agent,
  isAdmin: false,
  channelType: "telegram",
  accountId: agent,
  chatId: "123456",
  ...overrides,
});

describe("ScheduleService — create", () => {
  it("generates a sched_ id and persists the job", async () => {
    const { service, store, scheduler } = await makeService();
    const summary = await service.create(selfCaller(), {
      name: "Wake-up",
      schedule: { kind: "at", at: "5m" },
      prompt: "say hi",
    });
    expect(summary.id).toMatch(/^sched_\d+_[a-f0-9]+$/);
    expect(store.getById(summary.id)).toBeDefined();
    expect(scheduler.upserts).toHaveLength(1);
  });

  it("defaults delivery to the caller's current conversation when omitted", async () => {
    const { service } = await makeService();
    const summary = await service.create(selfCaller(), {
      name: "Ping",
      schedule: { kind: "every", interval: "30m" },
      prompt: "ping",
    });
    expect(summary.delivery).toEqual({
      mode: "announce",
      chatId: "123456",
      channelType: "telegram",
      accountId: "bot1",
    });
  });

  it("respects an explicit delivery", async () => {
    const { service } = await makeService();
    const summary = await service.create(selfCaller(), {
      name: "No-ann",
      schedule: { kind: "every", interval: "30m" },
      prompt: "silent",
      delivery: { mode: "none" },
    });
    expect(summary.delivery).toEqual({ mode: "none" });
  });

  it("sets deleteAfterRun=true by default for one-shot `at` schedules", async () => {
    const { service } = await makeService();
    const summary = await service.create(selfCaller(), {
      name: "once",
      schedule: { kind: "at", at: "1h" },
      prompt: "once",
    });
    expect(summary.deleteAfterRun).toBe(true);
  });

  it("leaves deleteAfterRun undefined for recurring schedules by default", async () => {
    const { service } = await makeService();
    const summary = await service.create(selfCaller(), {
      name: "rec",
      schedule: { kind: "every", interval: "1h" },
      prompt: "rec",
    });
    expect(summary.deleteAfterRun).toBe(false);
  });

  it("emits schedule:created", async () => {
    const { service, hooks } = await makeService();
    let received: CronJob | undefined;
    hooks.on("schedule:created", ({ job }) => {
      received = job;
    });
    const summary = await service.create(selfCaller(), {
      name: "hi",
      schedule: { kind: "every", interval: "1h" },
      prompt: "x",
    });
    expect(received?.id).toBe(summary.id);
  });

  it("rejects malformed cron expressions at creation time", async () => {
    const { service } = await makeService();
    await expect(
      service.create(selfCaller(), {
        name: "bad",
        schedule: { kind: "cron", expression: "not a cron" },
        prompt: "x",
      }),
    ).rejects.toThrow();
  });
});

describe("ScheduleService — permissions", () => {
  it("forbids non-admin callers from targeting other agents", async () => {
    const { service } = await makeService();
    await expect(
      service.create(selfCaller("bot1"), {
        name: "evil",
        schedule: { kind: "every", interval: "1h" },
        prompt: "x",
        targetAgent: "alice",
      }),
    ).rejects.toThrow(/Only admin agents/);
  });

  it("allows admin callers to target other agents (same-org rule still applies)", async () => {
    const { service } = await makeService();
    // Admin global → same-org agent: allowed (global is unrestricted)
    const ok = await service.create(
      { agentName: "bot1", isAdmin: true, chatId: "c" },
      {
        name: "on-behalf",
        schedule: { kind: "every", interval: "1h" },
        prompt: "x",
        targetAgent: "alice",
      },
    );
    expect(ok.owner).toBe("alice");

    // Admin in org-a → agent in org-b: blocked by cross-org rule
    await expect(
      service.create(
        { agentName: "alice", isAdmin: true, chatId: "c" },
        {
          name: "cross",
          schedule: { kind: "every", interval: "1h" },
          prompt: "x",
          targetAgent: "bob",
        },
      ),
    ).rejects.toThrow(/Cross-org/);
  });

  it("non-admin can delete their own schedule but not someone else's", async () => {
    const { service } = await makeService();
    const mine = await service.create(selfCaller("alice"), {
      name: "mine",
      schedule: { kind: "every", interval: "1h" },
      prompt: "x",
    });
    // Own: allowed
    await service.remove(selfCaller("alice"), mine.id);

    // Someone else's: forbidden
    const theirs = await service.create(
      { agentName: "bot1", isAdmin: true, chatId: "x" },
      {
        name: "theirs",
        schedule: { kind: "every", interval: "1h" },
        prompt: "x",
        targetAgent: "alice",
      },
    );
    await expect(service.remove(selfCaller("bob"), theirs.id)).rejects.toThrow();
  });

  it("rejects creation targeting an unknown agent", async () => {
    const { service } = await makeService();
    await expect(
      service.create(
        { agentName: "bot1", isAdmin: true, chatId: "x" },
        {
          name: "ghost",
          schedule: { kind: "every", interval: "1h" },
          prompt: "x",
          targetAgent: "ghost",
        },
      ),
    ).rejects.toThrow(/Unknown agent/);
  });
});

describe("ScheduleService — update semantics", () => {
  it("keeps next-run timing when only the prompt changes", async () => {
    const { service, scheduler } = await makeService();
    const created = await service.create(selfCaller(), {
      name: "p",
      schedule: { kind: "every", interval: "1h" },
      prompt: "first",
    });
    scheduler.upserts.length = 0;
    scheduler.upsertOptions.length = 0;
    await service.update(selfCaller(), created.id, { prompt: "second" });
    expect(scheduler.upserts).toHaveLength(1);
    const [, opts] = scheduler.lastUpsertArgs!;
    expect(opts?.rearmTiming).toBe(false);
  });

  it("rearms timing when the schedule changes", async () => {
    const { service, scheduler } = await makeService();
    const created = await service.create(selfCaller(), {
      name: "p",
      schedule: { kind: "every", interval: "1h" },
      prompt: "p",
    });
    scheduler.upserts.length = 0;
    scheduler.upsertOptions.length = 0;
    await service.update(selfCaller(), created.id, {
      schedule: { kind: "every", interval: "30m" },
    });
    const [, opts] = scheduler.lastUpsertArgs!;
    expect(opts?.rearmTiming).toBe(true);
  });

  it("rearms timing when enabled flips", async () => {
    const { service, scheduler } = await makeService();
    const created = await service.create(selfCaller(), {
      name: "p",
      schedule: { kind: "every", interval: "1h" },
      prompt: "p",
    });
    scheduler.upserts.length = 0;
    scheduler.upsertOptions.length = 0;
    await service.update(selfCaller(), created.id, { enabled: false });
    const [, opts] = scheduler.lastUpsertArgs!;
    expect(opts?.rearmTiming).toBe(true);
  });

  it("clears the model override when patch.model is explicit null", async () => {
    const { service } = await makeService();
    const created = await service.create(selfCaller(), {
      name: "p",
      schedule: { kind: "every", interval: "1h" },
      prompt: "p",
      model: "opus-4.7",
    });
    const updated = await service.update(selfCaller(), created.id, { model: null });
    expect(updated.model).toBeUndefined();
  });

  it("leaves the model override alone when patch.model is omitted", async () => {
    const { service } = await makeService();
    const created = await service.create(selfCaller(), {
      name: "p",
      schedule: { kind: "every", interval: "1h" },
      prompt: "p",
      model: "opus-4.7",
    });
    const updated = await service.update(selfCaller(), created.id, { name: "renamed" });
    expect(updated.model).toBe("opus-4.7");
  });
});

describe("ScheduleService — update / remove / runNow", () => {
  let svc: ScheduleService;
  let scheduler: StubScheduler;
  let hooks: RondelHooks;
  let existingId: string;

  beforeEach(async () => {
    const made = await makeService();
    svc = made.service;
    scheduler = made.scheduler;
    hooks = made.hooks;
    const created = await svc.create(selfCaller(), {
      name: "p",
      schedule: { kind: "every", interval: "1h" },
      prompt: "p",
    });
    existingId = created.id;
    scheduler.upserts.length = 0;
    scheduler.upsertOptions.length = 0;
  });

  it("update revalidates the new schedule and pushes to the scheduler", async () => {
    const updated = await svc.update(selfCaller(), existingId, {
      schedule: { kind: "cron", expression: "0 8 * * *" },
      name: "morning",
    });
    expect(updated.schedule).toEqual({ kind: "cron", expression: "0 8 * * *" });
    expect(updated.name).toBe("morning");
    expect(scheduler.upserts).toHaveLength(1);
    expect(scheduler.upserts[0]!.id).toBe(existingId);
  });

  it("update rejects invalid cron expressions", async () => {
    await expect(
      svc.update(selfCaller(), existingId, {
        schedule: { kind: "cron", expression: "bogus" },
      }),
    ).rejects.toThrow();
  });

  it("remove emits schedule:deleted with reason='requested'", async () => {
    let reason: string | undefined;
    hooks.on("schedule:deleted", (e) => {
      reason = e.reason;
    });
    await svc.remove(selfCaller(), existingId);
    expect(reason).toBe("requested");
    expect(scheduler.removes).toContain(existingId);
  });

  it("runNow asks the scheduler to fire the job", async () => {
    await svc.runNow(selfCaller(), existingId);
    expect(scheduler.triggered).toContain(existingId);
  });

  it("runNow fails loudly when the store knows a schedule the scheduler doesn't", async () => {
    scheduler.triggerNowResult = false;
    await expect(svc.runNow(selfCaller(), existingId)).rejects.toThrow(/state drift/);
  });
});

describe("ScheduleService — purgeForAgent", () => {
  it("removes all schedules owned by an agent and informs the scheduler", async () => {
    const { service, scheduler } = await makeService();
    const c1 = await service.create(selfCaller("alice"), {
      name: "a1",
      schedule: { kind: "every", interval: "1h" },
      prompt: "x",
    });
    const c2 = await service.create(selfCaller("alice"), {
      name: "a2",
      schedule: { kind: "every", interval: "2h" },
      prompt: "x",
    });
    const count = await service.purgeForAgent("alice");
    expect(count).toBe(2);
    expect(scheduler.removes).toEqual(expect.arrayContaining([c1.id, c2.id]));
  });
});
