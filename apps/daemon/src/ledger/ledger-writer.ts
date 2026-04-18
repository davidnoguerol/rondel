/**
 * Ledger writer.
 *
 * Subscribes to RondelHooks and appends structured JSONL events to
 * per-agent ledger files at state/ledger/{agentName}.jsonl.
 *
 * All writes are fire-and-forget — ledger failures never block
 * or crash the emitting module. Same pattern as transcripts.
 */

import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { RondelHooks } from "../shared/hooks.js";
import { describeSchedule } from "../scheduling/parse-schedule.js";
import type { LedgerEvent, ToolCallDetail } from "./ledger-types.js";

// ---------------------------------------------------------------------------
// Truncation limits (summaries, not full content)
// ---------------------------------------------------------------------------

const USER_MESSAGE_MAX = 100;
const AGENT_RESPONSE_MAX = 100;
const INTER_AGENT_MAX = 80;
const GENERAL_MAX = 80;

// ---------------------------------------------------------------------------
// LedgerWriter
// ---------------------------------------------------------------------------

export class LedgerWriter {
  private readonly ledgerDir: string;
  private dirEnsured = false;
  private readonly appendedListeners = new Set<(event: LedgerEvent) => void>();

  constructor(stateDir: string, hooks: RondelHooks) {
    this.ledgerDir = join(stateDir, "ledger");
    this.wireHooks(hooks);
  }

  // -------------------------------------------------------------------------
  // Subscription registry — live in-process consumers (SSE stream sources)
  // -------------------------------------------------------------------------

  /**
   * Subscribe to ledger appends. The callback is invoked synchronously
   * when each event is constructed, BEFORE (and independently of) the
   * disk write. Subscribers see events at emit time so they don't pay
   * disk latency, matching the same fire-and-forget contract the disk
   * write itself uses.
   *
   * Listener errors are swallowed per the hooks convention — a broken
   * listener must never crash the emitter and must not prevent other
   * listeners from running. Same shape as the disk write's empty
   * `.catch(() => {})` below.
   *
   * Returns an unsubscribe function.
   */
  onAppended(cb: (event: LedgerEvent) => void): () => void {
    this.appendedListeners.add(cb);
    return () => {
      this.appendedListeners.delete(cb);
    };
  }

  // -------------------------------------------------------------------------
  // Core append
  // -------------------------------------------------------------------------

  private append(event: LedgerEvent): void {
    // 1. Notify in-process listeners synchronously (fire-and-forget).
    //    Done before the disk write so subscribers never wait on fs latency.
    for (const cb of this.appendedListeners) {
      try {
        cb(event);
      } catch {
        // Swallow per the hooks convention. Same pattern as the disk
        // write's empty .catch() below — broken listeners must not
        // crash the emitter or block other listeners.
      }
    }

    // 2. Persist (fire-and-forget).
    const line = JSON.stringify(event) + "\n";
    const filePath = join(this.ledgerDir, `${event.agent}.jsonl`);
    this.ensureDir()
      .then(() => appendFile(filePath, line))
      .catch(() => {});
  }

  private async ensureDir(): Promise<void> {
    if (this.dirEnsured) return;
    await mkdir(this.ledgerDir, { recursive: true });
    this.dirEnsured = true;
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private truncate(text: string, max: number): string {
    return text.length > max ? text.slice(0, max) + "..." : text;
  }

  private now(): string {
    return new Date().toISOString();
  }

  // -------------------------------------------------------------------------
  // Hook wiring
  // -------------------------------------------------------------------------

  private wireHooks(hooks: RondelHooks): void {
    // --- User messages ---
    hooks.on("conversation:message_in", ({ agentName, channelType, chatId, text, senderId, senderName }) => {
      this.append({
        ts: this.now(),
        agent: agentName,
        kind: "user_message",
        channelType,
        chatId,
        summary: this.truncate(text, USER_MESSAGE_MAX),
        detail: { senderId, senderName },
      });
    });

    // --- Agent responses (per text block — block streaming) ---
    hooks.on("conversation:response", ({ agentName, channelType, chatId, text }) => {
      this.append({
        ts: this.now(),
        agent: agentName,
        kind: "agent_response",
        channelType,
        chatId,
        summary: this.truncate(text, AGENT_RESPONSE_MAX),
      });
    });

    // --- Inter-agent: sent (on sender's ledger) ---
    hooks.on("message:sent", ({ message }) => {
      this.append({
        ts: this.now(),
        agent: message.from,
        kind: "inter_agent_sent",
        summary: `→ ${message.to}: ${this.truncate(message.content, INTER_AGENT_MAX)}`,
        detail: { to: message.to, messageId: message.id },
      });
    });

    // --- Inter-agent: delivered (on recipient's ledger) ---
    hooks.on("message:delivered", ({ message }) => {
      this.append({
        ts: this.now(),
        agent: message.to,
        kind: "inter_agent_received",
        summary: `← ${message.from}: ${this.truncate(message.content, INTER_AGENT_MAX)}`,
        detail: { from: message.from, messageId: message.id },
      });
    });

    // --- Inter-agent: reply routed back to original sender ---
    hooks.on("message:reply", ({ inReplyTo, from, to, content }) => {
      this.append({
        ts: this.now(),
        agent: to, // original sender receives the reply
        kind: "inter_agent_received",
        summary: `← reply from ${from}: ${this.truncate(content, INTER_AGENT_MAX)}`,
        detail: { from, inReplyTo },
      });
    });

    // --- Subagent lifecycle ---
    hooks.on("subagent:spawning", ({ parentAgentName, parentChatId, task, template }) => {
      this.append({
        ts: this.now(),
        agent: parentAgentName,
        kind: "subagent_spawned",
        chatId: parentChatId,
        summary: `Spawned ${template ?? "subagent"}: ${this.truncate(task, GENERAL_MAX)}`,
      });
    });

    hooks.on("subagent:completed", ({ info }) => {
      const cost = info.costUsd !== undefined ? ` ($${info.costUsd.toFixed(4)})` : "";
      this.append({
        ts: this.now(),
        agent: info.parentAgentName,
        kind: "subagent_result",
        chatId: info.parentChatId,
        summary: `Subagent completed${cost}`,
        detail: { subagentId: info.id, state: info.state, costUsd: info.costUsd },
      });
    });

    hooks.on("subagent:failed", ({ info }) => {
      this.append({
        ts: this.now(),
        agent: info.parentAgentName,
        kind: "subagent_result",
        chatId: info.parentChatId,
        summary: `Subagent ${info.state}: ${this.truncate(info.error ?? "unknown", GENERAL_MAX)}`,
        detail: { subagentId: info.id, state: info.state },
      });
    });

    // --- Cron lifecycle ---
    hooks.on("cron:completed", ({ agentName, job, result }) => {
      this.append({
        ts: this.now(),
        agent: agentName,
        kind: "cron_completed",
        summary: `Cron "${job.name}" completed in ${result.durationMs}ms`,
        detail: { jobId: job.id, durationMs: result.durationMs, costUsd: result.costUsd },
      });
    });

    hooks.on("cron:failed", ({ agentName, job, result, consecutiveErrors }) => {
      this.append({
        ts: this.now(),
        agent: agentName,
        kind: "cron_failed",
        summary: `Cron "${job.name}" failed (${consecutiveErrors}x): ${this.truncate(result.error ?? "unknown", GENERAL_MAX)}`,
        detail: { jobId: job.id, consecutiveErrors },
      });
    });

    // --- Session lifecycle ---
    hooks.on("session:start", ({ agentName, channelType, chatId, sessionId }) => {
      this.append({
        ts: this.now(),
        agent: agentName,
        kind: "session_start",
        channelType,
        chatId,
        summary: `New session ${sessionId.slice(0, 8)}`,
        detail: { sessionId },
      });
    });

    hooks.on("session:resumed", ({ agentName, channelType, chatId, sessionId }) => {
      this.append({
        ts: this.now(),
        agent: agentName,
        kind: "session_resumed",
        channelType,
        chatId,
        summary: `Resumed session ${sessionId.slice(0, 8)}`,
        detail: { sessionId },
      });
    });

    hooks.on("session:reset", ({ agentName, channelType, chatId }) => {
      this.append({
        ts: this.now(),
        agent: agentName,
        kind: "session_reset",
        channelType,
        chatId,
        summary: "Session reset by user",
      });
    });

    hooks.on("session:crash", ({ agentName, channelType, chatId, sessionId }) => {
      this.append({
        ts: this.now(),
        agent: agentName,
        kind: "crash",
        channelType,
        chatId,
        summary: `Process crashed (session ${sessionId.slice(0, 8)})`,
        detail: { sessionId },
      });
    });

    hooks.on("session:halt", ({ agentName, channelType, chatId, sessionId }) => {
      this.append({
        ts: this.now(),
        agent: agentName,
        kind: "halt",
        channelType,
        chatId,
        summary: `Process halted — too many crashes (session ${sessionId.slice(0, 8)})`,
        detail: { sessionId },
      });
    });

    // --- HITL approvals ---
    hooks.on("approval:requested", ({ record }) => {
      this.append({
        ts: this.now(),
        agent: record.agentName,
        kind: "approval_request",
        channelType: record.channelType,
        chatId: record.chatId,
        summary: `Approval requested: ${record.toolName} — ${record.reason}`,
        detail: {
          requestId: record.requestId,
          toolName: record.toolName,
          reason: record.reason,
          summary: record.summary,
        },
      });
    });

    hooks.on("approval:resolved", ({ record }) => {
      this.append({
        ts: this.now(),
        agent: record.agentName,
        kind: "approval_decision",
        channelType: record.channelType,
        chatId: record.chatId,
        summary: `${record.decision ?? "unknown"}: ${record.toolName} (by ${record.resolvedBy ?? "unknown"})`,
        detail: {
          requestId: record.requestId,
          decision: record.decision,
          resolvedBy: record.resolvedBy,
          reason: record.reason,
        },
      });
    });

    // --- Runtime schedule lifecycle ---
    hooks.on("schedule:created", ({ job }) => {
      if (!job.owner) return;
      this.append({
        ts: this.now(),
        agent: job.owner,
        kind: "schedule_created",
        summary: `Schedule "${job.name}" created (${describeSchedule(job)})`,
        detail: {
          scheduleId: job.id,
          scheduleKind: job.schedule.kind,
          deleteAfterRun: job.deleteAfterRun ?? false,
        },
      });
    });

    hooks.on("schedule:updated", ({ job }) => {
      if (!job.owner) return;
      this.append({
        ts: this.now(),
        agent: job.owner,
        kind: "schedule_updated",
        summary: `Schedule "${job.name}" updated (${describeSchedule(job)})`,
        detail: { scheduleId: job.id, scheduleKind: job.schedule.kind },
      });
    });

    hooks.on("schedule:deleted", ({ job, reason }) => {
      if (!job.owner) return;
      this.append({
        ts: this.now(),
        agent: job.owner,
        kind: "schedule_deleted",
        summary: `Schedule "${job.name}" removed (${reason})`,
        detail: { scheduleId: job.id, reason },
      });
    });

    // --- Schedule watchdog (silent-failure detection) ---
    hooks.on("schedule:overdue", (event) => {
      const overdueSec = Math.round(event.overdueByMs / 1000);
      this.append({
        ts: this.now(),
        agent: event.agentName,
        kind: "schedule_overdue",
        summary:
          event.reason === "stuck_in_backoff"
            ? `Schedule "${event.jobName}" stuck in backoff (${event.consecutiveErrors} errors)`
            : event.reason === "never_fired"
            ? `Schedule "${event.jobName}" has never fired (overdue ${overdueSec}s)`
            : `Schedule "${event.jobName}" overdue by ${overdueSec}s (timer drift)`,
        detail: {
          scheduleId: event.jobId,
          reason: event.reason,
          expectedAtMs: event.expectedAtMs,
          overdueByMs: event.overdueByMs,
          consecutiveErrors: event.consecutiveErrors,
        },
      });
    });

    hooks.on("schedule:recovered", (event) => {
      const overdueSec = Math.round(event.wasOverdueForMs / 1000);
      this.append({
        ts: this.now(),
        agent: event.agentName,
        kind: "schedule_recovered",
        summary: `Schedule "${event.jobName}" recovered (was overdue ${overdueSec}s, ${event.previousReason})`,
        detail: {
          scheduleId: event.jobId,
          wasOverdueForMs: event.wasOverdueForMs,
          previousReason: event.previousReason,
        },
      });
    });

    // --- First-class Rondel tool calls (rondel_bash, and Phase 3's filesystem suite) ---
    hooks.on("tool:call", (event) => {
      const detail: ToolCallDetail = {
        toolName: event.toolName,
        outcome: event.outcome,
        durationMs: event.durationMs,
        exitCode: event.exitCode,
        error: event.error,
      };
      this.append({
        ts: this.now(),
        agent: event.agentName,
        kind: "tool_call",
        channelType: event.channelType,
        chatId: event.chatId,
        summary: this.truncate(
          `Tool ${event.toolName}: ${event.summary} (${event.outcome})`,
          GENERAL_MAX,
        ),
        detail,
      });
    });
  }
}
