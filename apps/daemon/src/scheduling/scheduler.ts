import { readFile } from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile } from "../shared/atomic-file.js";
import { rondelPaths, loadAgentConfig } from "../config/config.js";
import type { AgentManager } from "../agents/agent-manager.js";
import type { CronRunner } from "./cron-runner.js";
import type { ChannelRegistry } from "../channels/core/index.js";
import type { RondelHooks } from "../shared/hooks.js";
import type {
  AgentEvent,
  CronJob,
  CronJobState,
  CronRunResult,
  CronRunStatus,
  CronSessionTarget,
} from "../shared/types/index.js";
import type { Logger } from "../shared/logger.js";
import { parseInterval, parseSchedule, describeSchedule, type ParsedSchedule } from "./parse-schedule.js";
import { resolveDelivery } from "./cron-context.js";
import type { ScheduleStore } from "./schedule-store.js";
import type { SchedulerControl } from "./schedule-service.js";

// Re-exported for backwards compatibility with existing tests and callers.
export { parseInterval };

// --- Backoff schedule (from OpenClaw) ---

const BACKOFF_DELAYS_MS = [30_000, 60_000, 300_000, 900_000, 3_600_000]; // 30s, 1m, 5m, 15m, 60m

export function getBackoffDelay(consecutiveErrors: number): number {
  const idx = Math.min(consecutiveErrors - 1, BACKOFF_DELAYS_MS.length - 1);
  return BACKOFF_DELAYS_MS[Math.max(0, idx)];
}

// --- Missed job stagger ---

const MISSED_JOB_STAGGER_MS = 5_000; // 5s between missed job executions

// --- State persistence ---

function stateFilePath(rondelHome: string): string {
  return rondelPaths(rondelHome).cronState;
}

async function loadState(rondelHome: string): Promise<Record<string, CronJobState>> {
  try {
    const raw = await readFile(stateFilePath(rondelHome), "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function saveState(rondelHome: string, state: Record<string, CronJobState>): Promise<void> {
  await atomicWriteFile(stateFilePath(rondelHome), JSON.stringify(state, null, 2));
}

// --- Job entry (runtime representation) ---

interface ScheduledJob {
  readonly agentName: string;
  job: CronJob;
  parsed: ParsedSchedule;
  state: CronJobState;
}

// --- Config watch debounce ---

const RELOAD_DEBOUNCE_MS = 300; // same as OpenClaw's default

/**
 * Timer-driven cron job runner.
 *
 * Follows OpenClaw's three-way separation:
 * - Session target: where the work runs (isolated ephemeral process, or named persistent session)
 * - Payload: what the work is (a prompt that triggers an agent turn)
 * - Delivery: where output goes (announce to a channel, or none)
 *
 * Jobs come from two sources, merged into a single in-memory map:
 * - Declarative: `crons` array in each agent's `agent.json` (hot-reloaded on file change)
 * - Runtime: entries in `state/schedules.json` (owned by `ScheduleStore`, mutated via
 *   `upsertRuntimeJob` / `removeRuntimeJob`)
 *
 * Schedule kinds supported: `every` (interval), `at` (one-shot), `cron` (expression).
 * See `parse-schedule.ts` for the authoritative implementation.
 */
export class Scheduler implements SchedulerControl {
  private readonly jobs = new Map<string, ScheduledJob>(); // stateKey → job
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private readonly log: Logger;
  private readonly watchers: FSWatcher[] = [];
  private reloadDebounce: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly agentManager: AgentManager,
    private readonly cronRunner: CronRunner,
    private readonly channelRegistry: ChannelRegistry,
    private readonly hooks: RondelHooks,
    private readonly rondelHome: string,
    private readonly scheduleStore: ScheduleStore,
    log: Logger,
  ) {
    this.log = log.child("scheduler");
  }

  /**
   * Load jobs from agent configs + the runtime schedule store, then start
   * the timer. Detects and executes missed jobs that were due while Rondel
   * was down.
   */
  async start(): Promise<void> {
    // Declarative jobs from agent.json
    const agentNames = this.agentManager.getAgentNames();
    for (const agentName of agentNames) {
      const template = this.agentManager.getTemplate(agentName);
      if (!template?.config.crons) continue;
      for (const raw of template.config.crons) {
        this.safeInsert(agentName, { ...raw, source: "declarative" });
      }
    }

    // Runtime jobs from state/schedules.json
    for (const raw of this.scheduleStore.list()) {
      if (!raw.owner) continue;
      this.safeInsert(raw.owner, raw);
    }

    // Load persisted state and merge into runtime jobs
    const persisted = await loadState(this.rondelHome);
    for (const [key, scheduledJob] of this.jobs) {
      const saved = persisted[key];
      if (saved) scheduledJob.state = saved;
    }

    // Compute nextRunAtMs for jobs that don't have one yet. Using
    // `initialFireAtMs` (not `nextRunAtMs`) here so that one-shot `at`
    // schedules whose target time elapsed while the daemon was down still
    // fire on restart — otherwise a past ISO timestamp would drop to null
    // and be silently forgotten.
    const now = Date.now();
    for (const [, scheduledJob] of this.jobs) {
      if (scheduledJob.state.nextRunAtMs == null && scheduledJob.state.lastRunAtMs == null) {
        scheduledJob.state.nextRunAtMs = scheduledJob.parsed.initialFireAtMs(now) ?? undefined;
      }
    }

    this.running = true;

    // Check for missed jobs (overdue since last shutdown)
    const missedJobs = [...this.jobs.entries()]
      .filter(([, sj]) => sj.state.nextRunAtMs != null && sj.state.nextRunAtMs <= now)
      .sort((a, b) => (a[1].state.nextRunAtMs ?? 0) - (b[1].state.nextRunAtMs ?? 0));

    if (missedJobs.length > 0) {
      this.log.info(`Found ${missedJobs.length} missed cron job(s) — executing with stagger`);
      this.executeMissedJobs(missedJobs.map(([key]) => key));
    }

    this.logSchedule();
    this.armTimer();
    this.watchConfigFiles();

    if (this.jobs.size === 0) {
      this.log.info("No cron jobs configured (watching for changes)");
    }
  }

  /** Stop the scheduler — clear timers, stop watchers, persist state. */
  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.reloadDebounce) {
      clearTimeout(this.reloadDebounce);
      this.reloadDebounce = null;
    }
    for (const w of this.watchers) w.close();
    this.watchers.length = 0;
    await this.persistState();
    this.log.info("Scheduler stopped");
  }

  // --- SchedulerControl implementation (called by ScheduleService) ---

  upsertRuntimeJob(job: CronJob, options: { rearmTiming?: boolean } = {}): void {
    if (!job.owner) {
      this.log.warn(`upsertRuntimeJob called without owner: ${job.id}`);
      return;
    }
    const stateKey = `${job.owner}:${job.id}`;
    const existing = this.jobs.get(stateKey);
    let parsed: ParsedSchedule;
    try {
      parsed = parseSchedule(job.schedule);
    } catch (err) {
      this.log.warn(
        `upsertRuntimeJob: invalid schedule for ${stateKey}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    if (existing) {
      existing.job = job;
      existing.parsed = parsed;
      // Only recompute nextRunAtMs when the caller signals the schedule
      // or enabled flag actually changed. Default is to preserve timing
      // — that way a prompt-only edit on a 1h-interval job doesn't shift
      // its next fire time to now+1h.
      const rearm = options.rearmTiming ?? false;
      if (rearm) {
        if (job.enabled === false) {
          existing.state.nextRunAtMs = undefined;
        } else {
          existing.state.nextRunAtMs = parsed.nextRunAtMs(Date.now()) ?? undefined;
        }
      }
    } else {
      // New insert: use `initialFireAtMs` so a one-shot `at` registered
      // with a past timestamp (e.g. "fire in -5m") still runs once.
      const nextRunAtMs =
        job.enabled === false ? undefined : parsed.initialFireAtMs(Date.now()) ?? undefined;
      this.jobs.set(stateKey, {
        agentName: job.owner,
        job,
        parsed,
        state: { consecutiveErrors: 0, nextRunAtMs },
      });
      this.log.info(`Runtime schedule registered: ${stateKey} ("${job.name}", ${describeSchedule(job)})`);
    }

    if (this.running) this.armTimer();
  }

  removeRuntimeJob(id: string): void {
    for (const [key, sj] of this.jobs) {
      if (sj.job.id === id && sj.job.source === "runtime") {
        this.jobs.delete(key);
        this.log.info(`Runtime schedule removed: ${key}`);
        break;
      }
    }
    if (this.running) this.armTimer();
  }

  async triggerNow(id: string): Promise<boolean> {
    // Schedule ids are globally unique (enforced by ScheduleStore.add) and
    // job owners are immutable in the store, so iterating once is enough.
    for (const sj of this.jobs.values()) {
      if (sj.job.id === id) {
        sj.state.nextRunAtMs = Date.now();
        if (this.running) this.armTimer();
        return true;
      }
    }
    return false;
  }

  getJobStateSnapshot(id: string):
    | { nextRunAtMs?: number; lastRunAtMs?: number; lastStatus?: string; consecutiveErrors: number }
    | undefined {
    for (const sj of this.jobs.values()) {
      if (sj.job.id === id) {
        return {
          nextRunAtMs: sj.state.nextRunAtMs,
          lastRunAtMs: sj.state.lastRunAtMs,
          lastStatus: sj.state.lastStatus,
          consecutiveErrors: sj.state.consecutiveErrors,
        };
      }
    }
    return undefined;
  }

  // --- Config hot-reload (declarative source) ---

  private watchConfigFiles(): void {
    const agentNames = this.agentManager.getAgentNames();
    for (const agentName of agentNames) {
      const configPath = join(this.agentManager.getAgentDir(agentName), "agent.json");
      try {
        const watcher = watch(configPath, () => this.scheduleReload());
        this.watchers.push(watcher);
      } catch {
        this.log.warn(`Could not watch ${configPath} for changes`);
      }
    }
    if (this.watchers.length > 0) {
      this.log.info(`Watching ${this.watchers.length} agent config(s) for cron changes`);
    }
  }

  private scheduleReload(): void {
    if (this.reloadDebounce) clearTimeout(this.reloadDebounce);
    this.reloadDebounce = setTimeout(() => this.reloadDeclarativeJobs(), RELOAD_DEBOUNCE_MS);
  }

  /**
   * Reload declarative cron jobs from agent configs. Runtime jobs are
   * unaffected — they live in `ScheduleStore` and are mutated through
   * `upsertRuntimeJob` / `removeRuntimeJob`.
   */
  private async reloadDeclarativeJobs(): Promise<void> {
    const seenKeys = new Set<string>();

    for (const agentName of this.agentManager.getAgentNames()) {
      let crons: readonly CronJob[] = [];
      try {
        const config = await loadAgentConfig(this.agentManager.getAgentDir(agentName));
        crons = config.crons ?? [];
      } catch (err) {
        this.log.warn(
          `Failed to reload config for ${agentName}: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }

      for (const raw of crons) {
        const job: CronJob = { ...raw, source: "declarative" };
        if (job.enabled === false) continue;

        const stateKey = `${agentName}:${job.id}`;
        seenKeys.add(stateKey);

        if (this.jobs.has(stateKey)) {
          const existing = this.jobs.get(stateKey)!;
          // Only touch declarative entries — runtime jobs with the same
          // (agent, id) key shouldn't exist, but if they do leave them.
          if (existing.job.source === "runtime") continue;
          try {
            existing.parsed = parseSchedule(job.schedule);
          } catch (err) {
            this.log.warn(
              `Reload: invalid schedule for ${stateKey}: ${err instanceof Error ? err.message : String(err)}`,
            );
            continue;
          }
          existing.job = job;
        } else {
          this.safeInsert(agentName, job);
        }
      }
    }

    // Remove declarative jobs that no longer exist in any config
    for (const key of [...this.jobs.keys()]) {
      const sj = this.jobs.get(key)!;
      if (sj.job.source !== "runtime" && !seenKeys.has(key)) {
        this.jobs.delete(key);
        this.log.info(`Declarative cron job removed: ${key}`);
      }
    }

    if (this.jobs.size > 0) {
      this.running = true;
      this.armTimer();
      this.logSchedule();
    } else {
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      this.log.info("All cron jobs removed");
    }

    await this.persistState();
  }

  /** Get a summary of all jobs for /status display and the watchdog. */
  getJobSummaries(): Array<{
    agentName: string;
    jobId: string;
    jobName: string;
    schedule: string;
    source: "declarative" | "runtime";
    enabled: boolean;
    lastStatus?: CronRunStatus;
    consecutiveErrors: number;
    lastRunAtMs?: number;
    nextRunAtMs?: number;
  }> {
    return [...this.jobs.values()].map((sj) => ({
      agentName: sj.agentName,
      jobId: sj.job.id,
      jobName: sj.job.name,
      schedule: describeSchedule(sj.job),
      source: sj.job.source ?? "declarative",
      enabled: sj.job.enabled !== false,
      lastStatus: sj.state.lastStatus,
      consecutiveErrors: sj.state.consecutiveErrors,
      lastRunAtMs: sj.state.lastRunAtMs,
      nextRunAtMs: sj.state.nextRunAtMs,
    }));
  }

  /**
   * Re-evaluate job timers. Idempotent — clears the current timer and
   * recomputes the next fire based on each job's `nextRunAtMs`. Any jobs
   * with `nextRunAtMs <= now` will fire on the next tick of `onTimer`.
   *
   * Safe to call at any time: from watchdog self-heal, after external
   * state reloads, or manually for diagnostics. Called internally by
   * `upsertRuntimeJob` / `removeRuntimeJob` / `triggerNow` already.
   */
  rearm(): void {
    this.armTimer();
  }

  // --- Insertion helper ---

  private safeInsert(agentName: string, job: CronJob): void {
    if (job.enabled === false) return;
    let parsed: ParsedSchedule;
    try {
      parsed = parseSchedule(job.schedule);
    } catch (err) {
      this.log.warn(
        `Skipping cron "${agentName}:${job.id}" — invalid schedule: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    const stateKey = `${agentName}:${job.id}`;
    // Seed with initialFireAtMs — for declarative hot-reloads (a new cron
    // added to agent.json while Rondel is running) this ensures the job
    // has a future fire time. `start()` may overwrite with persisted state
    // if this key existed in a previous run.
    const nextRunAtMs = parsed.initialFireAtMs(Date.now()) ?? undefined;
    this.jobs.set(stateKey, {
      agentName,
      job,
      parsed,
      state: { consecutiveErrors: 0, nextRunAtMs },
    });
  }

  // --- Timer management ---

  private armTimer(): void {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);

    let earliestMs = Infinity;
    for (const [, sj] of this.jobs) {
      if (sj.state.nextRunAtMs != null && sj.state.nextRunAtMs < earliestMs) {
        earliestMs = sj.state.nextRunAtMs;
      }
    }

    if (earliestMs === Infinity) return;

    const delayMs = Math.max(0, earliestMs - Date.now());
    this.timer = setTimeout(() => this.onTimer(), delayMs);
  }

  private async onTimer(): Promise<void> {
    if (!this.running) return;

    const now = Date.now();
    const dueJobs = [...this.jobs.entries()]
      .filter(([, sj]) => sj.state.nextRunAtMs != null && sj.state.nextRunAtMs <= now)
      .sort((a, b) => (a[1].state.nextRunAtMs ?? 0) - (b[1].state.nextRunAtMs ?? 0));

    for (const [key] of dueJobs) {
      if (!this.running) break;
      await this.executeJob(key);
    }

    this.armTimer();
  }

  private async executeMissedJobs(keys: string[]): Promise<void> {
    for (const key of keys) {
      if (!this.running) break;
      await this.executeJob(key);
      if (this.running && keys.indexOf(key) < keys.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, MISSED_JOB_STAGGER_MS));
      }
    }
  }

  // --- Job execution ---

  private async executeJob(stateKey: string): Promise<void> {
    const scheduledJob = this.jobs.get(stateKey);
    if (!scheduledJob) return;

    const { agentName, job, parsed } = scheduledJob;
    const startMs = Date.now();

    this.log.info(`Cron run starting: ${stateKey} ("${job.name}")`);

    let runResult: CronRunResult;

    try {
      const sessionTarget: CronSessionTarget = job.sessionTarget ?? "isolated";
      if (sessionTarget === "isolated") {
        runResult = await this.executeIsolated(agentName, job, startMs);
      } else {
        runResult = await this.executeNamedSession(agentName, job, sessionTarget, startMs);
      }
    } catch (err) {
      const durationMs = Date.now() - startMs;
      runResult = {
        status: "error",
        error: err instanceof Error ? err.message : String(err),
        durationMs,
      };
    }

    scheduledJob.state.lastRunAtMs = startMs;
    scheduledJob.state.lastStatus = runResult.status;
    scheduledJob.state.lastDurationMs = runResult.durationMs;
    scheduledJob.state.lastCostUsd = runResult.costUsd;

    const now = Date.now();

    if (runResult.status === "ok") {
      scheduledJob.state.consecutiveErrors = 0;
      scheduledJob.state.lastError = undefined;
      const next = parsed.nextRunAtMs(now);
      scheduledJob.state.nextRunAtMs = next ?? undefined;

      this.hooks.emit("cron:completed", { agentName, job, result: runResult });
      this.log.info(
        `Cron run OK: ${stateKey} (${runResult.durationMs}ms, $${runResult.costUsd?.toFixed(4) ?? "?"})`,
      );
    } else {
      scheduledJob.state.consecutiveErrors += 1;
      scheduledJob.state.lastError = runResult.error;
      const backoffMs = getBackoffDelay(scheduledJob.state.consecutiveErrors);
      const normalNext = parsed.nextRunAtMs(now);
      // Never fire before the backoff elapses; never skip a future normal
      // fire just because backoff is shorter.
      scheduledJob.state.nextRunAtMs = Math.max(normalNext ?? now + backoffMs, now + backoffMs);

      this.hooks.emit("cron:failed", {
        agentName,
        job,
        result: runResult,
        consecutiveErrors: scheduledJob.state.consecutiveErrors,
      });
      this.log.warn(
        `Cron run FAILED: ${stateKey} (errors: ${scheduledJob.state.consecutiveErrors}, ` +
          `backoff: ${Math.round(backoffMs / 1000)}s, error: ${runResult.error?.slice(0, 200)})`,
      );
    }

    // Deliver output if configured and successful
    if (runResult.status === "ok" && runResult.result) {
      await this.deliverResult(agentName, job, runResult.result);
    }

    // Auto-delete runtime one-shots after a successful run.
    if (
      runResult.status === "ok" &&
      job.source === "runtime" &&
      job.deleteAfterRun !== false &&
      (parsed.isOneShot || job.deleteAfterRun === true)
    ) {
      await this.autoDelete(stateKey, scheduledJob);
    }

    await this.persistState();
  }

  private async autoDelete(stateKey: string, scheduledJob: ScheduledJob): Promise<void> {
    this.jobs.delete(stateKey);
    // Only emit `schedule:deleted` if THIS path is the one that actually
    // removed the record from the store. If a user-initiated
    // `rondel_schedule_delete` raced with us and won, `remove()` returns
    // false and the service has already emitted its own `deleted` hook
    // with `reason: "requested"` — we must not double-ledger.
    let removed = false;
    try {
      removed = await this.scheduleStore.remove(scheduledJob.job.id);
    } catch (err) {
      this.log.warn(
        `autoDelete: failed to remove ${scheduledJob.job.id} from store: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (removed) {
      this.hooks.emit("schedule:deleted", { job: scheduledJob.job, reason: "ran_once" });
      this.log.info(`Runtime schedule auto-deleted after run: ${stateKey}`);
    }
  }

  // --- Execution modes ---

  private async executeIsolated(
    agentName: string,
    job: CronJob,
    startMs: number,
  ): Promise<CronRunResult> {
    const result = await this.cronRunner.runIsolated(agentName, job);
    const durationMs = Date.now() - startMs;

    if (result.state === "completed") {
      return { status: "ok", result: result.result, costUsd: result.costUsd, durationMs };
    }

    return {
      status: "error",
      error: result.error ?? `Subagent ended with state: ${result.state}`,
      costUsd: result.costUsd,
      durationMs,
    };
  }

  private async executeNamedSession(
    agentName: string,
    job: CronJob,
    sessionTarget: string,
    startMs: number,
  ): Promise<CronRunResult> {
    const sessionName = sessionTarget.slice("session:".length);

    const process = this.cronRunner.getOrSpawnNamedSession(agentName, sessionName);
    if (!process) {
      return { status: "error", error: `Agent "${agentName}" not found`, durationMs: Date.now() - startMs };
    }

    const state = process.getState();
    if (state === "busy") {
      return { status: "skipped", durationMs: Date.now() - startMs };
    }

    return new Promise<CronRunResult>((resolve) => {
      let resolved = false;

      const onResponse = (text: string) => {
        if (resolved) return;
        resolved = true;
        cleanup();
        resolve({ status: "ok", result: text, durationMs: Date.now() - startMs });
      };

      const onTurnComplete = (event: AgentEvent) => {
        if (resolved) return;
        resolved = true;
        cleanup();
        const cost = "total_cost_usd" in event ? (event.total_cost_usd as number) : undefined;
        resolve({ status: "ok", costUsd: cost, durationMs: Date.now() - startMs });
      };

      const onStateChange = (newState: string) => {
        if (resolved) return;
        if (newState === "crashed" || newState === "halted") {
          resolved = true;
          cleanup();
          resolve({
            status: "error",
            error: `Agent process ${newState} during cron run`,
            durationMs: Date.now() - startMs,
          });
        }
      };

      const cleanup = () => {
        process.off("response", onResponse);
        process.off("turnComplete", onTurnComplete);
        process.off("stateChange", onStateChange);
      };

      process.on("response", onResponse);
      process.on("turnComplete", onTurnComplete);
      process.on("stateChange", onStateChange);
      process.sendMessage(job.prompt);
    });
  }

  // --- Delivery ---

  private async deliverResult(agentName: string, job: CronJob, resultText: string): Promise<void> {
    // `resolveDelivery` handles mode ("none" or undefined → null), the
    // declarative-cron primary-channel fallback, and the final shape. The
    // cron subagent's system prompt is built from the same resolver — if
    // this returns null, the subagent was correctly told "no auto-delivery"
    // and will not have a double-send expectation.
    const target = resolveDelivery(
      job.delivery,
      () => this.agentManager.getPrimaryChannel(agentName),
    );
    if (!target) {
      if (job.delivery?.mode === "announce") {
        this.log.warn(`Cannot deliver cron result for ${agentName}: no channel binding found`);
      }
      return;
    }

    try {
      await this.channelRegistry.sendText(target.channelType, target.accountId, target.chatId, resultText);
      this.log.debug(`Cron result delivered to ${target.channelType} chat ${target.chatId}`);
    } catch (err) {
      this.log.warn(
        `Cron delivery failed for ${job.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // --- State persistence ---

  private async persistState(): Promise<void> {
    const state: Record<string, CronJobState> = {};
    for (const [key, sj] of this.jobs) {
      state[key] = sj.state;
    }
    try {
      await saveState(this.rondelHome, state);
    } catch (err) {
      this.log.warn(`Failed to persist cron state: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // --- Logging ---

  private logSchedule(): void {
    for (const [key, sj] of this.jobs) {
      const nextIn = sj.state.nextRunAtMs
        ? `${Math.round((sj.state.nextRunAtMs - Date.now()) / 1000)}s`
        : "?";
      const tag = sj.job.source === "runtime" ? "[runtime] " : "";
      this.log.info(`  ${tag}${key}: "${sj.job.name}" ${describeSchedule(sj.job)} (next in ${nextIn})`);
    }
  }
}

