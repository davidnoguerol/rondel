// TranscriptReadService — the human-facing read surface over the mirror
// store (transcript browser + usage rollups, design §7.3). All reads, no
// writes.
//
// Read-time redaction: every text field passes the knowledge domain's
// single redactText() (one-function rule, design §4.2/§8.4 — this endpoint
// is a recall surface for humans). Oversized tool payloads are truncated
// server-side with a `truncated` flag so the UI can label them.

import { readFile } from "node:fs/promises";
import { redactText } from "../knowledge/index.js";
import type { AgentGenealogy, TranscriptMode } from "../shared/types/transcripts.js";
import type { Logger } from "../shared/logger.js";
import { TranscriptStore } from "./transcript-store.js";

const TOOL_PAYLOAD_MAX_CHARS = 4_096;

export interface TranscriptSessionInfo {
  readonly sessionId: string;
  readonly startedAt: string;
  readonly reason: string;
}

export interface TranscriptConversationInfo {
  readonly conversationKey: string;
  readonly sessions: readonly TranscriptSessionInfo[]; // oldest → newest
}

export type TranscriptEntryWire =
  | { readonly type: "session_start"; readonly index: number; readonly ts?: string; readonly version?: number; readonly mode?: string; readonly parentSessionId?: string }
  | { readonly type: "user"; readonly index: number; readonly ts?: string; readonly text: string }
  | { readonly type: "assistant"; readonly index: number; readonly ts?: string; readonly text: string }
  | { readonly type: "tool_use"; readonly index: number; readonly ts?: string; readonly id: string; readonly name: string; readonly input: string; readonly truncated?: boolean }
  | {
      readonly type: "tool_result";
      readonly index: number;
      readonly ts?: string;
      readonly id: string;
      readonly name: string;
      readonly ok: boolean;
      readonly result?: string;
      readonly error?: string;
      readonly durationMs?: number;
      readonly truncated?: boolean;
    }
  | {
      readonly type: "turn";
      readonly index: number;
      readonly ts?: string;
      readonly usage: { readonly inputTokens: number; readonly outputTokens: number; readonly cacheReadTokens: number; readonly cacheCreationTokens: number };
      readonly stopReason?: string;
      readonly isError?: boolean;
      readonly costUsd?: number;
      readonly toolNames?: readonly string[];
    }
  | { readonly type: "compaction"; readonly index: number; readonly ts?: string; readonly trigger?: string; readonly summary: string }
  | { readonly type: "cli_session"; readonly index: number; readonly ts?: string; readonly cliSessionId: string };

export interface UsageBucket {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** Price-table estimate — never billing truth. */
  estimatedCostUsd: number;
}

export interface UsageRollup {
  readonly totals: UsageBucket;
  readonly byDay: ReadonlyArray<UsageBucket & { date: string }>;
}

export class TranscriptReadService {
  constructor(
    private readonly store: TranscriptStore,
    private readonly log: Logger,
  ) {}

  /** Conversations (genealogy chains) for an agent, plus orphan sessions
   *  that predate genealogy, newest-last-activity first. */
  async listConversations(agent: string): Promise<TranscriptConversationInfo[]> {
    const genealogy: AgentGenealogy = await this.store.readGenealogy(agent);
    const inChains = new Set<string>();
    const conversations: TranscriptConversationInfo[] = [];
    for (const [conversationKey, chain] of Object.entries(genealogy)) {
      for (const link of chain) inChains.add(link.sessionId);
      conversations.push({
        conversationKey,
        sessions: chain.map((l) => ({ sessionId: l.sessionId, startedAt: l.startedAt, reason: l.reason })),
      });
    }
    // Mirrors not in any chain (legacy sessions, synthetics) — grouped under
    // a pseudo-conversation per mode so the browser can still reach them.
    const orphansByMode = new Map<TranscriptMode | "unknown", TranscriptSessionInfo[]>();
    for (const sessionId of await this.store.listMirrors(agent)) {
      if (inChains.has(sessionId)) continue;
      const meta = await this.store.readMirrorMeta(agent, sessionId).catch(() => undefined);
      const mode = meta?.mode ?? "unknown";
      const list = orphansByMode.get(mode) ?? [];
      list.push({ sessionId, startedAt: new Date(meta?.mtimeMs ?? 0).toISOString(), reason: "unknown" });
      orphansByMode.set(mode, list);
    }
    for (const [mode, sessions] of orphansByMode) {
      conversations.push({ conversationKey: `${agent}:_unlinked:${mode}`, sessions });
    }
    return conversations;
  }

  /** Paginated, normalized, post-redaction entries from one mirror file.
   *  Handles all three on-disk generations. Returns null for a missing
   *  session (404 at the bridge). */
  async readEntries(agent: string, sessionId: string, opts: { offset: number; limit: number }): Promise<{ total: number; entries: TranscriptEntryWire[] } | null> {
    let raw: string;
    try {
      raw = await readFile(this.store.mirrorPath(agent, sessionId), "utf-8");
    } catch {
      return null;
    }
    const lines = raw.split("\n");
    const all: TranscriptEntryWire[] = [];
    for (let i = 0; i < lines.length; i++) {
      const entry = normalizeLine(lines[i]!, i);
      if (entry) all.push(entry);
    }
    const entries = all.slice(opts.offset, opts.offset + opts.limit);
    return { total: all.length, entries };
  }

  /** Rollup over `turn` mirror entries across all of an agent's mirrors. */
  async aggregateUsage(agent: string, opts: { sinceMs?: number; untilMs?: number } = {}): Promise<UsageRollup> {
    const totals = emptyBucket();
    const byDay = new Map<string, UsageBucket>();
    for (const sessionId of await this.store.listMirrors(agent)) {
      let raw: string;
      try {
        raw = await readFile(this.store.mirrorPath(agent, sessionId), "utf-8");
      } catch {
        continue;
      }
      for (const line of raw.split("\n")) {
        if (!line.startsWith('{"type":"turn"')) continue;
        let entry: { usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheCreationTokens?: number }; costUsd?: number; timestamp?: string };
        try {
          entry = JSON.parse(line) as typeof entry;
        } catch {
          continue;
        }
        const ts = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
        if (opts.sinceMs !== undefined && (!Number.isFinite(ts) || ts < opts.sinceMs)) continue;
        if (opts.untilMs !== undefined && (!Number.isFinite(ts) || ts > opts.untilMs)) continue;
        const date = entry.timestamp?.slice(0, 10) ?? "unknown";
        const bucket = byDay.get(date) ?? emptyBucket();
        for (const b of [totals, bucket]) {
          b.turns++;
          b.inputTokens += entry.usage?.inputTokens ?? 0;
          b.outputTokens += entry.usage?.outputTokens ?? 0;
          b.cacheReadTokens += entry.usage?.cacheReadTokens ?? 0;
          b.cacheCreationTokens += entry.usage?.cacheCreationTokens ?? 0;
          b.estimatedCostUsd += entry.costUsd ?? 0;
        }
        byDay.set(date, bucket);
      }
    }
    return {
      totals,
      byDay: [...byDay.entries()]
        .map(([date, bucket]) => ({ date, ...bucket }))
        .sort((a, b) => a.date.localeCompare(b.date)),
    };
  }
}

function emptyBucket(): UsageBucket {
  return { turns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, estimatedCostUsd: 0 };
}

function normalizeLine(line: string, index: number): TranscriptEntryWire | null {
  if (!line.trim()) return null;
  let e: Record<string, unknown>;
  try {
    e = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  const ts = typeof e.timestamp === "string" ? e.timestamp : undefined;

  switch (e.type) {
    case "session_start":
      return {
        type: "session_start",
        index,
        ts,
        ...(typeof e.version === "number" ? { version: e.version } : {}),
        ...(typeof e.mode === "string" ? { mode: e.mode } : {}),
        ...(typeof e.parentSessionId === "string" ? { parentSessionId: e.parentSessionId } : {}),
      };
    case "user": {
      let text: string | undefined;
      if (typeof e.text === "string") text = e.text;
      else text = joinBlocks(e);
      if (text === undefined) return null;
      return { type: "user", index, ts, text: redactText(text) };
    }
    case "assistant": {
      const text = joinBlocks(e);
      if (text === undefined) return null;
      return { type: "assistant", index, ts, text: redactText(text) };
    }
    case "tool_use": {
      const { value, truncated } = bound(JSON.stringify(e.input ?? null));
      return {
        type: "tool_use",
        index,
        ts,
        id: String(e.id ?? ""),
        name: String(e.name ?? ""),
        input: redactText(value),
        ...(truncated ? { truncated } : {}),
      };
    }
    case "tool_result": {
      const ok = e.ok === true;
      const raw = ok ? JSON.stringify(e.result ?? null) : undefined;
      const { value, truncated } = raw !== undefined ? bound(raw) : { value: undefined, truncated: false };
      return {
        type: "tool_result",
        index,
        ts,
        id: String(e.id ?? ""),
        name: String(e.name ?? ""),
        ok,
        ...(value !== undefined ? { result: redactText(value) } : {}),
        ...(typeof e.error === "string" ? { error: redactText(e.error) } : {}),
        ...(typeof e.durationMs === "number" ? { durationMs: e.durationMs } : {}),
        ...(truncated ? { truncated } : {}),
      };
    }
    case "turn": {
      const usage = (e.usage ?? {}) as Record<string, unknown>;
      return {
        type: "turn",
        index,
        ts,
        usage: {
          inputTokens: num(usage.inputTokens),
          outputTokens: num(usage.outputTokens),
          cacheReadTokens: num(usage.cacheReadTokens),
          cacheCreationTokens: num(usage.cacheCreationTokens),
        },
        ...(typeof e.stopReason === "string" ? { stopReason: e.stopReason } : {}),
        ...(typeof e.isError === "boolean" ? { isError: e.isError } : {}),
        ...(typeof e.costUsd === "number" ? { costUsd: e.costUsd } : {}),
        ...(Array.isArray(e.toolNames) ? { toolNames: e.toolNames.map(String) } : {}),
      };
    }
    case "compaction":
      return {
        type: "compaction",
        index,
        ts,
        ...(typeof e.trigger === "string" ? { trigger: e.trigger } : {}),
        summary: redactText(typeof e.summary === "string" ? e.summary : ""),
      };
    case "cli_session":
      return { type: "cli_session", index, ts, cliSessionId: String(e.cliSessionId ?? "") };
    default:
      return null; // unknown generations / machinery lines
  }
}

function joinBlocks(e: Record<string, unknown>): string | undefined {
  const message = e.message as { content?: unknown } | undefined;
  if (!message || !Array.isArray(message.content)) return undefined;
  const parts: string[] = [];
  for (const block of message.content as Array<{ type?: string; text?: string }>) {
    if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function bound(value: string): { value: string; truncated: boolean } {
  if (value.length <= TOOL_PAYLOAD_MAX_CHARS) return { value, truncated: false };
  return { value: value.slice(0, TOOL_PAYLOAD_MAX_CHARS) + "…", truncated: true };
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
