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
import type { LedgerEvent } from "./ledger-types.js";

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

    // --- Workflow engine (Layer 4 v0) ---
    //
    // Workflow events are keyed to the originator agent — the agent whose
    // conversation triggered the run. This co-locates workflow history
    // with the triggering conversation's other events, same precedent
    // subagent and cron use.

    hooks.on("workflow:started", ({ run }) => {
      this.append({
        ts: this.now(),
        agent: run.originator.agent,
        kind: "workflow_started",
        channelType: run.originator.channelType,
        chatId: run.originator.chatId,
        summary: `Workflow "${run.workflowId}" started (${run.runId})`,
        detail: { runId: run.runId, workflowId: run.workflowId, version: run.workflowVersion },
      });
    });

    hooks.on("workflow:step_started", ({ runId, originator, stepState }) => {
      this.append({
        ts: this.now(),
        agent: originator.agent,
        kind: "workflow_step_started",
        channelType: originator.channelType,
        chatId: originator.chatId,
        summary: `Step "${stepState.stepId}" started (${stepState.kind})`,
        detail: {
          runId,
          stepKey: stepState.stepKey,
          stepId: stepState.stepId,
          kind: stepState.kind,
          attempt: stepState.attempt,
        },
      });
    });

    hooks.on("workflow:step_completed", ({ runId, originator, stepState }) => {
      const summaryText = stepState.summary
        ? `Step "${stepState.stepId}" completed: ${this.truncate(stepState.summary, GENERAL_MAX)}`
        : `Step "${stepState.stepId}" completed`;
      this.append({
        ts: this.now(),
        agent: originator.agent,
        kind: "workflow_step_completed",
        channelType: originator.channelType,
        chatId: originator.chatId,
        summary: summaryText,
        detail: {
          runId,
          stepKey: stepState.stepKey,
          stepId: stepState.stepId,
          kind: stepState.kind,
          attempt: stepState.attempt,
          outputArtifact: stepState.outputArtifact,
        },
      });
    });

    hooks.on("workflow:step_failed", ({ runId, originator, stepState }) => {
      const reason = stepState.failReason ?? stepState.summary ?? "unknown";
      this.append({
        ts: this.now(),
        agent: originator.agent,
        kind: "workflow_step_failed",
        channelType: originator.channelType,
        chatId: originator.chatId,
        summary: `Step "${stepState.stepId}" failed: ${this.truncate(reason, GENERAL_MAX)}`,
        detail: {
          runId,
          stepKey: stepState.stepKey,
          stepId: stepState.stepId,
          kind: stepState.kind,
          attempt: stepState.attempt,
          failReason: stepState.failReason,
        },
      });
    });

    hooks.on("workflow:gate_waiting", ({ runId, originator, gate }) => {
      this.append({
        ts: this.now(),
        agent: originator.agent,
        kind: "workflow_gate_waiting",
        channelType: originator.channelType,
        chatId: originator.chatId,
        summary: `Gate "${gate.stepKey}" waiting for human decision`,
        detail: {
          runId,
          gateId: gate.gateId,
          stepKey: gate.stepKey,
          notifiedAgent: gate.notifiedAgent,
          notifiedChannelType: gate.notifiedChannelType,
        },
      });
    });

    hooks.on("workflow:gate_resolved", ({ runId, originator, gate }) => {
      const noteSuffix = gate.note ? ` (${this.truncate(gate.note, 40)})` : "";
      this.append({
        ts: this.now(),
        agent: originator.agent,
        kind: "workflow_gate_resolved",
        channelType: originator.channelType,
        chatId: originator.chatId,
        summary: `Gate "${gate.stepKey}" ${gate.decision} by ${gate.decidedBy ?? "system"}${noteSuffix}`,
        detail: {
          runId,
          gateId: gate.gateId,
          decision: gate.decision,
          decidedBy: gate.decidedBy,
        },
      });
    });

    hooks.on("workflow:completed", ({ runId, originator, workflowId }) => {
      this.append({
        ts: this.now(),
        agent: originator.agent,
        kind: "workflow_completed",
        channelType: originator.channelType,
        chatId: originator.chatId,
        summary: `Workflow "${workflowId}" completed (${runId})`,
        detail: { runId, workflowId },
      });
    });

    hooks.on("workflow:failed", ({ runId, originator, workflowId, reason }) => {
      this.append({
        ts: this.now(),
        agent: originator.agent,
        kind: "workflow_failed",
        channelType: originator.channelType,
        chatId: originator.chatId,
        summary: `Workflow "${workflowId}" failed: ${this.truncate(reason, GENERAL_MAX)}`,
        detail: { runId, workflowId, reason },
      });
    });

    hooks.on("workflow:resumed", ({ runId, originator }) => {
      this.append({
        ts: this.now(),
        agent: originator.agent,
        kind: "workflow_resumed",
        channelType: originator.channelType,
        chatId: originator.chatId,
        summary: `Workflow resumed (${runId})`,
        detail: { runId },
      });
    });

    hooks.on("workflow:interrupted", ({ runId, originator, reason }) => {
      this.append({
        ts: this.now(),
        agent: originator.agent,
        kind: "workflow_interrupted",
        channelType: originator.channelType,
        chatId: originator.chatId,
        summary: `Workflow interrupted: ${this.truncate(reason, GENERAL_MAX)}`,
        detail: { runId, reason },
      });
    });
  }
}
