import { describe, it, expect } from "vitest";
import { mkdir, readFile, readdir, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { KbService, KbError } from "./kb-service.js";
import { KbIndexer, InlineIndexerHost } from "./kb-indexer.js";
import { agentDbPath } from "./kb-store.js";
import { runRebuild } from "./kb-rebuild.js";
import { withTmpRondel } from "../../../../tests/helpers/tmp.js";
import { createCapturingLogger } from "../../../../tests/helpers/logger.js";
import { createRecordingHooks } from "../../../../tests/helpers/hooks.js";
import type { KbCaller } from "./kb-service.js";

const CALLER: KbCaller = { agentName: "kai", channelType: "telegram", chatId: "42", isAdmin: false };
const ADMIN: KbCaller = { ...CALLER, isAdmin: true };

interface Harness {
  service: KbService;
  indexer: KbIndexer;
  agentDir: string;
  orgDir?: string;
  knowledgeDir: string;
  spillDir: string;
  transcriptsAgentDir: string;
  genealogy: Record<string, Array<{ sessionId: string }>>;
  rebuildNow: () => Promise<void>;
}

async function makeHarness(tmp: ReturnType<typeof withTmpRondel>, opts?: { org?: boolean }): Promise<Harness> {
  let agentDir: string;
  let orgDir: string | undefined;
  if (opts?.org) {
    const created = tmp.mkOrgAgent("acme", "kai", { "AGENT.md": "agent" });
    agentDir = created.agentDir;
    orgDir = created.orgDir;
  } else {
    agentDir = tmp.mkAgent("kai", { "AGENT.md": "agent" });
  }
  const knowledgeDir = join(tmp.stateDir, "knowledge");
  const spillDir = join(knowledgeDir, "spill");
  const transcriptsAgentDir = join(tmp.stateDir, "transcripts", "kai");
  await mkdir(transcriptsAgentDir, { recursive: true });
  const sessionsJsonPath = join(tmp.stateDir, "sessions.json");
  await writeFile(sessionsJsonPath, "{}", "utf-8");

  const { hooks } = createRecordingHooks();
  const log = createCapturingLogger();
  const indexer = new KbIndexer({
    knowledgeDir,
    transcriptsDir: join(tmp.stateDir, "transcripts"),
    sessionsJsonPath,
    hooks,
    resolveAgentDir: (a) => (a === "kai" ? agentDir : undefined),
    listAgents: () => ["kai"],
    listOrgs: () => (orgDir ? [{ orgName: "acme", orgDir }] : []),
    log,
    host: new InlineIndexerHost(),
    debounceMs: 15,
  });

  const genealogy: Record<string, Array<{ sessionId: string }>> = {};
  const service = new KbService({
    knowledgeDir,
    spillDir,
    transcriptsDir: join(tmp.stateDir, "transcripts"),
    indexer,
    orgLookup: () => (orgDir ? { status: "org", orgName: "acme" } : { status: "global" }),
    isKnownAgent: (a) => a === "kai",
    resolveAgentDir: (a) => (a === "kai" ? agentDir : undefined),
    resolveOrgDir: (o) => (o === "acme" ? orgDir : undefined),
    readGenealogy: async () => genealogy,
    resolveCurrentSessionId: () => undefined,
    log,
  });
  await service.init();

  const rebuildNow = async () => {
    await runRebuild({
      kind: "agent",
      agent: "kai",
      dbPath: agentDbPath(knowledgeDir, "kai"),
      transcriptsAgentDir,
      agentDir,
      sessionsJsonPath,
    });
  };

  return { service, indexer, agentDir, orgDir, knowledgeDir, spillDir, transcriptsAgentDir, genealogy, rebuildNow };
}

async function seedSession(transcriptsAgentDir: string, sessionId: string, turns: Array<[string, string]>, conversationKey?: string): Promise<void> {
  const lines = [
    JSON.stringify({ type: "session_start", version: 2, sessionId, agentName: "kai", mode: "main", ...(conversationKey ? { conversationKey } : {}), timestamp: "2026-06-01T00:00:00Z" }),
    ...turns.map(([role, text], i) =>
      role === "user"
        ? JSON.stringify({ type: "user", text, timestamp: `2026-06-01T00:00:0${i + 1}Z` })
        : JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] }, timestamp: `2026-06-01T00:00:0${i + 1}Z` }),
    ),
  ];
  await writeFile(join(transcriptsAgentDir, `${sessionId}.jsonl`), lines.join("\n") + "\n", "utf-8");
}

describe("KbService.query", () => {
  it("discovery returns the result-shape contract: snippet + window + bookends + provenance", async () => {
    const tmp = withTmpRondel();
    const h = await makeHarness(tmp);
    await seedSession(h.transcriptsAgentDir, "sess-1", [
      ["user", "I want to plan the lisbon trip for september"],
      ["assistant", "noted — researching flights"],
      ["user", "prefer TAP airlines"],
      ["assistant", "booked TAP, trip is set"],
    ]);
    await h.rebuildNow();

    const result = await h.service.query(CALLER, { query: "lisbon trip" });
    expect(result.kind).toBe("discovery");
    if (result.kind !== "discovery") return;
    expect(result.hits).toHaveLength(1);
    const hit = result.hits[0]!;
    expect(hit.snippet).toContain("«lisbon»");
    expect(hit.window.length).toBeGreaterThanOrEqual(2);
    expect(hit.bookends.head.length).toBeGreaterThanOrEqual(1);
    expect(hit.provenance.sessionId).toBe("sess-1");
    expect(hit.provenance.source).toContain("sess-1.jsonl");
  });

  it("rejects the caller's own conversation lineage", async () => {
    const tmp = withTmpRondel();
    const h = await makeHarness(tmp);
    await seedSession(h.transcriptsAgentDir, "sess-own", [["user", "discussing the lisbon secret plan"]], "kai:telegram:42");
    await seedSession(h.transcriptsAgentDir, "sess-other", [["user", "lisbon plans from another chat"]], "kai:telegram:99");
    await h.rebuildNow();
    h.genealogy["kai:telegram:42"] = [{ sessionId: "sess-own" }];

    const result = await h.service.query(CALLER, { query: "lisbon" });
    expect(result.kind).toBe("discovery");
    if (result.kind !== "discovery") return;
    expect(result.hits.map((x) => x.provenance.sessionId)).toEqual(["sess-other"]);
  });

  it("dedupes hits within one conversation lineage (best rank wins)", async () => {
    const tmp = withTmpRondel();
    const h = await makeHarness(tmp);
    // Two sessions in the SAME conversation (rotated via /new).
    await seedSession(h.transcriptsAgentDir, "sess-a", [["user", "flint pricing discussion round one"]], "kai:telegram:7");
    await seedSession(h.transcriptsAgentDir, "sess-b", [["user", "flint pricing final decision"]], "kai:telegram:7");
    await seedSession(h.transcriptsAgentDir, "sess-c", [["user", "flint pricing from a different chat"]], "kai:telegram:8");
    await h.rebuildNow();

    const result = await h.service.query(CALLER, { query: "flint pricing", limit: 10 });
    expect(result.kind).toBe("discovery");
    if (result.kind !== "discovery") return;
    const keys = result.hits.map((x) => x.conversationKey);
    expect(keys.filter((k) => k === "kai:telegram:7")).toHaveLength(1);
    expect(keys.filter((k) => k === "kai:telegram:8")).toHaveLength(1);
  });

  it("scroll and read shapes page a session", async () => {
    const tmp = withTmpRondel();
    const h = await makeHarness(tmp);
    const turns: Array<[string, string]> = [];
    for (let i = 0; i < 30; i++) turns.push([i % 2 === 0 ? "user" : "assistant", `turn ${i}`]);
    await seedSession(h.transcriptsAgentDir, "sess-long", turns);
    await h.rebuildNow();

    const scroll = await h.service.query(CALLER, { sessionId: "sess-long", aroundEntry: 15, limit: 3 });
    expect(scroll.kind).toBe("scroll");
    if (scroll.kind !== "scroll") return;
    expect(scroll.lines.map((l) => l.entryIndex)).toEqual([12, 13, 14, 15, 16, 17, 18]);

    const read = await h.service.query(CALLER, { sessionId: "sess-long" });
    expect(read.kind).toBe("read");
    if (read.kind !== "read") return;
    expect(read.totalEntries).toBe(30);
    expect(read.head).toHaveLength(20);
    expect(read.tail).toHaveLength(10);
  });

  it("browse lists recent main/agent-mail sessions", async () => {
    const tmp = withTmpRondel();
    const h = await makeHarness(tmp);
    await seedSession(h.transcriptsAgentDir, "sess-1", [["user", "hello there"]]);
    await h.rebuildNow();
    const browse = await h.service.query(CALLER, {});
    expect(browse.kind).toBe("browse");
    if (browse.kind !== "browse") return;
    expect(browse.sessions[0]!.sessionId).toBe("sess-1");
  });

  it("returns {kind:'unavailable'} (never throws) when the index is missing or corrupt", async () => {
    const tmp = withTmpRondel();
    const h = await makeHarness(tmp);
    // No rebuild — DB missing.
    await expect(h.service.query(CALLER, { query: "anything" })).resolves.toMatchObject({ kind: "unavailable" });

    // Corrupt DB file.
    await mkdir(h.knowledgeDir, { recursive: true });
    await writeFile(agentDbPath(h.knowledgeDir, "kai"), "this is not a sqlite file", "utf-8");
    await expect(h.service.query(CALLER, { query: "anything" })).resolves.toMatchObject({ kind: "unavailable" });
  });

  it("redacts at the read boundary: a planted secret appears in no result", async () => {
    const tmp = withTmpRondel();
    const h = await makeHarness(tmp);
    await seedSession(h.transcriptsAgentDir, "sess-sec", [
      ["user", "my api key is sk-plantedsecret12345678 please use it"],
      ["assistant", "stored the key sk-plantedsecret12345678 for the integration"],
    ]);
    await h.rebuildNow();

    const result = await h.service.query(CALLER, { query: "api key integration" });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("sk-plantedsecret12345678");
    expect(serialized).toContain("[REDACTED:api-key]");
  });

  it("spills oversized results to a file with a preview", async () => {
    const tmp = withTmpRondel();
    const h = await makeHarness(tmp);
    const huge = "lisbon ".repeat(8000); // one pathological message
    await seedSession(h.transcriptsAgentDir, "sess-huge", [["user", huge]]);
    await h.rebuildNow();

    const result = await h.service.query(CALLER, { query: "lisbon" });
    expect(result.kind).toBe("spilled");
    if (result.kind !== "spilled") return;
    expect(result.spillPath).toContain(h.spillDir);
    await new Promise((r) => setTimeout(r, 50)); // spill write is async
    const spilled = await readFile(result.spillPath, "utf-8");
    expect(spilled).toContain("lisbon");
  });

  it("cleanupSpill removes files older than 24h and keeps fresh ones", async () => {
    const tmp = withTmpRondel();
    const h = await makeHarness(tmp);
    const oldFile = join(h.spillDir, "kbq_old.json");
    const newFile = join(h.spillDir, "kbq_new.json");
    await writeFile(oldFile, "{}", "utf-8");
    await writeFile(newFile, "{}", "utf-8");
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await utimes(oldFile, old, old);

    const removed = await h.service.cleanupSpill();
    expect(removed).toBe(1);
    expect(await readdir(h.spillDir)).toEqual(["kbq_new.json"]);
  });
});

describe("KbService.ingest", () => {
  it("writes a file-of-record into agent-private with slug collision handling", async () => {
    const tmp = withTmpRondel();
    const h = await makeHarness(tmp);
    const first = await h.service.ingest(CALLER, { collection: "agent-private", title: "Pricing Research!", content: "v1" });
    const second = await h.service.ingest(CALLER, { collection: "agent-private", title: "Pricing Research!", content: "v2" });
    expect(first.path).toContain(join("knowledge", "pricing-research.md"));
    expect(second.path).toContain("pricing-research-2.md");
    expect(await readFile(first.path, "utf-8")).toBe("v1");
  });

  it("org-shared writes into the org's shared knowledge dir; global agents are rejected", async () => {
    const tmp = withTmpRondel();
    const withOrg = await makeHarness(tmp, { org: true });
    const result = await withOrg.service.ingest(CALLER, { collection: "org-shared", title: "OKRs", content: "ship it" });
    expect(result.path).toContain(join("shared", "knowledge", "okrs.md"));
  });

  it("rejects org-shared for agents without an org", async () => {
    const tmp = withTmpRondel();
    const h = await makeHarness(tmp);
    await expect(h.service.ingest(CALLER, { collection: "org-shared", title: "x", content: "y" })).rejects.toMatchObject({ code: "no_org" });
  });

  it("rejects path traversal in titles", async () => {
    const tmp = withTmpRondel();
    const h = await makeHarness(tmp);
    const result = await h.service.ingest(CALLER, { collection: "agent-private", title: "../../escape", content: "x" });
    // Slugification strips traversal; the file must land inside knowledge/.
    expect(result.path).toContain(join("knowledge", "escape.md"));
  });
});

describe("KbService.remove", () => {
  it("is admin-gated, backs up, unlinks", async () => {
    const tmp = withTmpRondel();
    const h = await makeHarness(tmp);
    const doc = await h.service.ingest(ADMIN, { collection: "agent-private", title: "stale", content: "old" });

    await expect(h.service.remove(CALLER, { collection: "agent-private", path: "stale.md" })).rejects.toMatchObject({ code: "forbidden" });

    const removed = await h.service.remove(ADMIN, { collection: "agent-private", path: "stale.md" });
    expect(removed.removed).toBe(doc.path);
    await expect(stat(doc.path)).rejects.toThrow();
  });

  it("rejects traversal and missing files", async () => {
    const tmp = withTmpRondel();
    const h = await makeHarness(tmp);
    await expect(h.service.remove(ADMIN, { collection: "agent-private", path: "../../../etc/passwd" })).rejects.toMatchObject({ code: "validation" });
    await expect(h.service.remove(ADMIN, { collection: "agent-private", path: "ghost.md" })).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("KbService.listCollections", () => {
  it("reports stats per collection and enforces cross-org for non-admins", async () => {
    const tmp = withTmpRondel();
    const h = await makeHarness(tmp);
    await seedSession(h.transcriptsAgentDir, "sess-1", [["user", "hello"]]);
    await h.rebuildNow();

    const result = await h.service.listCollections({ agentName: "kai", isAdmin: false });
    expect(result.org).toBe("global");
    expect(result.collections.find((c) => c.collection === "sessions")!.rowCount).toBeGreaterThan(0);

    await expect(h.service.listCollections({ agentName: "kai", isAdmin: false }, { org: "other" })).rejects.toMatchObject({ code: "cross_org" });
  });
});

describe("KbError", () => {
  it("carries its code", () => {
    expect(new KbError("forbidden", "nope").code).toBe("forbidden");
  });
});
