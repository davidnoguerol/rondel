import { describe, it, expect } from "vitest";
import { join } from "node:path";
import {
  openKbWrite,
  openKbRead,
  beginRebuild,
  insertEntry,
  finishRebuild,
  searchEntries,
  entriesWindow,
  sessionBookends,
  sessionEntries,
  listSessions,
  collectionStats,
  readMeta,
  toMatchExpression,
  agentDbPath,
  KB_SCHEMA_VERSION,
} from "./kb-store.js";
import type { KbEntryRow } from "../shared/types/knowledge.js";
import { withTmpRondel } from "../../../../tests/helpers/tmp.js";

function row(overrides: Partial<KbEntryRow>): KbEntryRow {
  return {
    collection: "sessions",
    sourceId: "sess-1",
    entryIndex: 1,
    agent: "kai",
    conversationKey: "kai:telegram:42",
    mode: "main",
    role: "user",
    ts: "2026-06-01T00:00:00.000Z",
    text: "placeholder",
    ...overrides,
  };
}

function buildDb(dbPath: string, rows: KbEntryRow[]): void {
  const db = openKbWrite(dbPath);
  beginRebuild(db);
  for (const r of rows) insertEntry(db, r);
  finishRebuild(db, { builtAt: "2026-06-10T00:00:00.000Z", schemaVersion: KB_SCHEMA_VERSION });
  db.close();
}

describe("kb-store", () => {
  it("round-trips a rebuild and finds rows via FTS with snippets", () => {
    const tmp = withTmpRondel();
    const dbPath = agentDbPath(join(tmp.stateDir, "knowledge"), "kai");
    buildDb(dbPath, [
      row({ entryIndex: 1, text: "we sent the invoice to flint on tuesday" }),
      row({ entryIndex: 2, role: "assistant", text: "the deck is ready for review" }),
    ]);

    const db = openKbRead(dbPath);
    const hits = searchEntries(db, { match: toMatchExpression("invoice flint"), limit: 5 });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.entryIndex).toBe(1);
    expect(hits[0]!.snippet).toContain("«invoice»");
    expect(readMeta(db).builtAt).toBe("2026-06-10T00:00:00.000Z");
    db.close();
  });

  it("window, bookends, and bounded read slice by entry_index", () => {
    const tmp = withTmpRondel();
    const dbPath = agentDbPath(join(tmp.stateDir, "knowledge"), "kai");
    const rows: KbEntryRow[] = [];
    for (let i = 1; i <= 40; i++) {
      rows.push(row({ entryIndex: i, role: i % 2 === 0 ? "assistant" : "user", text: `message number ${i}` }));
    }
    buildDb(dbPath, rows);

    const db = openKbRead(dbPath);
    const window = entriesWindow(db, "sess-1", 20, 5);
    expect(window.map((l) => l.entryIndex)).toEqual([15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25]);

    const { head, tail } = sessionBookends(db, "sess-1", 3, 3);
    expect(head.map((l) => l.entryIndex)).toEqual([1, 2, 3]);
    expect(tail.map((l) => l.entryIndex)).toEqual([38, 39, 40]);

    const reading = sessionEntries(db, "sess-1", 20, 10);
    expect(reading.total).toBe(40);
    expect(reading.head).toHaveLength(20);
    expect(reading.tail.map((l) => l.entryIndex)).toEqual([31, 32, 33, 34, 35, 36, 37, 38, 39, 40]);
    db.close();
  });

  it("filters by collection, role, and excluded sources", () => {
    const tmp = withTmpRondel();
    const dbPath = agentDbPath(join(tmp.stateDir, "knowledge"), "kai");
    buildDb(dbPath, [
      row({ entryIndex: 1, sourceId: "sess-1", text: "shared topic alpha" }),
      row({ entryIndex: 1, sourceId: "sess-2", text: "shared topic alpha again" }),
      row({ entryIndex: 2, sourceId: "sess-1", role: "tool", text: "rondel_bash" }),
      row({ entryIndex: 0, sourceId: "MEMORY.md", collection: "memory", mode: "section", role: "section", text: "alpha is the project codename" }),
    ]);

    const db = openKbRead(dbPath);
    const memOnly = searchEntries(db, { match: toMatchExpression("alpha"), collections: ["memory"], limit: 10 });
    expect(memOnly).toHaveLength(1);
    expect(memOnly[0]!.collection).toBe("memory");

    const excluded = searchEntries(db, { match: toMatchExpression("alpha"), excludeSourceIds: ["sess-1"], limit: 10 });
    expect(excluded.every((h) => h.sourceId !== "sess-1")).toBe(true);

    const toolHits = searchEntries(db, { match: toMatchExpression("rondel_bash"), roles: ["tool"], limit: 10 });
    expect(toolHits).toHaveLength(1);
    db.close();
  });

  it("listSessions and collectionStats summarize the corpus", () => {
    const tmp = withTmpRondel();
    const dbPath = agentDbPath(join(tmp.stateDir, "knowledge"), "kai");
    buildDb(dbPath, [
      row({ sourceId: "sess-1", entryIndex: 1, text: "first question", ts: "2026-06-01T00:00:00.000Z" }),
      row({ sourceId: "sess-2", entryIndex: 1, text: "newer question", ts: "2026-06-09T00:00:00.000Z" }),
      row({ sourceId: "cron_x", entryIndex: 1, mode: "cron", text: "cron chatter", ts: "2026-06-08T00:00:00.000Z" }),
    ]);
    const db = openKbRead(dbPath);
    const sessions = listSessions(db, { limit: 10, modes: ["main", "agent-mail"] });
    expect(sessions.map((s) => s.sessionId)).toEqual(["sess-2", "sess-1"]);
    expect(sessions[0]!.preview).toContain("newer question");

    const stats = collectionStats(db);
    expect(stats.find((s) => s.collection === "sessions")!.sourceCount).toBe(3);
    db.close();
  });

  it("openKbRead throws on a missing file (caller maps to unavailable)", () => {
    const tmp = withTmpRondel();
    expect(() => openKbRead(join(tmp.stateDir, "knowledge", "ghost.sqlite"))).toThrow();
  });
});

describe("toMatchExpression", () => {
  it.each([
    ["why (broken", '"why" "(broken"'],
    ['a OR b', '"a" "OR" "b"'],
    ['NEAR(term', '"NEAR(term"'],
    ['"quoted" phrase', '"quoted" "phrase"'],
    ["star*", '"star*"'],
  ] as const)("neutralizes FTS operators in %j", (input, expected) => {
    expect(toMatchExpression(input)).toBe(expected);
  });

  it("never throws when used as a MATCH expression", () => {
    const tmp = withTmpRondel();
    const dbPath = agentDbPath(join(tmp.stateDir, "knowledge"), "kai");
    buildDb(dbPath, [row({ text: "anything" })]);
    const db = openKbRead(dbPath);
    for (const nasty of ["why (broken", "a OR b -c", 'NEAR("x", 3)', "* * *", '"""']) {
      const match = toMatchExpression(nasty);
      if (match.length === 0) continue;
      expect(() => searchEntries(db, { match, limit: 3 })).not.toThrow();
    }
    db.close();
  });
});
