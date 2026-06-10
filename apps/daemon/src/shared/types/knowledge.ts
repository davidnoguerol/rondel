// Knowledge-domain types (see apps/daemon/src/knowledge/).
// Pure type definitions — zero runtime imports.
//
// The knowledge base is a rebuildable FTS index over Rondel's files-of-truth:
// session mirrors (state/transcripts), curated memory files, and ingested
// knowledge documents. Deleting any index file loses nothing — it rebuilds
// from the corpus. Recall is verbatim and lexical (FTS5/BM25): zero LLM
// calls anywhere in the read path (design D1/D5).

export type KbCollection = "sessions" | "memory" | "agent-private" | "org-shared";

/** Session mode for transcript rows; "section" for file-derived rows. */
export type KbSessionMode = "main" | "agent-mail" | "cron" | "subagent" | "section" | "unknown";

export type KbRole = "user" | "assistant" | "tool" | "compaction" | "section";

/** One indexed row. `text` is post-redaction. */
export interface KbEntryRow {
  readonly collection: KbCollection;
  /** sessionId for `sessions`; path relative to the collection root for file collections. */
  readonly sourceId: string;
  /** Absolute JSONL line index (header = 0) for sessions; section ordinal for files. */
  readonly entryIndex: number;
  /** Owning agent; org name for org-shared rows. */
  readonly agent: string;
  readonly conversationKey: string | null;
  readonly mode: KbSessionMode;
  readonly role: KbRole;
  readonly ts: string | null;
  readonly text: string;
}

export interface KbProvenance {
  readonly sessionId?: string;
  readonly path?: string;
  readonly entryIndex: number;
  readonly ts: string | null;
  /** Mirror path (sessions) or file path, for the agent to Read directly. */
  readonly source: string;
}

/** Arg-inferred query shapes (no mode parameter — Hermes UX). */
export interface KbQueryArgs {
  readonly query?: string;
  readonly sessionId?: string;
  readonly aroundEntry?: number;
  readonly collections?: readonly KbCollection[];
  /** Opt-in reach into tool records (skill audit). */
  readonly roles?: readonly KbRole[];
  /** Discovery: max deduped hits (default 3, cap 10). */
  readonly limit?: number;
}

export interface KbLine {
  readonly entryIndex: number;
  readonly role: KbRole;
  readonly ts: string | null;
  readonly text: string;
}

export interface KbHit {
  readonly collection: KbCollection;
  /** BM25 snippet with «match» markers, ≤40 tokens. */
  readonly snippet: string;
  /** ±5 entries around the best match. */
  readonly window: readonly KbLine[];
  /** First/last user+assistant entries — goal → match → resolution in one call. */
  readonly bookends: { readonly head: readonly KbLine[]; readonly tail: readonly KbLine[] };
  readonly provenance: KbProvenance;
  readonly conversationKey: string | null;
  readonly mode: KbSessionMode;
}

export interface KbSessionSummary {
  readonly sessionId: string;
  readonly conversationKey: string | null;
  readonly mode: KbSessionMode;
  readonly firstTs: string | null;
  readonly lastTs: string | null;
  readonly entryCount: number;
  /** First user line, redacted, truncated. */
  readonly preview: string;
}

export type KbQueryResult =
  | { readonly kind: "discovery"; readonly hits: readonly KbHit[]; readonly searched: readonly KbCollection[] }
  | { readonly kind: "scroll"; readonly sessionId: string; readonly lines: readonly KbLine[] }
  | {
      readonly kind: "read";
      readonly sessionId: string;
      readonly head: readonly KbLine[];
      readonly tail: readonly KbLine[];
      readonly totalEntries: number;
    }
  | { readonly kind: "browse"; readonly sessions: readonly KbSessionSummary[] }
  | { readonly kind: "spilled"; readonly preview: string; readonly spillPath: string; readonly note: string }
  /** Expected state, never a thrown error — a broken index is loud, not fatal. */
  | { readonly kind: "unavailable"; readonly reason: string };

export interface KbCollectionInfo {
  readonly collection: KbCollection;
  readonly db: "agent" | "org";
  /** Agent name for agent-db rows; absent for the org DB. */
  readonly agent?: string;
  readonly rowCount: number;
  readonly sourceCount: number;
  readonly lastBuiltAt: string | null;
}

export interface KbIndexStatus {
  readonly state: "ready" | "building" | "missing" | "error";
  readonly generation: number;
  readonly lastBuildMs?: number;
  readonly error?: string;
}
