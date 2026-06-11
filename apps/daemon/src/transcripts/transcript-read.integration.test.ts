import { describe, it, expect } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TranscriptStore } from "./transcript-store.js";
import { TranscriptReadService } from "./transcript-read.js";
import { withTmpRondel } from "../../../../tests/helpers/tmp.js";
import { createCapturingLogger } from "../../../../tests/helpers/logger.js";

async function setup(tmp: ReturnType<typeof withTmpRondel>) {
  const transcriptsDir = join(tmp.stateDir, "transcripts");
  await mkdir(join(transcriptsDir, "kai"), { recursive: true });
  const store = new TranscriptStore(transcriptsDir, createCapturingLogger());
  const read = new TranscriptReadService(store);
  return { store, read, transcriptsDir };
}

describe("TranscriptReadService.readEntries", () => {
  it("normalizes v2 entries (redacted, tool payloads bounded) with stable indexes", async () => {
    const tmp = withTmpRondel();
    const { read, transcriptsDir } = await setup(tmp);
    // Long but not blob-shaped: a contiguous alnum run would be collapsed by
    // the base64 redaction rule before bounding ever sees it.
    const big = "lorem ipsum ".repeat(900);
    const lines = [
      JSON.stringify({ type: "session_start", version: 2, sessionId: "s1", agentName: "kai", mode: "main", parentSessionId: "s0", timestamp: "t0" }),
      JSON.stringify({ type: "user", text: "my key is sk-secretsecretsecret123", timestamp: "t1" }),
      JSON.stringify({ type: "tool_use", id: "toolu_1", name: "rondel_bash", input: { command: big }, timestamp: "t2" }),
      JSON.stringify({ type: "tool_result", id: "toolu_1", name: "rondel_bash", ok: true, result: "fine", durationMs: 42, timestamp: "t3" }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "done" }] }, timestamp: "t4" }),
      JSON.stringify({ type: "turn", usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 1, cacheCreationTokens: 0 }, stopReason: "end_turn", isError: false, costUsd: 0.01, toolNames: ["rondel_bash"], timestamp: "t5" }),
      JSON.stringify({ type: "compaction", trigger: "auto", summary: "the summary", timestamp: "t6" }),
      JSON.stringify({ type: "cli_session", cliSessionId: "uuid-1", timestamp: "t7" }),
      "{malformed",
    ];
    await writeFile(join(transcriptsDir, "kai", "s1.jsonl"), lines.join("\n") + "\n", "utf-8");

    const result = await read.readEntries("kai", "s1", { offset: 0, limit: 50 });
    expect(result).not.toBeNull();
    const entries = result!.entries;
    expect(result!.total).toBe(8); // malformed line skipped

    expect(entries[0]).toMatchObject({ type: "session_start", index: 0, version: 2, mode: "main", parentSessionId: "s0" });
    expect(entries[1]).toMatchObject({ type: "user", index: 1 });
    expect((entries[1] as { text: string }).text).toContain("[REDACTED:api-key]");
    const toolUse = entries[2] as { type: string; input: string; truncated?: boolean };
    expect(toolUse.truncated).toBe(true);
    expect(toolUse.input.length).toBeLessThanOrEqual(4_100);
    expect(entries[3]).toMatchObject({ type: "tool_result", ok: true, durationMs: 42 });
    expect(entries[5]).toMatchObject({ type: "turn", usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 1, cacheCreationTokens: 0 }, costUsd: 0.01 });
    expect(entries[6]).toMatchObject({ type: "compaction", summary: "the summary" });
    expect(entries[7]).toMatchObject({ type: "cli_session", cliSessionId: "uuid-1" });
  });

  it("handles legacy gen-1 text-only files and paginates", async () => {
    const tmp = withTmpRondel();
    const { read, transcriptsDir } = await setup(tmp);
    const lines = [
      JSON.stringify({ type: "session_start", sessionId: "legacy", agentName: "kai", chatId: "42", model: "sonnet", timestamp: "t0" }),
      ...Array.from({ length: 10 }, (_, i) => JSON.stringify({ type: "user", text: `message ${i}`, timestamp: `t${i + 1}` })),
    ];
    await writeFile(join(transcriptsDir, "kai", "legacy.jsonl"), lines.join("\n") + "\n", "utf-8");

    const page = await read.readEntries("kai", "legacy", { offset: 3, limit: 4 });
    expect(page!.total).toBe(11);
    expect(page!.entries.map((e) => e.index)).toEqual([3, 4, 5, 6]);
  });

  it("returns null for missing sessions", async () => {
    const tmp = withTmpRondel();
    const { read } = await setup(tmp);
    expect(await read.readEntries("kai", "ghost", { offset: 0, limit: 10 })).toBeNull();
  });

  it("redacts BEFORE truncating — a secret straddling the cut cannot leak its prefix", async () => {
    const tmp = withTmpRondel();
    const { read, transcriptsDir } = await setup(tmp);
    // Position the secret so the old truncate-then-redact order would cut it
    // mid-token (no longer matching the redaction pattern → prefix leak).
    // Padding is word-shaped on purpose — a contiguous alnum run would be
    // collapsed by the base64 redaction rule and defeat the placement.
    // 4076 chars of padding puts the RAW secret across the 4096 cut, while
    // the (shorter) post-redaction marker still fits inside it.
    const secret = "sk-abcdefghijklmnop123";
    const payload = "pad ".repeat(1_019) + secret + " " + "tail ".repeat(50);
    const lines = [
      JSON.stringify({ type: "session_start", version: 2, sessionId: "s2", agentName: "kai", mode: "main", timestamp: "t0" }),
      JSON.stringify({ type: "tool_result", id: "toolu_1", name: "rondel_bash", ok: true, result: payload, timestamp: "t1" }),
    ];
    await writeFile(join(transcriptsDir, "kai", "s2.jsonl"), lines.join("\n") + "\n", "utf-8");

    const result = await read.readEntries("kai", "s2", { offset: 0, limit: 10 });
    const toolResult = result!.entries[1] as { result?: string; truncated?: boolean };
    expect(toolResult.truncated).toBe(true);
    expect(toolResult.result).not.toContain("sk-abcdef");
    expect(toolResult.result).toContain("[REDACTED:");
  });

  it("never truncates mid-surrogate-pair", async () => {
    const tmp = withTmpRondel();
    const { read, transcriptsDir } = await setup(tmp);
    // JSON.stringify(payload) = quote + 2 UTF-16 units per emoji: the 4096
    // cut lands exactly between a high and low surrogate.
    const payload = "💩".repeat(2_500);
    const lines = [
      JSON.stringify({ type: "session_start", version: 2, sessionId: "s3", agentName: "kai", mode: "main", timestamp: "t0" }),
      JSON.stringify({ type: "tool_result", id: "toolu_1", name: "rondel_bash", ok: true, result: payload, timestamp: "t1" }),
    ];
    await writeFile(join(transcriptsDir, "kai", "s3.jsonl"), lines.join("\n") + "\n", "utf-8");

    const result = await read.readEntries("kai", "s3", { offset: 0, limit: 10 });
    const toolResult = result!.entries[1] as { result?: string; truncated?: boolean };
    expect(toolResult.truncated).toBe(true);
    expect(toolResult.result!.endsWith("…")).toBe(true);
    const beforeEllipsis = toolResult.result!.charCodeAt(toolResult.result!.length - 2);
    expect(beforeEllipsis >= 0xd800 && beforeEllipsis <= 0xdbff).toBe(false);
  });
});

describe("TranscriptReadService.listConversations", () => {
  it("returns genealogy chains plus unlinked mirrors grouped by mode", async () => {
    const tmp = withTmpRondel();
    const { store, read, transcriptsDir } = await setup(tmp);
    await store.appendSessionLink("kai", "kai:telegram:42", { sessionId: "s1", startedAt: "t1", reason: "new" });
    await store.appendSessionLink("kai", "kai:telegram:42", { sessionId: "s2", startedAt: "t2", reason: "user_reset" });
    await writeFile(join(transcriptsDir, "kai", "s1.jsonl"), JSON.stringify({ type: "session_start", version: 2, sessionId: "s1", agentName: "kai", mode: "main", conversationKey: "kai:telegram:42", timestamp: "t" }) + "\n", "utf-8");
    await writeFile(join(transcriptsDir, "kai", "s2.jsonl"), JSON.stringify({ type: "session_start", version: 2, sessionId: "s2", agentName: "kai", mode: "main", conversationKey: "kai:telegram:42", timestamp: "t" }) + "\n", "utf-8");
    await writeFile(join(transcriptsDir, "kai", "cron_x_1.jsonl"), JSON.stringify({ type: "session_start", version: 2, sessionId: "cron_x_1", agentName: "kai", mode: "cron", timestamp: "t" }) + "\n", "utf-8");

    const conversations = await read.listConversations("kai");
    const chain = conversations.find((c) => c.conversationKey === "kai:telegram:42")!;
    expect(chain.sessions.map((s) => s.sessionId)).toEqual(["s1", "s2"]);
    const orphans = conversations.find((c) => c.conversationKey === "kai:_unlinked:cron")!;
    expect(orphans.sessions.map((s) => s.sessionId)).toEqual(["cron_x_1"]);
  });
});

describe("TranscriptReadService.aggregateUsage", () => {
  it("rolls up turn entries into totals + byDay, honoring since/until", async () => {
    const tmp = withTmpRondel();
    const { read, transcriptsDir } = await setup(tmp);
    const turn = (ts: string, input: number, cost: number) =>
      JSON.stringify({ type: "turn", usage: { inputTokens: input, outputTokens: 10, cacheReadTokens: 5, cacheCreationTokens: 1 }, stopReason: "end_turn", isError: false, costUsd: cost, toolNames: [], timestamp: ts });
    await writeFile(
      join(transcriptsDir, "kai", "s1.jsonl"),
      [
        JSON.stringify({ type: "session_start", version: 2, sessionId: "s1", agentName: "kai", mode: "main", timestamp: "2026-06-09T00:00:00Z" }),
        turn("2026-06-09T10:00:00Z", 100, 0.01),
        turn("2026-06-10T10:00:00Z", 200, 0.02),
      ].join("\n") + "\n",
      "utf-8",
    );
    await writeFile(
      join(transcriptsDir, "kai", "s2.jsonl"),
      [turn("2026-06-10T11:00:00Z", 300, 0.03)].join("\n") + "\n",
      "utf-8",
    );

    const all = await read.aggregateUsage("kai");
    expect(all.totals).toMatchObject({ turns: 3, inputTokens: 600, outputTokens: 30 });
    expect(all.totals.estimatedCostUsd).toBeCloseTo(0.06);
    expect(all.byDay.map((d) => d.date)).toEqual(["2026-06-09", "2026-06-10"]);
    expect(all.byDay[1]!.inputTokens).toBe(500);

    const filtered = await read.aggregateUsage("kai", { sinceMs: Date.parse("2026-06-10T00:00:00Z") });
    expect(filtered.totals.turns).toBe(2);
  });
});
