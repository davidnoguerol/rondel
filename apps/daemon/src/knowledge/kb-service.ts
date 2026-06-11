// KbService — the recall/ingest surface (design §4.3).
//
// Non-negotiables, all battle-tested in the reference systems:
//  - VERBATIM rows, zero LLM anywhere in the read path (Hermes removed its
//    LLM-summary recall mode deliberately; pinned by kb-no-llm test).
//  - Reject the current conversation's lineage — those messages are already
//    in the caller's context window.
//  - Count-based bounds + spill-don't-truncate backstop (post-redaction,
//    24h TTL).
//  - query() NEVER throws into an agent's turn: every failure maps to
//    { kind: "unavailable" } and marks the index dirty (self-heal).
//  - Redaction at the read boundary too (defense in depth — the index is
//    already redacted at build time by the same module).

import { mkdir, readdir, stat, unlink, writeFile, copyFile, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { atomicWriteFile } from "../shared/atomic-file.js";
import type { OrgLookup } from "../shared/org-isolation.js";
import type { Logger } from "../shared/logger.js";
import type {
  KbCollection,
  KbCollectionInfo,
  KbHit,
  KbLine,
  KbQueryArgs,
  KbQueryResult,
  KbRole,
} from "../shared/types/knowledge.js";
import {
  agentDbPath,
  orgDbPath,
  openKbRead,
  searchEntries,
  entriesWindow,
  sessionBookends,
  sessionEntries,
  listSessions,
  collectionStats,
  readMeta,
  toMatchExpression,
  type SearchRow,
} from "./kb-store.js";
import { redactText } from "./kb-redact.js";
import { maskThreats } from "../shared/safety/index.js";
import { conversationKey } from "../shared/types/sessions.js";
import type { KbIndexer } from "./kb-indexer.js";

export type KbErrorCode = "validation" | "unknown_agent" | "forbidden" | "cross_org" | "no_org" | "not_found";

export class KbError extends Error {
  constructor(
    readonly code: KbErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "KbError";
  }
}

export interface KbCaller {
  readonly agentName: string;
  readonly channelType: string;
  readonly chatId: string;
  readonly isAdmin: boolean;
}

export interface KbIngestInput {
  readonly collection: "org-shared" | "agent-private";
  readonly title: string;
  readonly content?: string;
  readonly sourcePath?: string;
}

export interface KbIngestResult {
  readonly path: string;
  readonly collection: "org-shared" | "agent-private";
  readonly note: string;
}

export interface KbServiceDeps {
  readonly knowledgeDir: string;
  /** state/knowledge/spill — oversized recall results, 24h TTL. */
  readonly spillDir: string;
  readonly transcriptsDir: string;
  readonly indexer: KbIndexer;
  readonly orgLookup: OrgLookup;
  readonly isKnownAgent: (agent: string) => boolean;
  readonly resolveAgentDir: (agent: string) => string | undefined;
  readonly resolveOrgDir: (org: string) => string | undefined;
  /** conversationKey → ordered sessionId chain (transcripts genealogy). */
  readonly readGenealogy: (agent: string) => Promise<Record<string, ReadonlyArray<{ sessionId: string }>>>;
  /** Live session id for the caller's conversation; undefined for synthetic callers. */
  readonly resolveCurrentSessionId: (agent: string, channelType: string, chatId: string) => string | undefined;
  readonly backupBeforeDelete?: (agentName: string, path: string) => Promise<void>;
  readonly log: Logger;
}

const DISCOVERY_DEFAULT = 3;
const DISCOVERY_CAP = 10;
const WINDOW_RADIUS = 5;
const SCROLL_CAP = 20;
const READ_HEAD = 20;
const READ_TAIL = 10;
const BROWSE_LIMIT = 10;
const RAW_FETCH_LIMIT = 50;
/** Serialized-result budget before spilling to a file (count-based bounds
 *  control the common case; this is the pathological-message backstop). */
const KB_RESULT_MAX_CHARS = 24_000;
const SPILL_TTL_MS = 24 * 60 * 60 * 1000;
/** Discovery default: tool rows are opt-in noise (Hermes posture). */
const DEFAULT_ROLES: readonly KbRole[] = ["user", "assistant", "compaction", "section"];

export class KbService {
  private readonly log: Logger;

  constructor(private readonly deps: KbServiceDeps) {
    this.log = deps.log.child("kb");
  }

  async init(): Promise<void> {
    await mkdir(this.deps.spillDir, { recursive: true });
  }

  // -------------------------------------------------------------------------
  // query — never throws
  // -------------------------------------------------------------------------

  async query(caller: KbCaller, args: KbQueryArgs): Promise<KbQueryResult> {
    try {
      return await this.queryInner(caller, args);
    } catch (err) {
      this.deps.indexer.markDirty({ agent: caller.agentName });
      const reason = err instanceof Error ? err.message : String(err);
      this.log.warn(`kb query degraded for ${caller.agentName}: ${reason}`);
      return { kind: "unavailable", reason: "index unavailable, rebuilding — retry shortly" };
    }
  }

  private async queryInner(caller: KbCaller, args: KbQueryArgs): Promise<KbQueryResult> {
    const dbs = this.openCallerDbs(caller);
    if (dbs.length === 0) {
      this.deps.indexer.markDirty({ agent: caller.agentName });
      return { kind: "unavailable", reason: "index unavailable, rebuilding — retry shortly" };
    }
    try {
      // Shape inference (no mode parameter — Hermes UX).
      if (args.query !== undefined && args.query.trim().length > 0) {
        return await this.discovery(caller, args, dbs);
      }
      if (args.sessionId !== undefined && args.aroundEntry !== undefined) {
        return this.bound(this.scroll(args.sessionId, args.aroundEntry, args.limit, dbs));
      }
      if (args.sessionId !== undefined) {
        return this.bound(this.read(args.sessionId, dbs));
      }
      return this.bound(this.browse(dbs));
    } finally {
      for (const { db } of dbs) {
        try {
          db.close();
        } catch {
          /* */
        }
      }
    }
  }

  private openCallerDbs(caller: KbCaller): Array<{ db: DatabaseSync; scope: "agent" | "org" }> {
    const out: Array<{ db: DatabaseSync; scope: "agent" | "org" }> = [];
    try {
      out.push({ db: openKbRead(agentDbPath(this.deps.knowledgeDir, caller.agentName)), scope: "agent" });
    } catch {
      // Missing/corrupt agent db — self-heal even when the org db can still
      // answer, otherwise the agent's own history silently vanishes from
      // results until an unrelated dirty signal arrives.
      this.deps.indexer.markDirty({ agent: caller.agentName });
    }
    const org = this.deps.orgLookup(caller.agentName);
    if (org.status === "org") {
      try {
        out.push({ db: openKbRead(orgDbPath(this.deps.knowledgeDir, org.orgName)), scope: "org" });
      } catch {
        this.deps.indexer.markDirty({ org: org.orgName });
      }
    }
    return out;
  }

  private async discovery(
    caller: KbCaller,
    args: KbQueryArgs,
    dbs: Array<{ db: DatabaseSync; scope: "agent" | "org" }>,
  ): Promise<KbQueryResult> {
    const match = toMatchExpression(args.query!);
    if (match.length === 0) return { kind: "discovery", hits: [], searched: args.collections ?? ["sessions", "memory", "agent-private", "org-shared"] };

    // Current-lineage rejection: the caller's own conversation chain + live session.
    const excluded = new Set<string>();
    const callerKey = conversationKey(caller.agentName, caller.channelType, caller.chatId);
    const genealogy = await this.deps.readGenealogy(caller.agentName).catch(() => ({}) as Record<string, ReadonlyArray<{ sessionId: string }>>);
    for (const link of genealogy[callerKey] ?? []) excluded.add(link.sessionId);
    const live = this.deps.resolveCurrentSessionId(caller.agentName, caller.channelType, caller.chatId);
    if (live) excluded.add(live);

    // sessionId → lineage root, for hit dedup (whole chain = one result).
    const lineageRoot = new Map<string, string>();
    for (const [key, chain] of Object.entries(genealogy)) {
      for (const link of chain) lineageRoot.set(link.sessionId, key);
    }

    const roles = args.roles && args.roles.length > 0 ? args.roles : DEFAULT_ROLES;
    const limit = Math.min(args.limit ?? DISCOVERY_DEFAULT, DISCOVERY_CAP);

    const rows: Array<SearchRow & { scope: "agent" | "org" }> = [];
    let dbErrors = 0;
    for (const { db, scope } of dbs) {
      try {
        const found = searchEntries(db, {
          match,
          collections: args.collections,
          roles,
          excludeSourceIds: [...excluded],
          limit: RAW_FETCH_LIMIT,
        });
        rows.push(...found.map((r) => ({ ...r, scope })));
      } catch (err) {
        // One bad DB must not sink the query; the other scope still answers.
        dbErrors++;
        this.log.warn(`kb search failed on ${scope} db: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // Every DB failed (corruption, stale WAL) → unavailable + self-heal,
    // not an empty result that looks like "nothing known".
    if (dbErrors === dbs.length && dbs.length > 0) {
      throw new Error("all knowledge databases failed to answer");
    }
    rows.sort((a, b) => a.rank - b.rank); // bm25: lower = better

    // Dedupe by lineage (sessions) / source path (files): best rank wins.
    const hits: KbHit[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      const dedupeKey =
        row.collection === "sessions" ? (row.conversationKey ?? lineageRoot.get(row.sourceId) ?? row.sourceId) : `${row.collection}:${row.sourceId}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      const db = dbs.find((d) => d.scope === row.scope)!.db;
      const window = row.collection === "sessions" ? entriesWindow(db, row.sourceId, row.entryIndex, WINDOW_RADIUS) : entriesWindow(db, row.sourceId, row.entryIndex, 1);
      const bookends = row.collection === "sessions" ? sessionBookends(db, row.sourceId, 3, 3) : { head: [], tail: [] };

      hits.push({
        collection: row.collection,
        snippet: sanitizeRecallText(row.snippet),
        window: window.map(redactLine),
        bookends: { head: bookends.head.map(redactLine), tail: bookends.tail.map(redactLine) },
        provenance: {
          ...(row.collection === "sessions" ? { sessionId: row.sourceId } : { path: row.sourceId }),
          entryIndex: row.entryIndex,
          ts: row.ts,
          source:
            row.collection === "sessions"
              ? join(this.deps.transcriptsDir, caller.agentName, `${row.sourceId}.jsonl`)
              : row.sourceId,
        },
        conversationKey: row.conversationKey,
        mode: row.mode,
      });
      if (hits.length >= limit) break;
    }

    return this.bound({
      kind: "discovery",
      hits,
      searched: args.collections ?? ["sessions", "memory", "agent-private", "org-shared"],
    });
  }

  private scroll(sessionId: string, aroundEntry: number, limit: number | undefined, dbs: Array<{ db: DatabaseSync; scope: string }>): KbQueryResult {
    const radius = Math.min(limit ?? WINDOW_RADIUS, SCROLL_CAP);
    for (const { db } of dbs) {
      const lines = entriesWindow(db, sessionId, aroundEntry, radius);
      if (lines.length > 0) return { kind: "scroll", sessionId, lines: lines.map(redactLine) };
    }
    return { kind: "scroll", sessionId, lines: [] };
  }

  private read(sessionId: string, dbs: Array<{ db: DatabaseSync; scope: string }>): KbQueryResult {
    for (const { db } of dbs) {
      const { head, tail, total } = sessionEntries(db, sessionId, READ_HEAD, READ_TAIL);
      if (total > 0) {
        return { kind: "read", sessionId, head: head.map(redactLine), tail: tail.map(redactLine), totalEntries: total };
      }
    }
    return { kind: "read", sessionId, head: [], tail: [], totalEntries: 0 };
  }

  private browse(dbs: Array<{ db: DatabaseSync; scope: string }>): KbQueryResult {
    for (const { db, scope } of dbs) {
      if (scope !== "agent") continue;
      const sessions = listSessions(db, { limit: BROWSE_LIMIT, modes: ["main", "agent-mail"] });
      return { kind: "browse", sessions: sessions.map((s) => ({ ...s, preview: sanitizeRecallText(s.preview) })) };
    }
    return { kind: "browse", sessions: [] };
  }

  /** Spill backstop: count-based bounds control the common case; one
   *  pathological multi-MB message still can't flood the context. */
  private bound(result: KbQueryResult): KbQueryResult {
    const serialized = JSON.stringify(result, null, 2);
    if (serialized.length <= KB_RESULT_MAX_CHARS) return result;
    const name = `kbq_${Date.now()}_${randomBytes(4).toString("hex")}.json`;
    const spillPath = join(this.deps.spillDir, name);
    // Synchronously enqueue the write; the caller gets the path either way —
    // a failed spill write surfaces as a missing file the agent reports.
    void writeFile(spillPath, serialized, "utf-8").catch((err) => {
      this.log.warn(`spill write failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    return {
      kind: "spilled",
      preview: serialized.slice(0, 2_000),
      spillPath,
      note: "Full result spilled to file — Read it with your file tools. Expires in 24h.",
    };
  }

  // -------------------------------------------------------------------------
  // ingest — files-of-record first, index second (design §4.2)
  // -------------------------------------------------------------------------

  async ingest(caller: KbCaller, input: KbIngestInput): Promise<KbIngestResult> {
    if (!this.deps.isKnownAgent(caller.agentName)) throw new KbError("unknown_agent", `Unknown agent: ${caller.agentName}`);
    if (!input.content && !input.sourcePath) throw new KbError("validation", "Provide exactly one of content | sourcePath");
    if (input.content && input.sourcePath) throw new KbError("validation", "Provide exactly one of content | sourcePath");

    const homeDir = this.resolveIngestHome(caller, input.collection);
    await mkdir(homeDir, { recursive: true });

    const slug = slugify(input.title);
    let targetPath: string;

    if (input.content !== undefined) {
      targetPath = await this.uniquePath(homeDir, slug, ".md");
      await atomicWriteFile(targetPath, input.content);
    } else {
      const source = resolve(input.sourcePath!);
      // Already inside the home dir → register without copying.
      if (source.startsWith(resolve(homeDir) + "/")) {
        targetPath = source;
      } else {
        const ext = basename(source).includes(".") ? basename(source).slice(basename(source).lastIndexOf(".")) : ".md";
        targetPath = await this.uniquePath(homeDir, slug, ext);
        await copyFile(source, targetPath);
      }
    }

    // Path-traversal guard: the final target must live under the home dir.
    if (!resolve(targetPath).startsWith(resolve(homeDir))) {
      await unlink(targetPath).catch(() => {});
      throw new KbError("validation", "Resolved path escapes the collection directory");
    }

    if (input.collection === "org-shared") {
      const org = this.deps.orgLookup(caller.agentName);
      this.deps.indexer.markDirty({ org: org.status === "org" ? org.orgName : "" });
    } else {
      this.deps.indexer.markDirty({ agent: caller.agentName });
    }

    return { path: targetPath, collection: input.collection, note: "Written to the collection's file-of-record; searchable within seconds." };
  }

  private resolveIngestHome(caller: KbCaller, collection: "org-shared" | "agent-private"): string {
    if (collection === "agent-private") {
      const agentDir = this.deps.resolveAgentDir(caller.agentName);
      if (!agentDir) throw new KbError("unknown_agent", `Unknown agent: ${caller.agentName}`);
      return join(agentDir, "knowledge");
    }
    const org = this.deps.orgLookup(caller.agentName);
    if (org.status !== "org") throw new KbError("no_org", "You are not in an org — use collection: agent-private");
    const orgDir = this.deps.resolveOrgDir(org.orgName);
    if (!orgDir) throw new KbError("not_found", `Org directory not found for ${org.orgName}`);
    return join(orgDir, "shared", "knowledge");
  }

  private async uniquePath(dir: string, slug: string, ext: string): Promise<string> {
    for (let i = 0; i < 100; i++) {
      const candidate = join(dir, `${slug}${i === 0 ? "" : `-${i + 1}`}${ext}`);
      const exists = await stat(candidate).then(
        () => true,
        () => false,
      );
      if (!exists) return candidate;
    }
    return join(dir, `${slug}-${randomBytes(3).toString("hex")}${ext}`);
  }

  // -------------------------------------------------------------------------
  // listCollections / remove
  // -------------------------------------------------------------------------

  async listCollections(caller: { agentName: string; isAdmin: boolean }, opts?: { org?: string }): Promise<{ org: string; collections: KbCollectionInfo[] }> {
    const own = this.deps.orgLookup(caller.agentName);
    const ownLabel = own.status === "org" ? own.orgName : "global";
    const org = !opts?.org || opts.org === "self" ? ownLabel : opts.org;
    // Org isolation: non-admins may only inspect their own org's collections.
    if (org !== ownLabel && !caller.isAdmin) {
      throw new KbError("cross_org", `Cannot inspect collections of org "${org}"`);
    }

    const collections: KbCollectionInfo[] = [];
    try {
      const db = openKbRead(agentDbPath(this.deps.knowledgeDir, caller.agentName));
      try {
        const meta = readMeta(db);
        for (const s of collectionStats(db)) {
          collections.push({ ...s, db: "agent", agent: caller.agentName, lastBuiltAt: meta.builtAt });
        }
      } finally {
        db.close();
      }
    } catch {
      /* agent db missing — rebuild pending */
    }
    if (org !== "global") {
      try {
        const db = openKbRead(orgDbPath(this.deps.knowledgeDir, org));
        try {
          const meta = readMeta(db);
          for (const s of collectionStats(db)) collections.push({ ...s, db: "org", lastBuiltAt: meta.builtAt });
        } finally {
          db.close();
        }
      } catch {
        /* org db missing */
      }
    }
    return { org, collections };
  }

  async remove(caller: KbCaller, input: { collection: "agent-private" | "org-shared"; path: string }): Promise<{ removed: string }> {
    if (!caller.isAdmin) throw new KbError("forbidden", "rondel_kb_delete is admin-only");
    const homeDir = this.resolveIngestHome(caller, input.collection);
    const target = resolve(homeDir, input.path);
    if (!target.startsWith(resolve(homeDir) + "/")) throw new KbError("validation", "Path escapes the collection directory");
    const exists = await stat(target).then(
      () => true,
      () => false,
    );
    if (!exists) throw new KbError("not_found", `No such document: ${input.path}`);
    await this.deps.backupBeforeDelete?.(caller.agentName, target);
    await unlink(target);
    if (input.collection === "org-shared") {
      const org = this.deps.orgLookup(caller.agentName);
      if (org.status === "org") this.deps.indexer.markDirty({ org: org.orgName });
    } else {
      this.deps.indexer.markDirty({ agent: caller.agentName });
    }
    return { removed: target };
  }

  // -------------------------------------------------------------------------
  // spill retention — 24h TTL (precedent: attachments)
  // -------------------------------------------------------------------------

  async cleanupSpill(nowMs: number = Date.now()): Promise<number> {
    let removed = 0;
    let entries: string[];
    try {
      entries = await readdir(this.deps.spillDir);
    } catch {
      return 0;
    }
    for (const name of entries) {
      const full = join(this.deps.spillDir, name);
      try {
        const st = await stat(full);
        if (nowMs - st.mtimeMs > SPILL_TTL_MS) {
          await unlink(full);
          removed++;
        }
      } catch {
        /* raced */
      }
    }
    return removed;
  }
}

/**
 * Read-boundary sanitization (§8.1/§8.2): secrets redacted AND
 * injection-shaped lines visibly masked — including attempts to escape the
 * recall frame itself ([END RECALL RESULTS] inside recalled content). The
 * masking is line-preserving so provenance stays usable.
 */
function sanitizeRecallText(text: string): string {
  return maskThreats(redactText(text)).masked;
}

function redactLine(line: KbLine): KbLine {
  return { ...line, text: sanitizeRecallText(line.text) };
}

function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug.length > 0 ? slug : "untitled";
}
