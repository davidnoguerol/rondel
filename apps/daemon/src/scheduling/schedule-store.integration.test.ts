import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScheduleStore } from "./schedule-store.js";
import type { CronJob } from "../shared/types/index.js";

const silentLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => silentLog,
} as const;

const dirs: string[] = [];

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "sched-store-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (dirs.length) {
    const d = dirs.pop()!;
    await rm(d, { recursive: true, force: true });
  }
});

function makeJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: `sched_${Math.floor(Date.now() / 1000)}_${Math.random().toString(16).slice(2, 10)}`,
    name: "test",
    enabled: true,
    schedule: { kind: "every", interval: "1h" },
    prompt: "do the thing",
    sessionTarget: "isolated",
    source: "runtime",
    owner: "bot1",
    createdAtMs: 1_000_000,
    ...overrides,
  };
}

describe("ScheduleStore — lifecycle", () => {
  it("init on a missing file starts empty", async () => {
    const dir = tmp();
    const store = new ScheduleStore(join(dir, "schedules.json"), silentLog as never);
    await store.init();
    expect(store.list()).toEqual([]);
  });

  it("add → list round-trips the job", async () => {
    const dir = tmp();
    const store = new ScheduleStore(join(dir, "schedules.json"), silentLog as never);
    await store.init();

    const job = makeJob();
    await store.add(job);

    expect(store.list()).toHaveLength(1);
    expect(store.getById(job.id)).toEqual(job);
    expect(store.getByAgent("bot1")).toEqual([job]);
    expect(store.getByAgent("bot2")).toEqual([]);
  });

  it("persists across fresh instances", async () => {
    const dir = tmp();
    const file = join(dir, "schedules.json");

    const first = new ScheduleStore(file, silentLog as never);
    await first.init();
    const job = makeJob({ name: "persistent" });
    await first.add(job);

    const second = new ScheduleStore(file, silentLog as never);
    await second.init();
    expect(second.getById(job.id)?.name).toBe("persistent");
  });

  it("update merges the patch but preserves identity fields", async () => {
    const dir = tmp();
    const store = new ScheduleStore(join(dir, "schedules.json"), silentLog as never);
    await store.init();
    const job = makeJob({ name: "original" });
    await store.add(job);

    const updated = await store.update(job.id, {
      name: "renamed",
      owner: "evil", // attempt to change owner via patch — must be ignored
      id: "sched_impostor_aaaa" as never,
      createdAtMs: 0 as never,
    });

    expect(updated?.name).toBe("renamed");
    expect(updated?.owner).toBe("bot1");
    expect(updated?.id).toBe(job.id);
    expect(updated?.createdAtMs).toBe(1_000_000);
  });

  it("remove deletes and returns true when present, false otherwise", async () => {
    const dir = tmp();
    const store = new ScheduleStore(join(dir, "schedules.json"), silentLog as never);
    await store.init();
    const job = makeJob();
    await store.add(job);

    expect(await store.remove(job.id)).toBe(true);
    expect(store.getById(job.id)).toBeUndefined();
    expect(await store.remove(job.id)).toBe(false);
  });

  it("purgeByAgent removes all owned jobs and returns ids", async () => {
    const dir = tmp();
    const store = new ScheduleStore(join(dir, "schedules.json"), silentLog as never);
    await store.init();
    const a1 = makeJob({ owner: "a" });
    const a2 = makeJob({ owner: "a" });
    const b1 = makeJob({ owner: "b" });
    await store.add(a1);
    await store.add(a2);
    await store.add(b1);

    const removed = await store.purgeByAgent("a");
    expect(removed.sort()).toEqual([a1.id, a2.id].sort());
    expect(store.getByAgent("a")).toEqual([]);
    expect(store.getByAgent("b")).toHaveLength(1);
  });

  it("rejects ids that don't match the sched_<epoch>_<hex> format", async () => {
    const dir = tmp();
    const store = new ScheduleStore(join(dir, "schedules.json"), silentLog as never);
    await store.init();
    await expect(store.add(makeJob({ id: "bogus" }))).rejects.toThrow(/Invalid schedule id/);
  });

  it("rejects duplicate ids", async () => {
    const dir = tmp();
    const store = new ScheduleStore(join(dir, "schedules.json"), silentLog as never);
    await store.init();
    const job = makeJob();
    await store.add(job);
    await expect(store.add(job)).rejects.toThrow(/already exists/);
  });

  it("treats a corrupt JSON file as empty without throwing", async () => {
    const dir = tmp();
    const file = join(dir, "schedules.json");
    await writeFile(file, "{ this is not valid json", "utf-8");
    const store = new ScheduleStore(file, silentLog as never);
    await store.init();
    expect(store.list()).toEqual([]);
    // Writes after corrupt recovery should succeed and replace the file.
    const job = makeJob();
    await store.add(job);
    expect(store.getById(job.id)).toEqual(job);
  });

  it("drops jobs when the version field is unsupported", async () => {
    const dir = tmp();
    const file = join(dir, "schedules.json");
    await writeFile(file, JSON.stringify({ version: 999, jobs: [makeJob()] }), "utf-8");
    const store = new ScheduleStore(file, silentLog as never);
    await store.init();
    expect(store.list()).toEqual([]);
  });
});
