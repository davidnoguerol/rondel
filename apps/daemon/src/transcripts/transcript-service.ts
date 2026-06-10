// TranscriptService — business logic for the transcript substrate.
//
// Responsibilities:
//   - Hands out per-session TranscriptRecorders (the ONLY mirror write path;
//     AgentProcess/SubagentProcess call recorder methods, never the store).
//   - Maintains conversation genealogy (ConversationKey → ordered session
//     chain) from `session:established` / `session:reset` hooks. Genealogy
//     appends dedupe on sessionId because claude-wrap re-fires `ready` with
//     the SAME sessionId after a crash-restart.
//   - Archives the CLI's full-fidelity JSONL: immediately on
//     `transcript:session_closed` (process exited; file is final) and via the
//     idempotent daily sweep, which self-heals truncated copies before the
//     CLI's ~30-day prune.
//   - Enforces retention: synthetic sessions (cron/subagent/agent-mail) age
//     out after SYNTHETIC_TTL_MS, mirror + archive together, emitting
//     `transcript:pruned` so derived indexes can drop rows; `main`
//     conversations are durable. Legacy mirrors that can't be classified are
//     treated as durable.
//
// Known, accepted limitations (documented in ARCHITECTURE.md):
//   - pendingReasons is in-memory: a daemon restart between /new and the next
//     message downgrades the genealogy reason to "new". Chains stay correct.
//   - Fire-and-forget appends can be lost on a hard daemon kill — the same
//     exposure the pre-domain writer had; the per-path queue narrows it.

import type { RondelHooks } from "../shared/hooks.js";
import type { Logger } from "../shared/logger.js";
import type { MirrorEntry, MirrorHeader, SessionLinkReason, TranscriptMode } from "../shared/types/transcripts.js";
import { TranscriptStore } from "./transcript-store.js";
import { deriveCliTranscriptPath } from "./cli-transcript-path.js";

/** Synthetic-session retention (mirror + archive): 30 days. */
export const SYNTHETIC_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface RecorderMeta {
  readonly agentName: string;
  /** Rondel's session id: CLI UUID for conversations, sub_* / cron_* for synthetics. */
  readonly sessionId: string;
  readonly mode: TranscriptMode;
  readonly conversationKey?: string;
  readonly channelType?: string;
  readonly chatId?: string;
  readonly model?: string;
  /** cwd the CLI runs in — recorded in the cli_session entry for archive derivation. */
  readonly cwd?: string;
}

export interface TranscriptServiceDeps {
  readonly store: TranscriptStore;
  readonly hooks: RondelHooks;
  readonly log: Logger;
  /** Resolve an agent's current CLI cwd (sweep fallback when a mirror has no
   *  recorded cwd). Defaults to the daemon cwd. */
  readonly resolveAgentCwd?: (agentName: string) => string | undefined;
  /** Test seam: CLI-path derivation (defaults to ~/.claude/projects mangling). */
  readonly deriveCliPath?: (cwd: string, cliSessionId: string) => string;
}

/**
 * Per-session write handle. Methods are synchronous fire-and-forget (the
 * store serializes the actual appends per path) so they are safe to call
 * from event handlers in the agent loop.
 */
export class TranscriptRecorder {
  private cliSessionId?: string;

  constructor(
    private readonly service: TranscriptService,
    readonly meta: RecorderMeta,
  ) {}

  user(text: string, sender?: { senderId?: string; senderName?: string }): void {
    this.append({
      type: "user",
      text,
      ...(sender?.senderId !== undefined ? { senderId: sender.senderId } : {}),
      ...(sender?.senderName !== undefined ? { senderName: sender.senderName } : {}),
      timestamp: now(),
    });
  }

  assistantText(text: string): void {
    this.append({ type: "assistant", message: { content: [{ type: "text", text }] }, timestamp: now() });
  }

  toolUse(e: { toolUseId: string; name: string; input: unknown; turnId?: string }): void {
    this.append({
      type: "tool_use",
      id: e.toolUseId,
      name: e.name,
      input: e.input,
      ...(e.turnId !== undefined ? { turnId: e.turnId } : {}),
      timestamp: now(),
    });
  }

  toolResult(e: { toolUseId: string; name: string; ok: boolean; result?: unknown; error?: string; durationMs?: number; turnId?: string }): void {
    this.append({
      type: "tool_result",
      id: e.toolUseId,
      name: e.name,
      ok: e.ok,
      ...(e.ok ? { result: e.result } : {}),
      ...(e.error !== undefined ? { error: e.error } : {}),
      ...(e.durationMs !== undefined ? { durationMs: e.durationMs } : {}),
      ...(e.turnId !== undefined ? { turnId: e.turnId } : {}),
      timestamp: now(),
    });
  }

  turn(t: {
    turnId?: string;
    usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number };
    stopReason: string;
    isError: boolean;
    costUsd?: number;
    toolNames: readonly string[];
  }): void {
    this.append({
      type: "turn",
      ...(t.turnId !== undefined ? { turnId: t.turnId } : {}),
      usage: t.usage,
      stopReason: t.stopReason,
      isError: t.isError,
      ...(t.costUsd !== undefined ? { costUsd: t.costUsd } : {}),
      toolNames: t.toolNames,
      timestamp: now(),
    });
    this.service.emitTurnComplete(this.meta, t);
  }

  compaction(c: { trigger: "manual" | "auto" | "unknown"; summary?: string }): void {
    this.append({ type: "compaction", trigger: c.trigger, ...(c.summary !== undefined ? { summary: c.summary } : {}), timestamp: now() });
    this.service.emitCompacted(this.meta, c);
  }

  /** Record the CLI's actual session UUID + transcript path (from `ready`).
   *  Idempotent per (id, path) — crash-restarts re-fire ready. */
  cliSession(cliSessionId: string, cliTranscriptPath?: string): void {
    if (this.cliSessionId === cliSessionId) return;
    this.cliSessionId = cliSessionId;
    this.append({
      type: "cli_session",
      cliSessionId,
      ...(cliTranscriptPath !== undefined ? { cliTranscriptPath } : {}),
      ...(this.meta.cwd !== undefined ? { cwd: this.meta.cwd } : {}),
      timestamp: now(),
    });
  }

  getCliSessionId(): string | undefined {
    return this.cliSessionId;
  }

  private append(entry: MirrorEntry): void {
    this.service.append(this.meta, entry);
  }
}

export class TranscriptService {
  private readonly store: TranscriptStore;
  private readonly hooks: RondelHooks;
  private readonly log: Logger;
  private readonly resolveAgentCwd?: (agentName: string) => string | undefined;
  private readonly deriveCliPath: (cwd: string, cliSessionId: string) => string;

  /** conversationKey → last established sessionId (in-memory; rebuilt from
   *  genealogy files at init, kept fresh by session:established). */
  private readonly lastSession = new Map<string, string>();

  /** conversationKey → reason for the NEXT genealogy link (set by reset). */
  private readonly pendingReasons = new Map<string, SessionLinkReason>();

  constructor(deps: TranscriptServiceDeps) {
    this.store = deps.store;
    this.hooks = deps.hooks;
    this.log = deps.log.child("transcripts");
    this.resolveAgentCwd = deps.resolveAgentCwd;
    this.deriveCliPath = deps.deriveCliPath ?? deriveCliTranscriptPath;
    this.subscribe(deps.hooks);
  }

  // -------------------------------------------------------------------------
  // Wiring
  // -------------------------------------------------------------------------

  private subscribe(hooks: RondelHooks): void {
    hooks.on("session:established", (e) => {
      void this.recordEstablished(e.agentName, e.channelType, e.chatId, e.sessionId, e.resumed).catch((err) => {
        this.log.warn(`genealogy update failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    });
    hooks.on("session:reset", (e) => {
      this.pendingReasons.set(`${e.agentName}:${e.channelType}:${e.chatId}`, "user_reset");
    });
    hooks.on("transcript:session_closed", (e) => {
      const source = e.cliTranscriptPath ?? this.deriveCliPath(e.cwd, e.cliSessionId ?? e.mirrorSessionId);
      void this.store
        .archiveCliTranscript(e.agentName, e.mirrorSessionId, source)
        .then((outcome) => {
          if (outcome === "copied") this.log.info(`Archived CLI transcript: ${e.agentName}/${e.mirrorSessionId}`);
        })
        .catch((err) => {
          this.log.warn(`archive on close failed (${e.agentName}/${e.mirrorSessionId}): ${err instanceof Error ? err.message : String(err)}`);
        });
    });
  }

  /** Load genealogy chains into the in-memory lastSession cache. Call once at
   *  startup, before any conversation spawns. */
  async init(): Promise<void> {
    for (const agent of await this.store.listAgents()) {
      const genealogy = await this.store.readGenealogy(agent);
      for (const [key, chain] of Object.entries(genealogy)) {
        const tail = chain[chain.length - 1];
        if (tail) this.lastSession.set(key, tail.sessionId);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Recorders (the only mirror write path)
  // -------------------------------------------------------------------------

  /**
   * Create the write handle for a session. Synchronous — the getOrSpawn hot
   * path stays synchronous; the header write is enqueued, not awaited.
   * `fresh` writes the gen-2 header; resumed sessions skip it (their mirror
   * already exists with its original header).
   */
  createRecorder(meta: RecorderMeta, opts: { fresh: boolean }): TranscriptRecorder {
    if (opts.fresh) {
      const parentSessionId = meta.conversationKey ? this.lastSession.get(meta.conversationKey) : undefined;
      const header: MirrorHeader = {
        type: "session_start",
        version: 2,
        sessionId: meta.sessionId,
        agentName: meta.agentName,
        mode: meta.mode,
        ...(meta.conversationKey !== undefined ? { conversationKey: meta.conversationKey } : {}),
        ...(meta.channelType !== undefined ? { channelType: meta.channelType } : {}),
        ...(meta.chatId !== undefined ? { chatId: meta.chatId } : {}),
        ...(parentSessionId !== undefined && parentSessionId !== meta.sessionId ? { parentSessionId } : {}),
        ...(meta.model !== undefined ? { model: meta.model } : {}),
        timestamp: now(),
      };
      void this.store.createMirror(meta.agentName, meta.sessionId, header).catch((err) => {
        this.log.warn(`mirror header write failed (${meta.agentName}/${meta.sessionId}): ${err instanceof Error ? err.message : String(err)}`);
      });
    }
    return new TranscriptRecorder(this, meta);
  }

  /** Internal: recorder append + after-write dirty signal. */
  append(meta: RecorderMeta, entry: MirrorEntry): void {
    this.store.appendEntry(meta.agentName, meta.sessionId, entry, () => {
      this.hooks.emit("transcript:appended", {
        agentName: meta.agentName,
        sessionId: meta.sessionId,
        mode: meta.mode,
        kind: entry.type,
      });
    });
  }

  /** Internal: recorder turn rollup → hook. */
  emitTurnComplete(
    meta: RecorderMeta,
    t: {
      usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number };
      stopReason: string;
      isError: boolean;
      costUsd?: number;
      toolNames: readonly string[];
    },
  ): void {
    this.hooks.emit("turn:complete", {
      agentName: meta.agentName,
      sessionId: meta.sessionId,
      mode: meta.mode,
      channelType: meta.channelType,
      chatId: meta.chatId,
      usage: t.usage,
      stopReason: t.stopReason,
      isError: t.isError,
      costUsd: t.costUsd,
      toolNames: t.toolNames,
    });
  }

  /** Internal: recorder compaction → hook. */
  emitCompacted(meta: RecorderMeta, c: { trigger: "manual" | "auto" | "unknown"; summary?: string }): void {
    this.hooks.emit("session:compacted", {
      agentName: meta.agentName,
      sessionId: meta.sessionId,
      mode: meta.mode,
      channelType: meta.channelType,
      chatId: meta.chatId,
      trigger: c.trigger,
      summaryLength: c.summary?.length ?? 0,
    });
  }

  // -------------------------------------------------------------------------
  // Genealogy
  // -------------------------------------------------------------------------

  /** Last established sessionId for a conversation (in-memory cache). */
  getLastSessionId(conversationKey: string): string | undefined {
    return this.lastSession.get(conversationKey);
  }

  /** Whole chain for a conversation — recall lineage dedup reads this. */
  async getSessionChain(agentName: string, conversationKey: string): Promise<readonly string[]> {
    const genealogy = await this.store.readGenealogy(agentName);
    return (genealogy[conversationKey] ?? []).map((l) => l.sessionId);
  }

  private async recordEstablished(agentName: string, channelType: string, chatId: string, sessionId: string, resumed: boolean): Promise<void> {
    const key = `${agentName}:${channelType}:${chatId}`;
    const prev = this.lastSession.get(key);
    if (prev === sessionId) return; // crash-restart re-fire of the same session
    const reason: SessionLinkReason = this.pendingReasons.get(key) ?? (resumed ? "recovered" : "new");
    this.pendingReasons.delete(key);
    this.lastSession.set(key, sessionId);
    await this.store.appendSessionLink(agentName, key, { sessionId, startedAt: now(), reason });
  }

  /** Startup reconciliation: rebuild missing genealogy from gen-2 mirror
   *  headers (ordered by header timestamp; reasons become "unknown"). Only
   *  agents whose sessions-index.json is missing/empty are rebuilt. */
  async rebuildGenealogyFromMirrors(): Promise<void> {
    for (const agent of await this.store.listAgents()) {
      const existing = await this.store.readGenealogy(agent);
      if (Object.keys(existing).length > 0) continue;
      const headers: Array<{ conversationKey: string; sessionId: string; timestamp: string }> = [];
      for (const sessionId of await this.store.listMirrors(agent)) {
        const meta = await this.store.readMirrorMeta(agent, sessionId).catch(() => undefined);
        if (!meta?.conversationKey) continue;
        headers.push({ conversationKey: meta.conversationKey, sessionId, timestamp: new Date(meta.mtimeMs).toISOString() });
      }
      headers.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      for (const h of headers) {
        await this.store.appendSessionLink(agent, h.conversationKey, { sessionId: h.sessionId, startedAt: h.timestamp, reason: "unknown" });
        this.lastSession.set(h.conversationKey, h.sessionId);
      }
      if (headers.length > 0) this.log.info(`Rebuilt genealogy for ${agent}: ${headers.length} session link(s)`);
    }
  }

  // -------------------------------------------------------------------------
  // Archive + retention
  // -------------------------------------------------------------------------

  /**
   * Idempotent daily sweep: re-archive any session whose CLI JSONL grew since
   * the last copy (self-healing within the CLI's ~30-day prune window), and
   * prune synthetic sessions older than SYNTHETIC_TTL_MS (mirror + archive
   * together, with a `transcript:pruned` hook so derived indexes drop rows).
   */
  async sweep(nowMs: number = Date.now()): Promise<{ archived: number; pruned: number }> {
    let archived = 0;
    let pruned = 0;
    for (const agent of await this.store.listAgents()) {
      const prunedSessions: string[] = [];
      for (const sessionId of await this.store.listMirrors(agent)) {
        let meta;
        try {
          meta = await this.store.readMirrorMeta(agent, sessionId);
        } catch (err) {
          this.log.warn(`sweep: meta read failed (${agent}/${sessionId}): ${err instanceof Error ? err.message : String(err)}`);
          continue;
        }
        if (!meta) continue;

        const synthetic = meta.mode !== undefined && meta.mode !== "main";
        if (synthetic && nowMs - meta.mtimeMs > SYNTHETIC_TTL_MS) {
          await this.store.deleteMirror(agent, sessionId).catch(() => {});
          prunedSessions.push(sessionId);
          pruned++;
          continue;
        }

        const cwd = meta.cwd ?? this.resolveAgentCwd?.(agent) ?? process.cwd();
        const cliSessionId = meta.cliSessionId ?? sessionId;
        const source = meta.cliTranscriptPath ?? this.deriveCliPath(cwd, cliSessionId);
        try {
          const outcome = await this.store.archiveCliTranscript(agent, sessionId, source);
          if (outcome === "copied") archived++;
        } catch (err) {
          this.log.warn(`sweep: archive failed (${agent}/${sessionId}): ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (prunedSessions.length > 0) {
        this.hooks.emit("transcript:pruned", { agentName: agent, sessionIds: prunedSessions });
      }
    }
    if (archived > 0 || pruned > 0) this.log.info(`Transcript sweep: ${archived} archived, ${pruned} pruned`);
    return { archived, pruned };
  }
}

function now(): string {
  return new Date().toISOString();
}
