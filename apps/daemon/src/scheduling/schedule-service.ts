/**
 * ScheduleService — business logic for runtime-managed cron schedules.
 *
 * Sits between the bridge HTTP endpoints / MCP tools and the low-level
 * `ScheduleStore` + `Scheduler`. It owns validation, ID generation,
 * permission gating (self-only vs admin, cross-org rejection), delivery
 * defaulting from the caller's active conversation, hook emission, and
 * `deleteAfterRun` bookkeeping.
 *
 * Modelled on `ApprovalService` — file-based state, hook-emitting, no DB.
 */

import { randomBytes } from "node:crypto";
import { parseSchedule } from "./parse-schedule.js";
import type { ScheduleStore } from "./schedule-store.js";
import type { RondelHooks } from "../shared/hooks.js";
import type { Logger } from "../shared/logger.js";
import type { CronJob, CronDelivery, CronRunStatus, CronSchedule, CronSessionTarget } from "../shared/types/index.js";
import { checkOrgIsolation, type OrgLookup } from "../shared/org-isolation.js";

// ---------------------------------------------------------------------------
// Caller context
// ---------------------------------------------------------------------------

/**
 * Identity + active-conversation info for the agent calling a schedule
 * tool. Populated from MCP env vars at the bridge boundary.
 *
 * TODO(security): these fields arrive from the HTTP request body and are
 * trusted as-is. The orchestrator injects the underlying identity into
 * each MCP server process's env, but the bridge never verifies that the
 * identity in the request matches the process that sent it. An agent
 * with rondel_bash can curl the bridge directly and claim any agentName
 * / isAdmin combination — meaning the self-vs-admin and cross-org checks
 * below only hold against well-behaved callers, not adversarial ones.
 * The same pre-existing gap applies to the /admin/* endpoints. The
 * threat model is single-user, same-machine, so this is a known
 * limitation; a future pass should move identity resolution
 * server-side so the bridge derives it from something the calling
 * process can't forge. See the matching notes in bridge.ts.
 */
export interface ScheduleCaller {
  readonly agentName: string;
  readonly isAdmin: boolean;
  /** Channel metadata of the conversation the caller is in, used to default delivery. */
  readonly channelType?: string;
  readonly accountId?: string;
  readonly chatId?: string;
}

// ---------------------------------------------------------------------------
// Scheduler control surface
// ---------------------------------------------------------------------------

/**
 * Narrow interface the service uses to push runtime changes into the
 * live scheduler. The Scheduler class implements this; tests can stub it
 * without spinning up timers.
 */
export interface SchedulerControl {
  /**
   * Insert-or-update a runtime job and (re)arm the timer.
   *
   * When an existing job is being updated, callers pass `rearmTiming:
   * false` to signal "the schedule or enabled flag didn't change — keep
   * the current nextRunAtMs". Without this hint, every prompt-only edit
   * on a 1h-interval job would reset its next fire time to now+1h.
   */
  upsertRuntimeJob(job: CronJob, options?: { rearmTiming?: boolean }): void;
  /** Drop a runtime job from the in-memory map. Idempotent. */
  removeRuntimeJob(id: string): void;
  /** Fire a job immediately, bypassing nextRunAtMs. Returns true if found. */
  triggerNow(id: string): Promise<boolean>;
  /** For list responses: peek at scheduler state (nextRun, lastRun, etc.). */
  getJobStateSnapshot(id: string):
    | { nextRunAtMs?: number; lastRunAtMs?: number; lastStatus?: CronRunStatus; consecutiveErrors: number }
    | undefined;
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface ScheduleServiceDeps {
  readonly store: ScheduleStore;
  readonly scheduler: SchedulerControl;
  readonly hooks: RondelHooks;
  readonly log: Logger;
  readonly orgLookup: OrgLookup;
  /** Known agent names — used to reject delivery/targeting for non-existent agents. */
  readonly isKnownAgent: (agentName: string) => boolean;
}

// ---------------------------------------------------------------------------
// Public errors
// ---------------------------------------------------------------------------

export type ScheduleErrorCode =
  | "validation"
  | "not_found"
  | "forbidden"
  | "cross_org"
  | "unknown_agent";

export class ScheduleError extends Error {
  constructor(public readonly code: ScheduleErrorCode, message: string) {
    super(message);
    this.name = "ScheduleError";
  }
}

// ---------------------------------------------------------------------------
// Input shapes
// ---------------------------------------------------------------------------

export interface CreateScheduleInput {
  readonly name: string;
  readonly schedule: CronSchedule;
  readonly prompt: string;
  readonly delivery?: CronDelivery;
  readonly sessionTarget?: CronSessionTarget;
  readonly model?: string;
  readonly timeoutMs?: number;
  readonly deleteAfterRun?: boolean;
  readonly enabled?: boolean;
  /** Optional target agent (admin only). Defaults to caller.agentName. */
  readonly targetAgent?: string;
}

export interface UpdateScheduleInput {
  readonly name?: string;
  readonly schedule?: CronSchedule;
  readonly prompt?: string;
  readonly delivery?: CronDelivery;
  readonly sessionTarget?: CronSessionTarget;
  /**
   * Model override. `undefined` = don't touch the current value;
   * explicit `null` = clear the override and fall back to the agent's
   * default model. Nullable at this layer so the update surface can
   * distinguish "leave alone" from "remove".
   */
  readonly model?: string | null;
  readonly timeoutMs?: number;
  readonly deleteAfterRun?: boolean;
  readonly enabled?: boolean;
}

export interface ScheduleSummary {
  readonly id: string;
  readonly name: string;
  readonly owner?: string;
  readonly enabled: boolean;
  readonly schedule: CronSchedule;
  readonly prompt: string;
  readonly delivery?: CronDelivery;
  readonly sessionTarget: CronSessionTarget;
  readonly deleteAfterRun?: boolean;
  readonly model?: string;
  readonly timeoutMs?: number;
  readonly source: "declarative" | "runtime";
  readonly createdAtMs?: number;
  readonly nextRunAtMs?: number;
  readonly lastRunAtMs?: number;
  readonly lastStatus?: CronRunStatus;
  readonly consecutiveErrors?: number;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class ScheduleService {
  private readonly log: Logger;

  constructor(private readonly deps: ScheduleServiceDeps) {
    this.log = deps.log.child("schedules");
  }

  /**
   * Create a new runtime schedule. Default delivery is routed back to the
   * caller's active conversation so "remind me at 8am" works without the
   * caller having to thread chat-ids through the prompt.
   */
  async create(caller: ScheduleCaller, input: CreateScheduleInput): Promise<ScheduleSummary> {
    const targetAgent = this.resolveTargetAgent(caller, input.targetAgent);
    this.assertAgentExists(targetAgent);
    this.assertOrgAllowed(caller.agentName, targetAgent);

    const parsed = parseSchedule(input.schedule);  // throws on malformed
    const normalizedSchedule = parsed.normalized;

    const delivery = this.resolveDelivery(caller, input.delivery);

    const now = Date.now();
    const job: CronJob = {
      id: newScheduleId(),
      name: input.name.trim(),
      enabled: input.enabled ?? true,
      deleteAfterRun: input.deleteAfterRun ?? parsed.isOneShot,
      schedule: normalizedSchedule,
      prompt: input.prompt,
      sessionTarget: input.sessionTarget ?? "isolated",
      delivery,
      model: input.model,
      timeoutMs: input.timeoutMs,
      source: "runtime",
      owner: targetAgent,
      createdAtMs: now,
    };

    await this.deps.store.add(job);
    this.deps.scheduler.upsertRuntimeJob(job);
    this.deps.hooks.emit("schedule:created", { job });
    this.log.info(`Schedule created: ${job.id} (${targetAgent}, ${job.schedule.kind}) — "${job.name}"`);

    return this.summarize(job);
  }

  /**
   * List schedules visible to the caller. Non-admin callers see only their
   * own schedules. Admin callers may pass `targetAgent` to list another
   * agent's; same-org rule applies to admin.
   */
  list(
    caller: ScheduleCaller,
    opts: { targetAgent?: string; includeDisabled?: boolean } = {},
  ): readonly ScheduleSummary[] {
    const targetAgent = this.resolveTargetAgent(caller, opts.targetAgent);
    this.assertAgentExists(targetAgent);
    this.assertOrgAllowed(caller.agentName, targetAgent);

    const jobs = this.deps.store.getByAgent(targetAgent);
    const filtered = opts.includeDisabled ? jobs : jobs.filter((j) => j.enabled !== false);
    return filtered.map((j) => this.summarize(j));
  }

  /** Fetch a single schedule by id, applying the same permission rules as list. */
  get(caller: ScheduleCaller, scheduleId: string): ScheduleSummary {
    const job = this.deps.store.getById(scheduleId);
    if (!job || !job.owner) throw new ScheduleError("not_found", `Schedule not found: ${scheduleId}`);
    this.assertCanManage(caller, job.owner);
    return this.summarize(job);
  }

  async update(
    caller: ScheduleCaller,
    scheduleId: string,
    patch: UpdateScheduleInput,
  ): Promise<ScheduleSummary> {
    const existing = this.deps.store.getById(scheduleId);
    if (!existing || !existing.owner) throw new ScheduleError("not_found", `Schedule not found: ${scheduleId}`);
    this.assertCanManage(caller, existing.owner);

    // Run the schedule through the parser to validate it — even if the
    // caller didn't change it (keeps validation in one place).
    const nextSchedule = patch.schedule ?? existing.schedule;
    const parsed = parseSchedule(nextSchedule);
    const normalizedSchedule = parsed.normalized;

    // Did the schedule or enabled flag change? If not, the scheduler
    // should KEEP its current nextRunAtMs — otherwise an innocent prompt
    // edit shifts a 1h-interval job's next fire time. The scheduler sees
    // this via the upsertRuntimeJob path, which compares definitions.
    const scheduleChanged = !schedulesEqual(normalizedSchedule, existing.schedule);
    const enabledChanged = (patch.enabled ?? existing.enabled ?? true) !== (existing.enabled ?? true);
    const timingChanged = scheduleChanged || enabledChanged;

    const merged: CronJob = {
      ...existing,
      name: patch.name?.trim() ?? existing.name,
      enabled: patch.enabled ?? existing.enabled,
      deleteAfterRun: patch.deleteAfterRun ?? existing.deleteAfterRun,
      schedule: normalizedSchedule,
      prompt: patch.prompt ?? existing.prompt,
      sessionTarget: patch.sessionTarget ?? existing.sessionTarget,
      delivery: patch.delivery ?? existing.delivery,
      // Model is tri-state: undefined (don't touch), null (clear), string (set).
      model: patch.model === undefined ? existing.model : patch.model === null ? undefined : patch.model,
      timeoutMs: patch.timeoutMs ?? existing.timeoutMs,
    };

    const updated = await this.deps.store.update(scheduleId, merged);
    if (!updated) throw new ScheduleError("not_found", `Schedule not found: ${scheduleId}`);

    this.deps.scheduler.upsertRuntimeJob(updated, { rearmTiming: timingChanged });
    this.deps.hooks.emit("schedule:updated", { job: updated });
    this.log.info(`Schedule updated: ${updated.id} (${updated.owner})`);

    return this.summarize(updated);
  }

  async remove(caller: ScheduleCaller, scheduleId: string): Promise<void> {
    const existing = this.deps.store.getById(scheduleId);
    if (!existing || !existing.owner) throw new ScheduleError("not_found", `Schedule not found: ${scheduleId}`);
    this.assertCanManage(caller, existing.owner);

    const removed = await this.deps.store.remove(scheduleId);
    if (!removed) return;

    this.deps.scheduler.removeRuntimeJob(scheduleId);
    this.deps.hooks.emit("schedule:deleted", { job: existing, reason: "requested" });
    this.log.info(`Schedule deleted: ${scheduleId} (${existing.owner})`);
  }

  async runNow(caller: ScheduleCaller, scheduleId: string): Promise<void> {
    const existing = this.deps.store.getById(scheduleId);
    if (!existing || !existing.owner) throw new ScheduleError("not_found", `Schedule not found: ${scheduleId}`);
    this.assertCanManage(caller, existing.owner);

    // The scheduler is the source of truth for which schedules are
    // currently armed. If the store has a job that the scheduler doesn't,
    // that's a real invariant violation (something wedged `upsertRuntimeJob`
    // on create/update), not a transient condition we should paper over.
    // Fail loudly so a bug in the wiring is visible instead of silently
    // working on the second attempt.
    const triggered = await this.deps.scheduler.triggerNow(scheduleId);
    if (!triggered) {
      this.log.error(
        `runNow: scheduler missing ${scheduleId} that exists in store — state drift, check upsertRuntimeJob wiring`,
      );
      throw new ScheduleError(
        "not_found",
        `Schedule ${scheduleId} is in the store but not active in the scheduler (state drift)`,
      );
    }
  }

  /**
   * Remove all schedules owned by an agent. Called from the agent-delete
   * admin flow before the agent directory is removed on disk.
   *
   * Note: one-shot auto-delete is handled by the Scheduler itself (see
   * `Scheduler.autoDelete`) because the scheduler is the only thing that
   * knows when a run has actually completed successfully. The service
   * doesn't sit in that path — adding a round-trip through here would
   * only duplicate the bookkeeping.
   */
  async purgeForAgent(agentName: string): Promise<number> {
    const removed = await this.deps.store.purgeByAgent(agentName);
    for (const id of removed) {
      this.deps.scheduler.removeRuntimeJob(id);
    }
    if (removed.length > 0) {
      this.log.info(`Purged ${removed.length} schedule(s) owned by ${agentName}`);
    }
    return removed.length;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private resolveTargetAgent(caller: ScheduleCaller, explicit?: string): string {
    if (!explicit || explicit === caller.agentName) return caller.agentName;
    if (!caller.isAdmin) {
      throw new ScheduleError(
        "forbidden",
        `Only admin agents may target other agents (caller: ${caller.agentName}, target: ${explicit})`,
      );
    }
    return explicit;
  }

  private assertCanManage(caller: ScheduleCaller, ownerAgent: string): void {
    this.assertAgentExists(ownerAgent);
    if (ownerAgent === caller.agentName) {
      this.assertOrgAllowed(caller.agentName, ownerAgent);
      return;
    }
    if (!caller.isAdmin) {
      throw new ScheduleError(
        "forbidden",
        `Only admin agents may manage schedules belonging to other agents`,
      );
    }
    this.assertOrgAllowed(caller.agentName, ownerAgent);
  }

  private assertAgentExists(agentName: string): void {
    if (!this.deps.isKnownAgent(agentName)) {
      throw new ScheduleError("unknown_agent", `Unknown agent: ${agentName}`);
    }
  }

  private assertOrgAllowed(fromAgent: string, toAgent: string): void {
    const err = checkOrgIsolation(this.deps.orgLookup, fromAgent, toAgent);
    if (err !== null) {
      // Map the isolation module's own "unknown agent" and cross-org
      // messages to our error codes so HTTP responses stay consistent.
      if (err.startsWith("Unknown agent")) {
        throw new ScheduleError("unknown_agent", err);
      }
      throw new ScheduleError("cross_org", err.replace(/^Cross-org messaging blocked/, "Cross-org schedule blocked"));
    }
  }

  private resolveDelivery(caller: ScheduleCaller, explicit?: CronDelivery): CronDelivery | undefined {
    if (explicit) return explicit;
    // No explicit delivery — default to the caller's current conversation,
    // if any. When the caller has no chat context (e.g. the service is
    // being called from a non-agent code path during tests) leave delivery
    // undefined and the scheduler falls back to no-announce.
    if (!caller.chatId) return undefined;
    return {
      mode: "announce",
      chatId: caller.chatId,
      channelType: caller.channelType,
      accountId: caller.accountId,
    };
  }

  private summarize(job: CronJob): ScheduleSummary {
    return summarizeSchedule(job, this.deps.scheduler.getJobStateSnapshot(job.id));
  }
}

/**
 * Snapshot shape shared by `SchedulerControl.getJobStateSnapshot` and the
 * live-run payload on `schedule:ran`. Extracted as a named type so that
 * pure summarizers and consumers can depend on a single surface.
 */
export interface ScheduleStateSnapshot {
  readonly nextRunAtMs?: number;
  readonly lastRunAtMs?: number;
  readonly lastStatus?: CronRunStatus;
  readonly consecutiveErrors: number;
}

/**
 * Pure, reusable summarizer. Called from both `ScheduleService.summarize`
 * (read endpoints) and `ScheduleStreamSource` (SSE frames) so the on-wire
 * shape stays consistent. Accepts `undefined` for the snapshot — used on
 * the `schedule.deleted` frame, where the scheduler has already dropped
 * the job and only cached fields are available.
 */
export function summarizeSchedule(job: CronJob, snapshot: ScheduleStateSnapshot | undefined): ScheduleSummary {
  return {
    id: job.id,
    name: job.name,
    owner: job.owner,
    enabled: job.enabled !== false,
    schedule: job.schedule,
    prompt: job.prompt,
    delivery: job.delivery,
    sessionTarget: job.sessionTarget ?? "isolated",
    deleteAfterRun: job.deleteAfterRun,
    model: job.model,
    timeoutMs: job.timeoutMs,
    source: job.source ?? "runtime",
    createdAtMs: job.createdAtMs,
    nextRunAtMs: snapshot?.nextRunAtMs,
    lastRunAtMs: snapshot?.lastRunAtMs,
    lastStatus: snapshot?.lastStatus,
    consecutiveErrors: snapshot?.consecutiveErrors,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function newScheduleId(): string {
  const epoch = Math.floor(Date.now() / 1000);
  const rand = randomBytes(4).toString("hex");
  return `sched_${epoch}_${rand}`;
}

/**
 * Structural equality for `CronSchedule`. Used to detect schedule-only
 * updates so the scheduler can keep its existing nextRunAtMs instead of
 * resetting fire time on every prompt edit.
 */
function schedulesEqual(a: CronSchedule, b: CronSchedule): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "every" && b.kind === "every") return a.interval === b.interval;
  if (a.kind === "at" && b.kind === "at") return a.at === b.at;
  if (a.kind === "cron" && b.kind === "cron") {
    return a.expression === b.expression && (a.timezone ?? "") === (b.timezone ?? "");
  }
  return false;
}
