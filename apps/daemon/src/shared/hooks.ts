import { EventEmitter } from "node:events";
import type { SubagentInfo, CronJob, CronJobState, CronRunResult, MessageSentEvent, MessageDeliveredEvent, MessageReplyEvent, ThreadCompletedEvent, ApprovalRecord, HeartbeatRecord } from "./types/index.js";

/**
 * Rondel lifecycle hooks.
 *
 * A typed EventEmitter for cross-cutting concerns. Modules emit events
 * when significant things happen; other modules subscribe to react.
 * This keeps concerns decoupled — the emitter doesn't know or care
 * what the listeners do.
 *
 * Pattern: AgentManager emits "subagent:spawning", Router listens
 * and sends a Telegram notification. AgentManager never imports Router.
 */

// --- Subagent hooks ---

export interface SubagentSpawningEvent {
  readonly id: string;
  readonly parentAgentName: string;
  readonly parentChannelType: string;
  readonly parentAccountId: string;
  readonly parentChatId: string;
  readonly task: string;
}

export interface SubagentCompletedEvent {
  readonly info: SubagentInfo;
}

export interface SubagentFailedEvent {
  readonly info: SubagentInfo;
}

// --- Conversation hooks ---

export interface ConversationMessageInEvent {
  readonly agentName: string;
  readonly channelType: string;
  readonly chatId: string;
  readonly text: string;
  readonly senderId?: string;
  readonly senderName?: string;
}

export interface ConversationResponseEvent {
  readonly agentName: string;
  readonly channelType: string;
  readonly chatId: string;
  readonly text: string;
  /**
   * Optional — present when partial-message streaming is active (the CLI
   * was spawned with `--include-partial-messages`). Matches the blockId
   * used on any preceding `conversation:response_delta` events, allowing
   * consumers to reconcile streamed chunks against the canonical block.
   */
  readonly blockId?: string;
}

/**
 * Emitted for each text chunk streamed from the model. The `blockId`
 * matches the corresponding `conversation:response` event's blockId.
 * Contract: these are HINTS. Consumers that care about correctness must
 * treat the complete `conversation:response` event as the source of truth
 * and use deltas only for UX (e.g. progressive rendering). A dropped
 * delta is not a bug — the block-complete event will always arrive.
 */
export interface ConversationResponseDeltaEvent {
  readonly agentName: string;
  readonly channelType: string;
  readonly chatId: string;
  readonly blockId: string;
  readonly chunk: string;
}

// --- Session lifecycle hooks ---

export interface SessionStartEvent {
  readonly agentName: string;
  readonly channelType: string;
  readonly chatId: string;
  readonly sessionId: string;
}

export interface SessionResumedEvent {
  readonly agentName: string;
  readonly channelType: string;
  readonly chatId: string;
  readonly sessionId: string;
}

export interface SessionResetEvent {
  readonly agentName: string;
  readonly channelType: string;
  readonly chatId: string;
}

export interface SessionCrashEvent {
  readonly agentName: string;
  readonly channelType: string;
  readonly chatId: string;
  readonly sessionId: string;
}

export interface SessionHaltEvent {
  readonly agentName: string;
  readonly channelType: string;
  readonly chatId: string;
  readonly sessionId: string;
}

// --- Cron hooks ---

export interface CronCompletedEvent {
  readonly agentName: string;
  readonly job: CronJob;
  readonly result: CronRunResult;
}

export interface CronFailedEvent {
  readonly agentName: string;
  readonly job: CronJob;
  readonly result: CronRunResult;
  readonly consecutiveErrors: number;
}

// --- Approval hooks (HITL — see apps/daemon/src/approvals/) ---

export interface ApprovalRequestedEvent {
  readonly record: ApprovalRecord;
}

export interface ApprovalResolvedEvent {
  readonly record: ApprovalRecord;
}

// --- Heartbeat hooks (per-agent liveness — see apps/daemon/src/heartbeats/) ---

/**
 * Emitted whenever an agent writes its heartbeat record. Consumed by:
 *  - LedgerWriter (appends a `heartbeat_updated` event)
 *  - HeartbeatStreamSource (fans deltas to SSE clients)
 *
 * The record carries the post-write state, so listeners never need to
 * reach back to disk.
 */
export interface HeartbeatUpdatedEvent {
  readonly record: HeartbeatRecord;
}

// --- Schedule lifecycle hooks (runtime-created crons — see apps/daemon/src/scheduling/) ---

export interface ScheduleCreatedEvent {
  readonly job: CronJob;
}

export interface ScheduleUpdatedEvent {
  readonly job: CronJob;
}

export interface ScheduleDeletedEvent {
  readonly job: CronJob;
  /** Why the schedule was removed: explicit delete, one-shot autodelete, or owner removal. */
  readonly reason: "requested" | "ran_once" | "owner_deleted";
}

/**
 * Emitted when a runtime schedule finishes a run (success or failure).
 *
 * Distinct from `cron:completed` / `cron:failed` which fire for ALL jobs
 * (declarative + runtime) and carry the `CronRunResult` — this event is
 * scoped to the subset of schedules exposed through `ScheduleService` and
 * carries the post-run `CronJobState` instead, giving consumers (the web
 * live stream) everything they need to refresh `lastRunAtMs` /
 * `lastStatus` / `nextRunAtMs` without additional queries.
 */
export interface ScheduleRanEvent {
  readonly job: CronJob;
  readonly state: CronJobState;
}

// --- Schedule watchdog (silent-failure detection — see apps/daemon/src/scheduling/watchdog.ts) ---

/**
 * Why a scheduled job is considered overdue:
 *
 * - `timer_drift`: the job's `nextRunAtMs` is in the past by more than the
 *   grace window, but the job is not in error backoff. Typical cause: OS
 *   sleep pausing Node timers, or armTimer() never firing.
 * - `stuck_in_backoff`: the job has accumulated enough consecutive errors
 *   that it's silently sitting in exponential backoff — from the user's
 *   perspective, it has stopped working.
 * - `never_fired`: the job is registered, `nextRunAtMs` is overdue, and
 *   the scheduler has no record of ever running it. Startup bug indicator.
 */
export type ScheduleOverdueReason = "timer_drift" | "stuck_in_backoff" | "never_fired";

export interface ScheduleOverdueEvent {
  readonly agentName: string;
  readonly jobId: string;
  readonly jobName: string;
  readonly reason: ScheduleOverdueReason;
  /** nextRunAtMs at the time the watchdog noticed (may be undefined for `stuck_in_backoff`). */
  readonly expectedAtMs?: number;
  readonly observedAtMs: number;
  /** How far past `expectedAtMs` we are, in ms. Zero for `stuck_in_backoff` cases without a scheduled fire. */
  readonly overdueByMs: number;
  readonly consecutiveErrors: number;
}

export interface ScheduleRecoveredEvent {
  readonly agentName: string;
  readonly jobId: string;
  readonly jobName: string;
  readonly recoveredAtMs: number;
  readonly wasOverdueForMs: number;
  /** The reason that was active when the job was last flagged overdue. */
  readonly previousReason: ScheduleOverdueReason;
}

// --- Tool-call hooks (first-class Rondel tools — see apps/daemon/src/tools/) ---

/**
 * Emitted when a first-class Rondel tool (rondel_bash, and the filesystem
 * suite in Phase 3) completes — success or error. Consumed by
 * LedgerWriter, which records a `tool_call` ledger event.
 *
 * Not emitted for native Claude tools (Bash/Write/Edit/…) — those go
 * through the PreToolUse safety net and only surface as
 * approval_request/approval_decision ledger events.
 */
export interface ToolCallEvent {
  readonly agentName: string;
  readonly channelType: string;
  readonly chatId: string;
  readonly toolName: string;
  readonly toolInput: unknown;
  /** Short human-readable one-liner — feeds the ledger summary field. */
  readonly summary: string;
  readonly outcome: "success" | "error";
  readonly durationMs: number;
  readonly exitCode?: number;
  /** First 500 chars of stderr / error message on failure paths. */
  readonly error?: string;
}

interface HookEvents {
  // Conversation events (Layer 1 — Ledger)
  "conversation:message_in": [event: ConversationMessageInEvent];
  "conversation:response": [event: ConversationResponseEvent];
  "conversation:response_delta": [event: ConversationResponseDeltaEvent];
  // Session lifecycle (Layer 1 — Ledger)
  "session:start": [event: SessionStartEvent];
  "session:resumed": [event: SessionResumedEvent];
  "session:reset": [event: SessionResetEvent];
  "session:crash": [event: SessionCrashEvent];
  "session:halt": [event: SessionHaltEvent];
  // Subagent lifecycle
  "subagent:spawning": [event: SubagentSpawningEvent];
  "subagent:completed": [event: SubagentCompletedEvent];
  "subagent:failed": [event: SubagentFailedEvent];
  // Cron lifecycle
  "cron:completed": [event: CronCompletedEvent];
  "cron:failed": [event: CronFailedEvent];
  // Inter-agent messaging (Layer 2)
  "message:sent": [event: MessageSentEvent];
  "message:delivered": [event: MessageDeliveredEvent];
  "message:reply": [event: MessageReplyEvent];
  "thread:completed": [event: ThreadCompletedEvent];
  // HITL approvals (Layer 1 — Ledger)
  "approval:requested": [event: ApprovalRequestedEvent];
  "approval:resolved": [event: ApprovalResolvedEvent];
  // Per-agent heartbeats (Layer 1 — Ledger)
  "heartbeat:updated": [event: HeartbeatUpdatedEvent];
  // Runtime schedule lifecycle (Layer 1 — Ledger)
  "schedule:created": [event: ScheduleCreatedEvent];
  "schedule:updated": [event: ScheduleUpdatedEvent];
  "schedule:deleted": [event: ScheduleDeletedEvent];
  "schedule:ran": [event: ScheduleRanEvent];
  // Schedule watchdog (silent-failure detection — Layer 1 — Ledger)
  "schedule:overdue": [event: ScheduleOverdueEvent];
  "schedule:recovered": [event: ScheduleRecoveredEvent];
  // First-class Rondel tools (Layer 1 — Ledger)
  "tool:call": [event: ToolCallEvent];
}

/**
 * EventEmitter with per-listener error boundaries.
 *
 * Node's default emit() stops on the first listener throw, preventing
 * subsequent listeners from running and propagating the error into the
 * emitter (scheduler, subagent-manager). We override emit() to call
 * each listener in its own try/catch — one failure doesn't crash the
 * system or prevent other listeners from running.
 *
 * Uses console.error (not injected logger) because this is a last-resort
 * safety net — if we're catching here, something is already wrong.
 */
export class RondelHooks extends EventEmitter<HookEvents> {
  override emit<K extends keyof HookEvents>(
    eventName: K,
    ...args: HookEvents[K]
  ): boolean {
    const listeners = this.listeners(eventName);
    for (const listener of listeners) {
      try {
        (listener as (...a: unknown[]) => void)(...args);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[RondelHooks] Listener for "${String(eventName)}" threw: ${message}`);
      }
    }
    return listeners.length > 0;
  }
}

/** Single shared instance — created once, passed via dependency injection. */
export function createHooks(): RondelHooks {
  return new RondelHooks();
}
