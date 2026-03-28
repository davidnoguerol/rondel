import { readFile } from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile } from "../shared/atomic-file.js";
import { flowclawPaths, loadAgentConfig } from "../config/config.js";
import type { AgentManager } from "../agents/agent-manager.js";
import type { CronRunner } from "./cron-runner.js";
import type { TelegramAdapter } from "../channels/telegram.js";
import type { FlowclawHooks } from "../shared/hooks.js";
import type { AgentEvent, CronJob, CronJobState, CronRunResult, CronRunStatus } from "../shared/types.js";
import type { Logger } from "../shared/logger.js";

// --- Interval parsing ---

/**
 * Parse a duration string like "30s", "5m", "1h", "24h", "2h30m" to milliseconds.
 * Supports combinations: days (d), hours (h), minutes (m), seconds (s).
 */
export function parseInterval(interval: string): number {
  const pattern = /^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/;
  const match = interval.match(pattern);
  if (!match || match[0] === "") {
    throw new Error(`Invalid interval format: "${interval}" (expected e.g. "30s", "5m", "1h", "24h", "2h30m")`);
  }

  const [, days, hours, minutes, seconds] = match;
  const ms =
    (parseInt(days ?? "0", 10) * 86_400_000) +
    (parseInt(hours ?? "0", 10) * 3_600_000) +
    (parseInt(minutes ?? "0", 10) * 60_000) +
    (parseInt(seconds ?? "0", 10) * 1_000);

  if (ms === 0) {
    throw new Error(`Interval must be greater than zero: "${interval}"`);
  }

  return ms;
}

// --- Backoff schedule (from OpenClaw) ---

const BACKOFF_DELAYS_MS = [30_000, 60_000, 300_000, 900_000, 3_600_000]; // 30s, 1m, 5m, 15m, 60m

function getBackoffDelay(consecutiveErrors: number): number {
  const idx = Math.min(consecutiveErrors - 1, BACKOFF_DELAYS_MS.length - 1);
  return BACKOFF_DELAYS_MS[Math.max(0, idx)];
}

// --- Missed job stagger ---

const MISSED_JOB_STAGGER_MS = 5_000; // 5s between missed job executions

// --- State persistence ---

function stateFilePath(flowclawHome: string): string {
  return flowclawPaths(flowclawHome).cronState;
}

async function loadState(flowclawHome: string): Promise<Record<string, CronJobState>> {
  try {
    const raw = await readFile(stateFilePath(flowclawHome), "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function saveState(flowclawHome: string, state: Record<string, CronJobState>): Promise<void> {
  await atomicWriteFile(stateFilePath(flowclawHome), JSON.stringify(state, null, 2));
}

// --- Job entry (runtime representation) ---

interface ScheduledJob {
  readonly agentName: string;
  job: CronJob;
  intervalMs: number;
  state: CronJobState;
}

// --- Scheduler ---

/**
 * Timer-driven cron job runner.
 *
 * Follows OpenClaw's three-way separation:
 * - Session target: where the work runs (isolated ephemeral process, or named persistent session)
 * - Payload: what the work is (a prompt that triggers an agent turn)
 * - Delivery: where output goes (announce to Telegram, or none)
 *
 * Currently supports:
 * - Schedule: "every" (fixed interval)
 * - Session target: "isolated" (default — fresh process per run)
 * - Delivery: "announce" (send to Telegram chat) or "none" (log only)
 */
// --- Config watch debounce ---

const RELOAD_DEBOUNCE_MS = 300; // same as OpenClaw's default

export class Scheduler {
  private readonly jobs = new Map<string, ScheduledJob>(); // stateKey → job
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private readonly log: Logger;
  private readonly watchers: FSWatcher[] = [];
  private reloadDebounce: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly agentManager: AgentManager,
    private readonly cronRunner: CronRunner,
    private readonly telegram: TelegramAdapter,
    private readonly hooks: FlowclawHooks,
    private readonly flowclawHome: string,
    log: Logger,
  ) {
    this.log = log.child("scheduler");
  }

  /**
   * Load jobs from agent configs and start the timer.
   * Detects and executes missed jobs that were due while FlowClaw was down.
   */
  async start(): Promise<void> {
    // Collect cron jobs from all agent templates
    const agentNames = this.agentManager.getAgentNames();
    for (const agentName of agentNames) {
      const template = this.agentManager.getTemplate(agentName);
      if (!template?.config.crons) continue;

      for (const job of template.config.crons) {
        if (job.enabled === false) continue;

        const intervalMs = parseInterval(job.schedule.interval);
        const stateKey = `${agentName}:${job.id}`;

        this.jobs.set(stateKey, {
          agentName,
          job,
          intervalMs,
          state: { consecutiveErrors: 0 },
        });
      }
    }

    if (this.jobs.size === 0) {
      this.log.info("No cron jobs configured (watching for changes)");
      this.running = true;
      this.watchConfigFiles();
      return;
    }

    // Load persisted state and merge into runtime jobs
    const persisted = await loadState(this.flowclawHome);
    for (const [key, scheduledJob] of this.jobs) {
      const saved = persisted[key];
      if (saved) {
        scheduledJob.state = saved;
      }
    }

    // Compute nextRunAtMs for jobs that don't have one yet
    const now = Date.now();
    for (const [, scheduledJob] of this.jobs) {
      if (!scheduledJob.state.nextRunAtMs) {
        scheduledJob.state.nextRunAtMs = now + scheduledJob.intervalMs;
      }
    }

    this.running = true;

    // Check for missed jobs (overdue since last shutdown)
    const missedJobs = [...this.jobs.entries()]
      .filter(([, sj]) => sj.state.nextRunAtMs! <= now)
      .sort((a, b) => a[1].state.nextRunAtMs! - b[1].state.nextRunAtMs!);

    if (missedJobs.length > 0) {
      this.log.info(`Found ${missedJobs.length} missed cron job(s) — executing with stagger`);
      this.executeMissedJobs(missedJobs.map(([key]) => key));
    }

    this.logSchedule();
    this.armTimer();
    this.watchConfigFiles();
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

  // --- Config hot-reload (like OpenClaw's hybrid reload mode) ---

  /**
   * Watch each agent's agent.json for changes.
   * On change, debounce and reload cron jobs — no restart needed.
   */
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
    this.reloadDebounce = setTimeout(() => this.reloadJobs(), RELOAD_DEBOUNCE_MS);
  }

  /**
   * Reload cron jobs from agent configs.
   * Adds new jobs, removes deleted ones, preserves state for unchanged jobs.
   */
  private async reloadJobs(): Promise<void> {
    const newKeys = new Set<string>();

    for (const agentName of this.agentManager.getAgentNames()) {
      let crons: readonly CronJob[] = [];
      try {
        const config = await loadAgentConfig(this.agentManager.getAgentDir(agentName));
        crons = config.crons ?? [];
      } catch (err) {
        this.log.warn(`Failed to reload config for ${agentName}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }

      for (const job of crons) {
        if (job.enabled === false) continue;

        const stateKey = `${agentName}:${job.id}`;
        newKeys.add(stateKey);

        if (this.jobs.has(stateKey)) {
          // Update job definition in place, keep state
          const existing = this.jobs.get(stateKey)!;
          const newIntervalMs = parseInterval(job.schedule.interval);
          existing.job = job;
          existing.intervalMs = newIntervalMs;
        } else {
          // New job
          const intervalMs = parseInterval(job.schedule.interval);
          this.jobs.set(stateKey, {
            agentName,
            job,
            intervalMs,
            state: { consecutiveErrors: 0, nextRunAtMs: Date.now() + intervalMs },
          });
          this.log.info(`Cron job added: ${stateKey} ("${job.name}")`);
        }
      }
    }

    // Remove jobs that no longer exist in config
    for (const key of [...this.jobs.keys()]) {
      if (!newKeys.has(key)) {
        this.jobs.delete(key);
        this.log.info(`Cron job removed: ${key}`);
      }
    }

    // Ensure running state and re-arm
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

  /** Get a summary of all jobs for /status display. */
  getJobSummaries(): Array<{ agentName: string; jobId: string; jobName: string; interval: string; lastStatus?: CronRunStatus; consecutiveErrors: number; nextRunAtMs?: number }> {
    return [...this.jobs.values()].map((sj) => ({
      agentName: sj.agentName,
      jobId: sj.job.id,
      jobName: sj.job.name,
      interval: sj.job.schedule.interval,
      lastStatus: sj.state.lastStatus,
      consecutiveErrors: sj.state.consecutiveErrors,
      nextRunAtMs: sj.state.nextRunAtMs,
    }));
  }

  // --- Timer management ---

  private armTimer(): void {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);

    // Find the earliest nextRunAtMs across all jobs
    let earliestMs = Infinity;
    for (const [, sj] of this.jobs) {
      if (sj.state.nextRunAtMs && sj.state.nextRunAtMs < earliestMs) {
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
      .filter(([, sj]) => sj.state.nextRunAtMs! <= now)
      .sort((a, b) => a[1].state.nextRunAtMs! - b[1].state.nextRunAtMs!);

    // Execute due jobs sequentially (one at a time)
    for (const [key] of dueJobs) {
      if (!this.running) break;
      await this.executeJob(key);
    }

    this.armTimer();
  }

  // --- Missed job execution ---

  private async executeMissedJobs(keys: string[]): Promise<void> {
    for (const key of keys) {
      if (!this.running) break;
      await this.executeJob(key);
      // Stagger between missed jobs to avoid load spikes
      if (this.running && keys.indexOf(key) < keys.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, MISSED_JOB_STAGGER_MS));
      }
    }
  }

  // --- Job execution ---

  private async executeJob(stateKey: string): Promise<void> {
    const scheduledJob = this.jobs.get(stateKey);
    if (!scheduledJob) return;

    const { agentName, job } = scheduledJob;
    const startMs = Date.now();

    this.log.info(`Cron run starting: ${stateKey} ("${job.name}")`);

    let runResult: CronRunResult;

    try {
      const sessionTarget = job.sessionTarget ?? "isolated";

      if (sessionTarget === "isolated") {
        runResult = await this.executeIsolated(agentName, job, startMs);
      } else {
        // session:<name> — persistent named session
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

    // Update state
    scheduledJob.state.lastRunAtMs = startMs;
    scheduledJob.state.lastStatus = runResult.status;
    scheduledJob.state.lastDurationMs = runResult.durationMs;
    scheduledJob.state.lastCostUsd = runResult.costUsd;

    if (runResult.status === "ok") {
      scheduledJob.state.consecutiveErrors = 0;
      scheduledJob.state.lastError = undefined;
      scheduledJob.state.nextRunAtMs = Date.now() + scheduledJob.intervalMs;

      this.hooks.emit("cron:completed", { agentName, job, result: runResult });
      this.log.info(`Cron run OK: ${stateKey} (${runResult.durationMs}ms, $${runResult.costUsd?.toFixed(4) ?? "?"})`);
    } else {
      scheduledJob.state.consecutiveErrors += 1;
      scheduledJob.state.lastError = runResult.error;

      // Apply backoff — delay next run based on consecutive errors
      const backoff = getBackoffDelay(scheduledJob.state.consecutiveErrors);
      scheduledJob.state.nextRunAtMs = Date.now() + scheduledJob.intervalMs + backoff;

      this.hooks.emit("cron:failed", {
        agentName,
        job,
        result: runResult,
        consecutiveErrors: scheduledJob.state.consecutiveErrors,
      });
      this.log.warn(
        `Cron run FAILED: ${stateKey} (errors: ${scheduledJob.state.consecutiveErrors}, ` +
        `backoff: ${Math.round(backoff / 1000)}s, error: ${runResult.error?.slice(0, 200)})`,
      );
    }

    // Deliver output if configured
    if (runResult.status === "ok" && runResult.result) {
      await this.deliverResult(agentName, job, runResult.result);
    }

    // Persist state after each run
    await this.persistState();
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
    // Named session: use a persistent AgentProcess conversation keyed by session name.
    // The session name is extracted from "session:<name>".
    const sessionName = sessionTarget.slice("session:".length);

    const process = this.cronRunner.getOrSpawnNamedSession(agentName, sessionName);
    if (!process) {
      return { status: "error", error: `Agent "${agentName}" not found`, durationMs: Date.now() - startMs };
    }

    // Wait for the process to be idle before sending
    const state = process.getState();
    if (state === "busy") {
      return { status: "skipped", durationMs: Date.now() - startMs };
    }

    // Send the prompt and wait for the response
    return new Promise<CronRunResult>((resolve) => {
      let resolved = false;

      const onResponse = (text: string) => {
        if (resolved) return;
        resolved = true;
        cleanup();
        resolve({
          status: "ok",
          result: text,
          durationMs: Date.now() - startMs,
        });
      };

      const onTurnComplete = (event: AgentEvent) => {
        // If response handler already fired, this is a no-op.
        // If not (empty response), resolve as ok with no result.
        if (resolved) return;
        resolved = true;
        cleanup();
        const cost = "total_cost_usd" in event ? (event.total_cost_usd as number) : undefined;
        resolve({
          status: "ok",
          costUsd: cost,
          durationMs: Date.now() - startMs,
        });
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
    const delivery = job.delivery ?? { mode: "none" };

    if (delivery.mode === "none") return;

    if (delivery.mode === "announce") {
      const accountId = this.agentManager.getAccountForAgent(agentName);
      if (!accountId) {
        this.log.warn(`Cannot deliver cron result for ${agentName}: no Telegram account found`);
        return;
      }

      try {
        await this.telegram.sendText(accountId, delivery.chatId, resultText);
        this.log.debug(`Cron result delivered to Telegram chat ${delivery.chatId}`);
      } catch (err) {
        this.log.warn(`Cron delivery failed for ${job.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // --- State persistence ---

  private async persistState(): Promise<void> {
    const state: Record<string, CronJobState> = {};
    for (const [key, sj] of this.jobs) {
      state[key] = sj.state;
    }
    try {
      await saveState(this.flowclawHome, state);
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
      this.log.info(`  ${key}: "${sj.job.name}" every ${sj.job.schedule.interval} (next in ${nextIn})`);
    }
  }
}
