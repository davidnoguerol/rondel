import { describe, it, expect } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runRebuild, classifySession, extractEntries, splitMarkdownSections } from "./kb-rebuild.js";
import { openKbRead, searchEntries, toMatchExpression, agentDbPath } from "./kb-store.js";
import { withTmpRondel } from "../../../../tests/helpers/tmp.js";

const NO_MAIL = new Set<string>();

describe("classifySession", () => {
  it("uses the gen-2 header mode when present", () => {
    const header = { type: "session_start", version: 2, mode: "agent-mail", conversationKey: "kai:internal:agent-mail" };
    expect(classifySession(header, "abc.jsonl", NO_MAIL)).toEqual({ mode: "agent-mail", conversationKey: "kai:internal:agent-mail", skip: false });
  });

  it("skips heartbeat cron sessions entirely", () => {
    expect(classifySession(null, "cron_heartbeat_1718000000_abc.jsonl", NO_MAIL).skip).toBe(true);
  });

  it.each([
    [{ type: "session_start", chatId: "agent-mail" }, "uuid-1.jsonl", "agent-mail"],
    [{ type: "session_start", chatId: "cron:report" }, "cron_report_1.jsonl", "cron"],
    [{ type: "session_start", agentName: "kai/subagent", chatId: "42" }, "sub_99.jsonl", "subagent"],
    [{ type: "session_start", chatId: "42" }, "uuid-2.jsonl", "main"],
  ] as const)("classifies legacy headers (%j → %s)", (header, file, expected) => {
    expect(classifySession(header as Record<string, unknown>, file, NO_MAIL).mode).toBe(expected);
  });

  it("detects legacy agent-mail by sessions.json id set (UUID filename, no chatId marker)", () => {
    const ids = new Set(["mail-uuid-7"]);
    expect(classifySession({ type: "session_start", chatId: "x" }, "mail-uuid-7.jsonl", ids).mode).toBe("agent-mail");
  });
});

describe("extractEntries", () => {
  it("indexes user/assistant/tool-name/compaction with absolute line indexes; skips machinery", () => {
    const lines = [
      JSON.stringify({ type: "session_start", version: 2, sessionId: "s", agentName: "kai", mode: "main", timestamp: "t0" }),
      JSON.stringify({ type: "user", text: "what did we ship?", timestamp: "t1" }),
      JSON.stringify({ type: "cli_session", cliSessionId: "u", timestamp: "t1" }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "the invoice flow" }] }, timestamp: "t2" }),
      JSON.stringify({ type: "tool_use", id: "toolu_1", name: "rondel_bash", input: { command: "secret-cmd --token sk-abcdefghijklmnop123" }, timestamp: "t3" }),
      JSON.stringify({ type: "tool_result", id: "toolu_1", name: "rondel_bash", ok: true, result: "huge output", timestamp: "t4" }),
      JSON.stringify({ type: "turn", usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 }, stopReason: "end_turn", isError: false, toolNames: ["rondel_bash"], timestamp: "t5" }),
      JSON.stringify({ type: "compaction", trigger: "auto", summary: "we built the invoice flow", timestamp: "t6" }),
      "{malformed",
    ];
    const entries = extractEntries(lines);
    expect(entries).toEqual([
      { entryIndex: 1, role: "user", ts: "t1", text: "what did we ship?" },
      { entryIndex: 3, role: "assistant", ts: "t2", text: "the invoice flow" },
      { entryIndex: 4, role: "tool", ts: "t3", text: "rondel_bash" }, // names only — never inputs
      { entryIndex: 7, role: "compaction", ts: "t6", text: "we built the invoice flow" },
    ]);
  });

  it("strips inter-agent envelopes from user entries but keeps the body", () => {
    const lines = [
      JSON.stringify({ type: "user", text: "[Message from kai — m1]\n\nplease review the deck\n\n[End of message. Respond naturally — x]", timestamp: "t" }),
    ];
    expect(extractEntries(lines)[0]!.text).toBe("please review the deck");
  });

  it("redacts secrets at index time", () => {
    const lines = [JSON.stringify({ type: "user", text: "my key is sk-abcdefghijklmnop123", timestamp: "t" })];
    const text = extractEntries(lines)[0]!.text;
    expect(text).toContain("[REDACTED:api-key]");
    expect(text).not.toContain("sk-abcdefghijklmnop123");
  });
});

describe("splitMarkdownSections", () => {
  it("keeps small files whole and splits large files on ## headings", () => {
    expect(splitMarkdownSections("# Title\nshort body")).toHaveLength(1);
    const big = `# Doc\nintro\n## A\n${"a".repeat(1200)}\n## B\n${"b".repeat(1200)}`;
    const sections = splitMarkdownSections(big);
    expect(sections.length).toBe(3); // preamble + 2 headings
    expect(sections[1]!.text.startsWith("## A")).toBe(true);
  });
});

describe("runRebuild", () => {
  async function seedCorpus(tmpStateDir: string, agentDir: string): Promise<{ transcriptsAgentDir: string; sessionsJsonPath: string }> {
    const transcriptsAgentDir = join(tmpStateDir, "transcripts", "kai");
    await mkdir(transcriptsAgentDir, { recursive: true });

    // gen-2 main conversation
    await writeFile(
      join(transcriptsAgentDir, "sess-main.jsonl"),
      [
        JSON.stringify({ type: "session_start", version: 2, sessionId: "sess-main", agentName: "kai", mode: "main", conversationKey: "kai:telegram:42", timestamp: "2026-06-01T00:00:00Z" }),
        JSON.stringify({ type: "user", text: "let's plan the lisbon trip", timestamp: "2026-06-01T00:00:01Z" }),
        JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "booked flights for the lisbon trip" }] }, timestamp: "2026-06-01T00:00:02Z" }),
      ].join("\n") + "\n",
    );
    // legacy gen-1 conversation
    await writeFile(
      join(transcriptsAgentDir, "11111111-2222-3333-4444-555566667777.jsonl"),
      [
        JSON.stringify({ type: "session_start", sessionId: "11111111-2222-3333-4444-555566667777", agentName: "kai", chatId: "42", model: "sonnet", timestamp: "2026-05-01T00:00:00Z" }),
        JSON.stringify({ type: "user", text: "remember the flint pricing decision", timestamp: "2026-05-01T00:00:01Z" }),
      ].join("\n") + "\n",
    );
    // heartbeat churn — must be skipped
    await writeFile(
      join(transcriptsAgentDir, "cron_heartbeat_1718000000_abc.jsonl"),
      JSON.stringify({ type: "user", text: "Run the rondel-heartbeat skill heartbeat heartbeat", timestamp: "t" }) + "\n",
    );

    await mkdir(join(agentDir, "memory"), { recursive: true });
    await writeFile(join(agentDir, "MEMORY.md"), "## Preferences\nUser prefers terse updates\n", "utf-8");
    await writeFile(join(agentDir, "memory", "2026-06-01.md"), "NOTE: pricing call went well\n", "utf-8");
    await mkdir(join(agentDir, "knowledge"), { recursive: true });
    await writeFile(join(agentDir, "knowledge", "pricing-research.md"), "# Pricing\ncompetitor charges $99\n", "utf-8");

    const sessionsJsonPath = join(tmpStateDir, "sessions.json");
    await writeFile(sessionsJsonPath, "{}", "utf-8");
    return { transcriptsAgentDir, sessionsJsonPath };
  }

  it("walks all three generations + memory + knowledge, deterministically", async () => {
    const tmp = withTmpRondel();
    const agentDir = tmp.mkAgent("kai", { "AGENT.md": "agent" });
    const { transcriptsAgentDir, sessionsJsonPath } = await seedCorpus(tmp.stateDir, agentDir);
    const dbPath = agentDbPath(join(tmp.stateDir, "knowledge"), "kai");

    const stats = await runRebuild({ kind: "agent", agent: "kai", dbPath, transcriptsAgentDir, agentDir, sessionsJsonPath });
    expect(stats.rows).toBeGreaterThanOrEqual(5);

    const db = openKbRead(dbPath);
    const lisbon = searchEntries(db, { match: toMatchExpression("lisbon"), limit: 10 });
    expect(lisbon.length).toBeGreaterThanOrEqual(2);
    const flint = searchEntries(db, { match: toMatchExpression("flint pricing"), limit: 10 });
    expect(flint).toHaveLength(1);
    const heartbeat = searchEntries(db, { match: toMatchExpression("heartbeat"), limit: 10 });
    expect(heartbeat).toHaveLength(0); // heartbeat sessions skipped
    const memory = searchEntries(db, { match: toMatchExpression("terse"), collections: ["memory"], limit: 10 });
    expect(memory).toHaveLength(1);
    const knowledge = searchEntries(db, { match: toMatchExpression("competitor"), collections: ["agent-private"], limit: 10 });
    expect(knowledge).toHaveLength(1);
    const firstBuild = searchEntries(db, { match: toMatchExpression("lisbon"), limit: 10 });
    db.close();

    // Determinism: delete the db, rebuild, identical results.
    const { rm } = await import("node:fs/promises");
    await rm(dbPath, { force: true });
    await rm(`${dbPath}-wal`, { force: true });
    await rm(`${dbPath}-shm`, { force: true });
    await runRebuild({ kind: "agent", agent: "kai", dbPath, transcriptsAgentDir, agentDir, sessionsJsonPath });
    const db2 = openKbRead(dbPath);
    const secondBuild = searchEntries(db2, { match: toMatchExpression("lisbon"), limit: 10 });
    db2.close();
    expect(secondBuild).toEqual(firstBuild);
  });

  it("builds an org db from the shared knowledge dir", async () => {
    const tmp = withTmpRondel();
    const { orgDir } = tmp.mkOrgAgent("acme", "kai", { "AGENT.md": "agent" });
    const sharedKnowledgeDir = join(orgDir, "shared", "knowledge");
    await mkdir(sharedKnowledgeDir, { recursive: true });
    await writeFile(join(sharedKnowledgeDir, "okrs.md"), "# OKRs\nship the rondel memory system\n", "utf-8");

    const dbPath = join(tmp.stateDir, "knowledge", "org-acme.sqlite");
    const stats = await runRebuild({ kind: "org", org: "acme", dbPath, sharedKnowledgeDir });
    expect(stats.rows).toBe(1);

    const db = openKbRead(dbPath);
    const hits = searchEntries(db, { match: toMatchExpression("rondel memory"), limit: 5 });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.collection).toBe("org-shared");
    db.close();
  });
});
