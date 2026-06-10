// Transcript-domain types (see apps/daemon/src/transcripts/).
// Pure type definitions — zero runtime imports.
//
// The mirror is Rondel's durable, append-only record of every session:
// one JSONL file per (agent, sessionId) under state/transcripts/{agent}/.
// Three generations coexist on disk and readers must tolerate all of them:
//   gen 0 (pre claude-wrap cutover): raw stream-json events, unversioned header
//   gen 1 (post-cutover):            text-only user/assistant entries, unversioned header
//   gen 2 (this domain):             versioned header + typed entries below
//
// Entry ordering contract: tool events arrive via the hook socket while text
// blocks arrive via a polled transcript tail, so gen-2 mirror order is
// approximate WITHIN a turn. Anything needing exact order (skill replay)
// uses the archived CLI JSONL, which is the ordering truth.
//
// All entries use the field name `timestamp` (ISO 8601) — the contract
// loadTranscriptTurns and the gen-0/1 files already share.

/** Which kind of session produced a transcript. Drives retention:
 *  `main` conversations are durable; everything else is synthetic. */
export type TranscriptMode = "main" | "agent-mail" | "cron" | "subagent";

/** Why a new sessionId was appended to a conversation's chain. Only
 *  `new` / `user_reset` have emit sites today; the rest are forward-compat. */
export type SessionLinkReason = "new" | "user_reset" | "idle_reset" | "resume_failed" | "recovered" | "unknown";

/** Versioned gen-2 mirror header — always the first line of the file. */
export interface MirrorHeader {
  readonly type: "session_start";
  readonly version: 2;
  /** Rondel's id for the session: CLI session UUID for conversations,
   *  sub_* / cron_* id for synthetic runs (their CLI UUID differs and is
   *  recorded by a later `cli_session` entry). */
  readonly sessionId: string;
  readonly agentName: string;
  readonly mode: TranscriptMode;
  /** Present for conversation sessions (main + agent-mail). */
  readonly conversationKey?: string;
  readonly channelType?: string;
  readonly chatId?: string;
  /** Previous sessionId in this conversation's genealogy, if any. */
  readonly parentSessionId?: string;
  readonly model?: string;
  readonly timestamp: string;
}

/** User message — same shape gen-1 wrote, so existing readers keep working. */
export interface MirrorUserEntry {
  readonly type: "user";
  readonly text: string;
  readonly senderId?: string;
  readonly senderName?: string;
  readonly timestamp: string;
}

/** Assistant text block — same nested shape gen-1 wrote (one text block per
 *  entry), so existing readers keep working. */
export interface MirrorAssistantEntry {
  readonly type: "assistant";
  readonly message: { readonly content: ReadonlyArray<{ readonly type: "text"; readonly text: string }> };
  readonly timestamp: string;
}

/** Complete tool invocation (verbatim input from the PreToolUse hook).
 *  `id` is the toolu_* id — the durable join key into the CLI JSONL. */
export interface MirrorToolUseEntry {
  readonly type: "tool_use";
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
  readonly turnId?: string;
  readonly timestamp: string;
}

/** Tool outcome. Failures are structurally thinner (no result/durationMs) —
 *  the PostToolUseFailure hook carries only an error string. */
export interface MirrorToolResultEntry {
  readonly type: "tool_result";
  readonly id: string;
  readonly name: string;
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: string;
  readonly durationMs?: number;
  readonly turnId?: string;
  readonly timestamp: string;
}

/** Per-turn rollup: aggregated token usage + terminal stop reason. */
export interface MirrorTurnEntry {
  readonly type: "turn";
  readonly turnId?: string;
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheReadTokens: number;
    readonly cacheCreationTokens: number;
  };
  readonly stopReason: string;
  readonly isError: boolean;
  /** Price-table estimate — never billing truth. */
  readonly costUsd?: number;
  readonly toolNames: readonly string[];
  readonly timestamp: string;
}

/** Compaction record — the CLI's own summary (PostCompact hook, CLI ≥2.1.76). */
export interface MirrorCompactionEntry {
  readonly type: "compaction";
  readonly trigger: "manual" | "auto" | "unknown";
  readonly summary?: string;
  readonly timestamp: string;
}

/** Links a mirror to the CLI's own full-fidelity JSONL: the CLI session UUID
 *  (differs from the rondel id for synthetic runs), the transcript path
 *  learned from the SessionStart hook (claude-wrap ≥0.1.2), and the exact
 *  spawn cwd (path-derivation fallback). The archive sweep prefers the
 *  recorded path, then derives from cwd + cliSessionId. */
export interface MirrorCliSessionEntry {
  readonly type: "cli_session";
  readonly cliSessionId: string;
  readonly cliTranscriptPath?: string;
  readonly cwd?: string;
  readonly timestamp: string;
}

export type MirrorEntry =
  | MirrorUserEntry
  | MirrorAssistantEntry
  | MirrorToolUseEntry
  | MirrorToolResultEntry
  | MirrorTurnEntry
  | MirrorCompactionEntry
  | MirrorCliSessionEntry;

// --- Session genealogy ---

export interface SessionLink {
  readonly sessionId: string;
  readonly startedAt: string;
  readonly reason: SessionLinkReason;
}

/** Per-agent genealogy file: conversationKey → ordered session chain.
 *  Lives at state/transcripts/{agent}/sessions-index.json. Rebuildable from
 *  mirror gen-2 headers if lost. */
export type AgentGenealogy = Record<string, SessionLink[]>;

// --- Reader-side types ---

/** Ordered user/assistant turn extracted from a transcript (any generation).
 *  Used by bridge endpoints that replay a conversation for the web UI. */
export interface TranscriptTurn {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly ts?: string;
}
