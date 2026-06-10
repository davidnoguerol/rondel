import { describe, it, expect } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { TranscriptStore, loadTranscriptTurns } from "./transcript-store.js";
import type { MirrorHeader, MirrorToolResultEntry } from "../shared/types/transcripts.js";
import { withTmpRondel } from "../../../../tests/helpers/tmp.js";
import { createCapturingLogger } from "../../../../tests/helpers/logger.js";

function makeStore(dir: string): TranscriptStore {
  return new TranscriptStore(dir, createCapturingLogger());
}

function makeHeader(overrides: Partial<MirrorHeader> = {}): MirrorHeader {
  return {
    type: "session_start",
    version: 2,
    sessionId: "sess-1",
    agentName: "kai",
    mode: "main",
    conversationKey: "kai:telegram:42",
    channelType: "telegram",
    chatId: "42",
    timestamp: "2026-06-10T00:00:00.000Z",
    ...overrides,
  };
}

describe("TranscriptStore mirror writes", () => {
  it("writes the gen-2 header as the first line and appends entries after it", async () => {
    const tmp = withTmpRondel();
    const store = makeStore(join(tmp.stateDir, "transcripts"));
    await store.createMirror("kai", "sess-1", makeHeader());
    store.appendEntry("kai", "sess-1", { type: "user", text: "hi", timestamp: "2026-06-10T00:00:01.000Z" });
    await store.flushMirror("kai", "sess-1");

    const lines = (await readFile(store.mirrorPath("kai", "sess-1"), "utf-8")).trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toMatchObject({ type: "session_start", version: 2, mode: "main" });
    expect(JSON.parse(lines[1]!)).toMatchObject({ type: "user", text: "hi" });
  });

  it("never rewrites an existing mirror header (resume case)", async () => {
    const tmp = withTmpRondel();
    const store = makeStore(join(tmp.stateDir, "transcripts"));
    await store.createMirror("kai", "sess-1", makeHeader({ model: "opus" }));
    await store.createMirror("kai", "sess-1", makeHeader({ model: "sonnet" }));
    const lines = (await readFile(store.mirrorPath("kai", "sess-1"), "utf-8")).trim().split("\n");
    expect(lines).toHaveLength(1);
    expect((JSON.parse(lines[0]!) as MirrorHeader).model).toBe("opus");
  });

  it("serializes concurrent large appends — every line parses, order preserved", async () => {
    const tmp = withTmpRondel();
    const store = makeStore(join(tmp.stateDir, "transcripts"));
    await store.createMirror("kai", "sess-1", makeHeader());

    // 200 interleaved appends across 2 sessions, with payloads big enough to
    // straddle write-buffer boundaries if appends were unserialized.
    await store.createMirror("kai", "sess-2", makeHeader({ sessionId: "sess-2" }));
    const big = "x".repeat(700_000);
    for (let i = 0; i < 100; i++) {
      const entry: MirrorToolResultEntry = {
        type: "tool_result",
        id: `toolu_${i}`,
        name: "Bash",
        ok: true,
        result: i % 10 === 0 ? big : `out-${i}`,
        timestamp: new Date(1700000000000 + i).toISOString(),
      };
      store.appendEntry("kai", "sess-1", entry);
      store.appendEntry("kai", "sess-2", entry);
    }
    await store.flushMirror("kai", "sess-1");
    await store.flushMirror("kai", "sess-2");

    for (const sessionId of ["sess-1", "sess-2"]) {
      const lines = (await readFile(store.mirrorPath("kai", sessionId), "utf-8")).trim().split("\n");
      expect(lines).toHaveLength(101); // header + 100 entries
      const ids = lines.slice(1).map((l) => (JSON.parse(l) as { id: string }).id);
      expect(ids).toEqual(Array.from({ length: 100 }, (_, i) => `toolu_${i}`));
    }
  });

  it("creates the directory lazily when a resumed session appends first", async () => {
    const tmp = withTmpRondel();
    const store = makeStore(join(tmp.stateDir, "transcripts"));
    store.appendEntry("fresh-agent", "sess-9", { type: "user", text: "hello", timestamp: "2026-06-10T00:00:00.000Z" });
    await store.flushMirror("fresh-agent", "sess-9");
    const lines = (await readFile(store.mirrorPath("fresh-agent", "sess-9"), "utf-8")).trim().split("\n");
    expect(lines).toHaveLength(1);
  });
});

describe("loadTranscriptTurns", () => {
  it("reads gen-1 (text-only), gen-2 (typed), and skips tool/turn entries + malformed lines", async () => {
    const tmp = withTmpRondel();
    const path = join(tmp.stateDir, "transcripts", "kai", "mixed.jsonl");
    await mkdir(dirname(path), { recursive: true });
    const lines = [
      JSON.stringify(makeHeader()),
      JSON.stringify({ type: "user", text: "question", timestamp: "t1" }),
      JSON.stringify({ type: "cli_session", cliSessionId: "u-1", timestamp: "t1" }),
      JSON.stringify({ type: "tool_use", id: "toolu_1", name: "Read", input: { file: "x" }, timestamp: "t2" }),
      "{not json",
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "answer" }] }, timestamp: "t3" }),
      JSON.stringify({ type: "turn", usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0 }, stopReason: "end_turn", isError: false, toolNames: [], timestamp: "t4" }),
    ];
    await writeFile(path, lines.join("\n") + "\n", "utf-8");

    const turns = await loadTranscriptTurns(path);
    expect(turns).toEqual([
      { role: "user", text: "question", ts: "t1" },
      { role: "assistant", text: "answer", ts: "t3" },
    ]);
  });

  it("returns [] for a missing file", async () => {
    const tmp = withTmpRondel();
    expect(await loadTranscriptTurns(join(tmp.stateDir, "nope.jsonl"))).toEqual([]);
  });
});

describe("TranscriptStore.readMirrorMeta", () => {
  it("classifies gen-2 mirrors from the header and picks up the latest cli_session entry", async () => {
    const tmp = withTmpRondel();
    const store = makeStore(join(tmp.stateDir, "transcripts"));
    await store.createMirror("kai", "cron_job_1", makeHeader({ sessionId: "cron_job_1", mode: "cron", conversationKey: undefined }));
    store.appendEntry("kai", "cron_job_1", { type: "cli_session", cliSessionId: "uuid-1", cwd: "/work", timestamp: "t" });
    store.appendEntry("kai", "cron_job_1", { type: "cli_session", cliSessionId: "uuid-2", cliTranscriptPath: "/p/uuid-2.jsonl", timestamp: "t" });
    await store.flushMirror("kai", "cron_job_1");

    const meta = await store.readMirrorMeta("kai", "cron_job_1");
    expect(meta).toMatchObject({ mode: "cron", cliSessionId: "uuid-2", cliTranscriptPath: "/p/uuid-2.jsonl", cwd: "/work" });
  });

  it("classifies legacy gen-1 agent-mail mirrors by header chatId (UUID filename)", async () => {
    const tmp = withTmpRondel();
    const store = makeStore(join(tmp.stateDir, "transcripts"));
    const path = store.mirrorPath("kai", "0a1b2c3d-aaaa-bbbb-cccc-001122334455");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({ type: "session_start", sessionId: "0a1b2c3d-aaaa-bbbb-cccc-001122334455", agentName: "kai", chatId: "agent-mail", model: "sonnet", timestamp: "t" }) + "\n",
      "utf-8",
    );
    const meta = await store.readMirrorMeta("kai", "0a1b2c3d-aaaa-bbbb-cccc-001122334455");
    expect(meta?.mode).toBe("agent-mail");
  });

  it.each([
    ["sub_1718000000_abc", "subagent"],
    ["cron_job_1718000000_abc", "cron"],
  ] as const)("falls back to filename classification for %s → %s", async (sessionId, expected) => {
    const tmp = withTmpRondel();
    const store = makeStore(join(tmp.stateDir, "transcripts"));
    const path = store.mirrorPath("kai", sessionId);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "{not a header}\n", "utf-8");
    const meta = await store.readMirrorMeta("kai", sessionId);
    expect(meta?.mode).toBe(expected);
  });

  it("leaves unclassifiable legacy conversation mirrors as main (durable)", async () => {
    const tmp = withTmpRondel();
    const store = makeStore(join(tmp.stateDir, "transcripts"));
    const path = store.mirrorPath("kai", "11112222-3333-4444-5555-666677778888");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({ type: "session_start", sessionId: "11112222-3333-4444-5555-666677778888", agentName: "kai", chatId: "42", model: "sonnet", timestamp: "t" }) + "\n",
      "utf-8",
    );
    const meta = await store.readMirrorMeta("kai", "11112222-3333-4444-5555-666677778888");
    expect(meta?.mode).toBe("main");
  });
});

describe("TranscriptStore genealogy", () => {
  it("appends links in order and dedupes a repeated tail sessionId", async () => {
    const tmp = withTmpRondel();
    const store = makeStore(join(tmp.stateDir, "transcripts"));
    const key = "kai:telegram:42";
    await store.appendSessionLink("kai", key, { sessionId: "s1", startedAt: "t1", reason: "new" });
    await store.appendSessionLink("kai", key, { sessionId: "s1", startedAt: "t2", reason: "new" }); // crash-restart re-fire
    await store.appendSessionLink("kai", key, { sessionId: "s2", startedAt: "t3", reason: "user_reset" });

    const genealogy = await store.readGenealogy("kai");
    expect(genealogy[key]).toEqual([
      { sessionId: "s1", startedAt: "t1", reason: "new" },
      { sessionId: "s2", startedAt: "t3", reason: "user_reset" },
    ]);
  });

  it("returns {} for a missing or malformed genealogy file", async () => {
    const tmp = withTmpRondel();
    const store = makeStore(join(tmp.stateDir, "transcripts"));
    expect(await store.readGenealogy("ghost")).toEqual({});
    await mkdir(join(tmp.stateDir, "transcripts", "kai"), { recursive: true });
    await writeFile(store.genealogyPath("kai"), "{broken", "utf-8");
    expect(await store.readGenealogy("kai")).toEqual({});
  });
});
