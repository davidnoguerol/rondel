/**
 * File-backed store for runtime-created cron schedules.
 *
 * Runtime schedules live in `state/schedules.json` — separate from the
 * declarative `crons` array in each agent's `agent.json`. The split exists
 * because agent.json is user-owned (git-committable) and framework code
 * must not mutate it at runtime. Runtime schedules are framework ephemera;
 * they belong under `state/`, alongside `approvals/` and `inboxes/`.
 *
 * Storage format:
 *   { "version": 1, "jobs": [CronJob, ...] }
 *
 * The version field exists so future schema changes can be detected and
 * migrated without trashing user data.
 *
 * Concurrency: the orchestrator has a single `ScheduleStore` instance that
 * owns the in-memory authoritative copy. Every mutation persists
 * atomically to disk before returning. If we ever need multiple writers we
 * can add a lock mirrored after `withInboxLock`.
 */

import { readFile } from "node:fs/promises";
import { atomicWriteFile } from "../shared/atomic-file.js";
import type { CronJob } from "../shared/types/index.js";
import type { Logger } from "../shared/logger.js";

const SCHEDULE_ID_RE = /^sched_\d+_[a-f0-9]+$/;

const CURRENT_VERSION = 1;

interface ScheduleFileV1 {
  readonly version: 1;
  readonly jobs: readonly CronJob[];
}

export function isScheduleId(id: string): boolean {
  return SCHEDULE_ID_RE.test(id);
}

export class ScheduleStore {
  private jobs: CronJob[] = [];
  private loaded = false;

  constructor(
    private readonly filePath: string,
    private readonly log: Logger,
  ) {}

  /** Load from disk. Must be called once before any other method. */
  async init(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf-8");
    } catch {
      this.jobs = [];
      this.loaded = true;
      return;
    }

    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object") {
        throw new Error("schedules.json is not an object");
      }
      const file = parsed as { version?: number; jobs?: unknown };
      if (file.version !== CURRENT_VERSION) {
        this.log.warn(
          `schedules.json version ${String(file.version)} is unsupported (expected ${CURRENT_VERSION}) — starting empty`,
        );
        this.jobs = [];
      } else if (Array.isArray(file.jobs)) {
        this.jobs = file.jobs as CronJob[];
      } else {
        this.jobs = [];
      }
    } catch (err) {
      this.log.warn(
        `schedules.json is corrupt — starting empty (${err instanceof Error ? err.message : String(err)})`,
      );
      this.jobs = [];
    }

    this.loaded = true;
  }

  /** Returns a snapshot of all runtime jobs. */
  list(): readonly CronJob[] {
    this.assertLoaded();
    return [...this.jobs];
  }

  getById(id: string): CronJob | undefined {
    this.assertLoaded();
    return this.jobs.find((j) => j.id === id);
  }

  getByAgent(agentName: string): readonly CronJob[] {
    this.assertLoaded();
    return this.jobs.filter((j) => j.owner === agentName);
  }

  async add(job: CronJob): Promise<void> {
    this.assertLoaded();
    if (!isScheduleId(job.id)) {
      throw new Error(`Invalid schedule id: "${job.id}" (expected sched_<ts>_<hex>)`);
    }
    if (this.jobs.some((j) => j.id === job.id)) {
      throw new Error(`Schedule already exists: ${job.id}`);
    }
    this.jobs.push(job);
    await this.persist();
  }

  async update(id: string, patch: Partial<CronJob>): Promise<CronJob | undefined> {
    this.assertLoaded();
    const index = this.jobs.findIndex((j) => j.id === id);
    if (index < 0) return undefined;
    const current = this.jobs[index]!;
    // Guard identity fields: id, source, owner, createdAtMs can't be patched.
    const merged: CronJob = {
      ...current,
      ...patch,
      id: current.id,
      source: current.source,
      owner: current.owner,
      createdAtMs: current.createdAtMs,
    };
    this.jobs[index] = merged;
    await this.persist();
    return merged;
  }

  async remove(id: string): Promise<boolean> {
    this.assertLoaded();
    const before = this.jobs.length;
    this.jobs = this.jobs.filter((j) => j.id !== id);
    const removed = this.jobs.length < before;
    if (removed) await this.persist();
    return removed;
  }

  /** Remove all jobs owned by an agent (used when the agent is deleted). Returns removed IDs. */
  async purgeByAgent(agentName: string): Promise<string[]> {
    this.assertLoaded();
    const removed: string[] = [];
    this.jobs = this.jobs.filter((j) => {
      if (j.owner === agentName) {
        removed.push(j.id);
        return false;
      }
      return true;
    });
    if (removed.length > 0) await this.persist();
    return removed;
  }

  private assertLoaded(): void {
    if (!this.loaded) {
      throw new Error("ScheduleStore.init() must be called before use");
    }
  }

  private async persist(): Promise<void> {
    const file: ScheduleFileV1 = { version: CURRENT_VERSION, jobs: this.jobs };
    await atomicWriteFile(this.filePath, JSON.stringify(file, null, 2) + "\n");
  }
}
