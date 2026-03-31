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

  constructor(stateDir: string, hooks: RondelHooks) {
    this.ledgerDir = join(stateDir, "ledger");
    this.wireHooks(hooks);
  }

  // -------------------------------------------------------------------------
  // Core append
  // -------------------------------------------------------------------------

  private append(event: LedgerEvent): void {
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
    hooks.on("conversation:message_in", ({ agentName, chatId, text, senderId, senderName }) => {
      this.append({
        ts: this.now(),
        agent: agentName,
        kind: "user_message",
        chatId,
        summary: this.truncate(text, USER_MESSAGE_MAX),
        detail: { senderId, senderName },
      });
    });

    // --- Agent responses (per text block — block streaming) ---
    hooks.on("conversation:response", ({ agentName, chatId, text }) => {
      this.append({
        ts: this.now(),
        agent: agentName,
        kind: "agent_response",
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
    hooks.on("session:start", ({ agentName, chatId, sessionId }) => {
      this.append({
        ts: this.now(),
        agent: agentName,
        kind: "session_start",
        chatId,
        summary: `New session ${sessionId.slice(0, 8)}`,
        detail: { sessionId },
      });
    });

    hooks.on("session:resumed", ({ agentName, chatId, sessionId }) => {
      this.append({
        ts: this.now(),
        agent: agentName,
        kind: "session_resumed",
        chatId,
        summary: `Resumed session ${sessionId.slice(0, 8)}`,
        detail: { sessionId },
      });
    });

    hooks.on("session:reset", ({ agentName, chatId }) => {
      this.append({
        ts: this.now(),
        agent: agentName,
        kind: "session_reset",
        chatId,
        summary: "Session reset by user",
      });
    });

    hooks.on("session:crash", ({ agentName, chatId, sessionId }) => {
      this.append({
        ts: this.now(),
        agent: agentName,
        kind: "crash",
        chatId,
        summary: `Process crashed (session ${sessionId.slice(0, 8)})`,
        detail: { sessionId },
      });
    });

    hooks.on("session:halt", ({ agentName, chatId, sessionId }) => {
      this.append({
        ts: this.now(),
        agent: agentName,
        kind: "halt",
        chatId,
        summary: `Process halted — too many crashes (session ${sessionId.slice(0, 8)})`,
        detail: { sessionId },
      });
    });
  }
}
