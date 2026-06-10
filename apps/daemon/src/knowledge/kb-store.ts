// KbStore — every node:sqlite statement in the knowledge domain lives here.
// File I/O only: no hooks, no cross-domain imports, testable against a tmp
// file with zero mocks.
//
// Backend choice (design D1): node:sqlite — zero native dependencies, FTS5
// verified working on the repo's Node (v22.16.0). The API is experimental;
// better-sqlite3 is the documented fallback and this module is the only
// thing that would change. Node prints one ExperimentalWarning per process —
// cosmetic, deliberately not suppressed.
//
// Index strategy: FULL REBUILD into one transaction (external-content FTS5 +
// the 'rebuild' command), no triggers, no incremental delta-tracking — the
// corpus is ~tens of MB and a rebuild takes seconds. WAL mode means the main
// thread's read connection keeps seeing the old snapshot until COMMIT.

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { KbCollection, KbEntryRow, KbLine, KbRole, KbSessionMode, KbSessionSummary } from "../shared/types/knowledge.js";

export const KB_SCHEMA_VERSION = 1;

/** Same defense-in-depth posture as heartbeat-store's name guard. */
const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

function safeName(name: string, label: string): string {
  if (!NAME_RE.test(name)) throw new Error(`invalid ${label} name for db path: ${JSON.stringify(name)}`);
  return name;
}

export function agentDbPath(knowledgeDir: string, agent: string): string {
  return join(knowledgeDir, `${safeName(agent, "agent")}.sqlite`);
}

export function orgDbPath(knowledgeDir: string, org: string): string {
  return join(knowledgeDir, `org-${safeName(org, "org")}.sqlite`);
}

export function ensureSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS kb_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS entries (
      id INTEGER PRIMARY KEY,
      collection TEXT NOT NULL,
      source_id TEXT NOT NULL,
      entry_index INTEGER NOT NULL,
      agent TEXT NOT NULL,
      conversation_key TEXT,
      mode TEXT NOT NULL,
      role TEXT NOT NULL,
      ts TEXT,
      text TEXT NOT NULL,
      UNIQUE (collection, source_id, entry_index)
    );
    CREATE INDEX IF NOT EXISTS idx_entries_source ON entries (source_id, entry_index);
    CREATE VIRTUAL TABLE IF NOT EXISTS kb_fts USING fts5(
      text, content='entries', content_rowid='id', tokenize='porter unicode61'
    );
  `);
}

/** Open for rebuild: mkdir parent, WAL, schema. */
export function openKbWrite(dbPath: string): DatabaseSync {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  ensureSchema(db);
  return db;
}

/** Open for queries. Throws on missing/corrupt — the caller (service) maps
 *  every open error to {kind:"unavailable"}, never a thrown error upstream. */
export function openKbRead(dbPath: string): DatabaseSync {
  return new DatabaseSync(dbPath, { readOnly: true });
}

export function beginRebuild(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE;");
  db.exec("DELETE FROM entries;");
}

export function insertEntry(db: DatabaseSync, row: KbEntryRow): void {
  db.prepare(
    `INSERT OR REPLACE INTO entries (collection, source_id, entry_index, agent, conversation_key, mode, role, ts, text)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(row.collection, row.sourceId, row.entryIndex, row.agent, row.conversationKey, row.mode, row.role, row.ts, row.text);
}

export function finishRebuild(db: DatabaseSync, meta: { builtAt: string; schemaVersion: number }): void {
  db.exec(`INSERT INTO kb_fts(kb_fts) VALUES('rebuild');`);
  const upsert = db.prepare(`INSERT INTO kb_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
  upsert.run("builtAt", meta.builtAt);
  upsert.run("schemaVersion", String(meta.schemaVersion));
  db.exec("COMMIT;");
}

export function abortRebuild(db: DatabaseSync): void {
  try {
    db.exec("ROLLBACK;");
  } catch {
    /* no transaction active */
  }
}

/**
 * Neutralize FTS5 query operators in agent-supplied text: strip quotes,
 * split on whitespace, quote each token (implicit AND). Without this, a
 * query like `why (broken` throws an FTS5 syntax error into the read path.
 */
export function toMatchExpression(userQuery: string): string {
  const tokens = userQuery
    .replace(/"/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  return tokens.map((t) => `"${t}"`).join(" ");
}

export interface SearchRow {
  readonly collection: KbCollection;
  readonly sourceId: string;
  readonly entryIndex: number;
  readonly conversationKey: string | null;
  readonly mode: KbSessionMode;
  readonly role: KbRole;
  readonly ts: string | null;
  readonly snippet: string;
  readonly rank: number;
}

/** Discovery search. Filters live on `entries`; rank/snippet on the FTS table. */
export function searchEntries(
  db: DatabaseSync,
  opts: {
    match: string;
    collections?: readonly KbCollection[];
    excludeSourceIds?: readonly string[];
    roles?: readonly KbRole[];
    limit: number;
  },
): SearchRow[] {
  const clauses: string[] = ["kb_fts MATCH ?"];
  const params: Array<string | number> = [opts.match];

  if (opts.collections && opts.collections.length > 0) {
    clauses.push(`e.collection IN (${opts.collections.map(() => "?").join(",")})`);
    params.push(...opts.collections);
  }
  if (opts.roles && opts.roles.length > 0) {
    clauses.push(`e.role IN (${opts.roles.map(() => "?").join(",")})`);
    params.push(...opts.roles);
  }
  if (opts.excludeSourceIds && opts.excludeSourceIds.length > 0) {
    clauses.push(`e.source_id NOT IN (${opts.excludeSourceIds.map(() => "?").join(",")})`);
    params.push(...opts.excludeSourceIds);
  }

  const sql = `
    SELECT e.collection AS collection, e.source_id AS sourceId, e.entry_index AS entryIndex,
           e.conversation_key AS conversationKey, e.mode AS mode, e.role AS role, e.ts AS ts,
           snippet(kb_fts, 0, '«', '»', '…', 40) AS snippet, bm25(kb_fts) AS rank
    FROM kb_fts JOIN entries e ON e.id = kb_fts.rowid
    WHERE ${clauses.join(" AND ")}
    ORDER BY rank LIMIT ?`;
  params.push(opts.limit);
  return db.prepare(sql).all(...params) as unknown as SearchRow[];
}

const LINE_COLS = "entry_index AS entryIndex, role, ts, text";

/** ±radius entries around a center index within one source. */
export function entriesWindow(db: DatabaseSync, sourceId: string, center: number, radius: number): KbLine[] {
  return db
    .prepare(`SELECT ${LINE_COLS} FROM entries WHERE source_id = ? AND entry_index BETWEEN ? AND ? ORDER BY entry_index`)
    .all(sourceId, center - radius, center + radius) as unknown as KbLine[];
}

/** First/last N user+assistant entries of a source (goal → resolution). */
export function sessionBookends(db: DatabaseSync, sourceId: string, headN: number, tailN: number): { head: KbLine[]; tail: KbLine[] } {
  const head = db
    .prepare(`SELECT ${LINE_COLS} FROM entries WHERE source_id = ? AND role IN ('user','assistant') ORDER BY entry_index LIMIT ?`)
    .all(sourceId, headN) as unknown as KbLine[];
  const tail = (
    db
      .prepare(`SELECT ${LINE_COLS} FROM entries WHERE source_id = ? AND role IN ('user','assistant') ORDER BY entry_index DESC LIMIT ?`)
      .all(sourceId, tailN) as unknown as KbLine[]
  ).reverse();
  return { head, tail };
}

/** Bounded whole-source dump: head N + tail M + total count. */
export function sessionEntries(db: DatabaseSync, sourceId: string, headN: number, tailN: number): { head: KbLine[]; tail: KbLine[]; total: number } {
  const total = (db.prepare(`SELECT COUNT(*) AS c FROM entries WHERE source_id = ?`).get(sourceId) as { c: number }).c;
  const head = db.prepare(`SELECT ${LINE_COLS} FROM entries WHERE source_id = ? ORDER BY entry_index LIMIT ?`).all(sourceId, headN) as unknown as KbLine[];
  const tail =
    total > headN
      ? ((db.prepare(`SELECT ${LINE_COLS} FROM entries WHERE source_id = ? ORDER BY entry_index DESC LIMIT ?`).all(sourceId, Math.min(tailN, total - headN)) as unknown as KbLine[]).reverse())
      : [];
  return { head, tail, total };
}

/** Recent sessions with previews, newest-first by last entry timestamp. */
export function listSessions(db: DatabaseSync, opts: { limit: number; modes?: readonly KbSessionMode[] }): KbSessionSummary[] {
  const modeClause = opts.modes && opts.modes.length > 0 ? `AND mode IN (${opts.modes.map(() => "?").join(",")})` : "";
  const params: Array<string | number> = ["sessions"];
  if (opts.modes) params.push(...opts.modes);
  params.push(opts.limit);
  const rows = db
    .prepare(
      `SELECT source_id AS sessionId, conversation_key AS conversationKey, mode,
              MIN(ts) AS firstTs, MAX(ts) AS lastTs, COUNT(*) AS entryCount
       FROM entries WHERE collection = ? ${modeClause}
       GROUP BY source_id ORDER BY MAX(ts) DESC LIMIT ?`,
    )
    .all(...params) as unknown as Array<Omit<KbSessionSummary, "preview">>;

  return rows.map((r) => {
    const first = db
      .prepare(`SELECT text FROM entries WHERE source_id = ? AND role = 'user' ORDER BY entry_index LIMIT 1`)
      .get(r.sessionId) as { text: string } | undefined;
    const preview = (first?.text ?? "").slice(0, 120);
    return { ...r, preview };
  });
}

export function collectionStats(db: DatabaseSync): Array<{ collection: KbCollection; rowCount: number; sourceCount: number }> {
  return db
    .prepare(`SELECT collection, COUNT(*) AS rowCount, COUNT(DISTINCT source_id) AS sourceCount FROM entries GROUP BY collection`)
    .all() as unknown as Array<{ collection: KbCollection; rowCount: number; sourceCount: number }>;
}

export function readMeta(db: DatabaseSync): { builtAt: string | null; schemaVersion: number | null } {
  const get = (key: string): string | undefined => (db.prepare(`SELECT value FROM kb_meta WHERE key = ?`).get(key) as { value: string } | undefined)?.value;
  const builtAt = get("builtAt") ?? null;
  const sv = get("schemaVersion");
  return { builtAt, schemaVersion: sv !== undefined ? Number(sv) : null };
}
