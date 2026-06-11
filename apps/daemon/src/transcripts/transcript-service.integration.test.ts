import { describe, it, expect, vi } from "vitest";
import { mkdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { TranscriptStore } from "./transcript-store.js";
import { TranscriptService, SYNTHETIC_TTL_MS } from "./transcript-service.js";
import { withTmpRondel } from "../../../../tests/helpers/tmp.js";
import { createCapturingLogger } from "../../../../tests/helpers/logger.js";
import { createRecordingHooks } from "../../../../tests/helpers/hooks.js";

function makeService(tmpStateDir: string, opts?: { deriveCliPath?: (cwd: string, id: string) => string }) {
  const transcriptsDir = join(tmpStateDir, "transcripts");
  const store = new TranscriptStore(transcriptsDir, createCapturingLogger());
  const { hooks, records } = createRecordingHooks();
  const service = new TranscriptService({
    store,
    hooks,
    log: createCapturingLogger(),
    deriveCliPath: opts?.deriveCliPath,
  });
  return { store, hooks, records, service, transcriptsDir };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("TranscriptService genealogy", () => {
  it("appends a link on session:established and dedupes crash-restart re-fires", async () => {
    const tmp = withTmpRondel();
    const { hooks, store, service } = makeService(tmp.stateDir);
    void service;

    hooks.emit("session:established", { agentName: "kai", channelType: "telegram", chatId: "42", sessionId: "s1", resumed: false });
    hooks.emit("session:established", { agentName: "kai", channelType: "telegram", chatId: "42", sessionId: "s1", resumed: true });

    await waitFor(() => false, 100).catch(() => {}); // allow async listener writes to settle
    const genealogy = await store.readGenealogy("kai");
    expect(genealogy["kai:telegram:42"]).toHaveLength(1);
    expect(genealogy["kai:telegram:42"]![0]).toMatchObject({ sessionId: "s1", reason: "new" });
  });

  it("tags the next link user_reset after a session:reset", async () => {
    const tmp = withTmpRondel();
    const { hooks, store, service } = makeService(tmp.stateDir);
    void service;

    hooks.emit("session:established", { agentName: "kai", channelType: "telegram", chatId: "42", sessionId: "s1", resumed: false });
    hooks.emit("session:reset", { agentName: "kai", channelType: "telegram", chatId: "42", priorSessionId: "s1" });
    hooks.emit("session:established", { agentName: "kai", channelType: "telegram", chatId: "42", sessionId: "s2", resumed: false });

    await waitFor(() => false, 100).catch(() => {});
    const genealogy = await store.readGenealogy("kai");
    expect(genealogy["kai:telegram:42"]).toEqual([
      expect.objectContaining({ sessionId: "s1", reason: "new" }),
      expect.objectContaining({ sessionId: "s2", reason: "user_reset" }),
    ]);
  });

  it("init() restores the lastSession cache so headers chain parentSessionId across restarts", async () => {
    const tmp = withTmpRondel();
    const transcriptsDir = join(tmp.stateDir, "transcripts");
    const store = new TranscriptStore(transcriptsDir, createCapturingLogger());
    await store.appendSessionLink("kai", "kai:telegram:42", { sessionId: "s1", startedAt: "t1", reason: "new" });

    const { hooks } = createRecordingHooks();
    const service = new TranscriptService({ store, hooks, log: createCapturingLogger() });
    await service.init();
    expect(service.getLastSessionId("kai:telegram:42")).toBe("s1");

    const recorder = service.createRecorder(
      { agentName: "kai", sessionId: "s2", mode: "main", conversationKey: "kai:telegram:42", chatId: "42", channelType: "telegram" },
      { fresh: true },
    );
    void recorder;
    await store.flushMirror("kai", "s2");
    const header = JSON.parse((await readFile(store.mirrorPath("kai", "s2"), "utf-8")).split("\n")[0]!) as { parentSessionId?: string };
    expect(header.parentSessionId).toBe("s1");
  });

  it("rebuildGenealogyFromMirrors reconstructs chains from gen-2 headers when the index is missing", async () => {
    const tmp = withTmpRondel();
    const { store, service } = makeService(tmp.stateDir);

    const recorder1 = service.createRecorder(
      { agentName: "kai", sessionId: "s1", mode: "main", conversationKey: "kai:telegram:42", chatId: "42", channelType: "telegram" },
      { fresh: true },
    );
    void recorder1;
    await store.flushMirror("kai", "s1");
    // Simulate a lost index
    await writeFile(store.genealogyPath("kai"), "{}", "utf-8");

    await service.rebuildGenealogyFromMirrors();
    const genealogy = await store.readGenealogy("kai");
    expect(genealogy["kai:telegram:42"]).toEqual([expect.objectContaining({ sessionId: "s1", reason: "unknown" })]);
  });
});

describe("TranscriptService recorder", () => {
  it("emits transcript:appended only after the entry is on disk", async () => {
    const tmp = withTmpRondel();
    const { records, service, store } = makeService(tmp.stateDir);

    const recorder = service.createRecorder(
      { agentName: "kai", sessionId: "s1", mode: "main", conversationKey: "kai:telegram:42", chatId: "42", channelType: "telegram" },
      { fresh: true },
    );
    recorder.user("hello");
    await waitFor(() => records.some((r) => r.event === "transcript:appended"));

    const appended = records.find((r) => r.event === "transcript:appended")!.payload as { kind: string };
    expect(appended.kind).toBe("user");
    const content = await readFile(store.mirrorPath("kai", "s1"), "utf-8");
    expect(content).toContain('"text":"hello"');
  });

  it("turn() emits turn:complete with usage + tool names; compaction() emits session:compacted", async () => {
    const tmp = withTmpRondel();
    const { records, service } = makeService(tmp.stateDir);

    const recorder = service.createRecorder(
      { agentName: "kai", sessionId: "s1", mode: "main", conversationKey: "kai:telegram:42", chatId: "42", channelType: "telegram" },
      { fresh: true },
    );
    recorder.turn({
      usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 5, cacheCreationTokens: 0 },
      stopReason: "end_turn",
      isError: false,
      costUsd: 0.01,
      toolNames: ["Read", "rondel_bash"],
    });
    recorder.compaction({ trigger: "auto", summary: "summary text" });

    const turn = records.find((r) => r.event === "turn:complete")!.payload as { usage: { inputTokens: number }; toolNames: string[] };
    expect(turn.usage.inputTokens).toBe(10);
    expect(turn.toolNames).toEqual(["Read", "rondel_bash"]);

    const compacted = records.find((r) => r.event === "session:compacted")!.payload as { trigger: string; summaryLength: number };
    expect(compacted).toMatchObject({ trigger: "auto", summaryLength: "summary text".length });
  });

  it("cliSession() is idempotent per session id (crash-restart re-fires ready)", async () => {
    const tmp = withTmpRondel();
    const { service, store } = makeService(tmp.stateDir);
    const recorder = service.createRecorder(
      { agentName: "kai", sessionId: "s1", mode: "main", conversationKey: "kai:telegram:42", chatId: "42", channelType: "telegram", cwd: "/work" },
      { fresh: true },
    );
    recorder.cliSession("uuid-1", "/p/uuid-1.jsonl");
    recorder.cliSession("uuid-1", "/p/uuid-1.jsonl");
    await store.flushMirror("kai", "s1");

    const lines = (await readFile(store.mirrorPath("kai", "s1"), "utf-8")).trim().split("\n");
    expect(lines.filter((l) => l.includes("cli_session"))).toHaveLength(1);
    expect(recorder.getCliSessionId()).toBe("uuid-1");
  });

  it("cliSession() records a fresh entry when the transcript PATH changes for the same id", async () => {
    const tmp = withTmpRondel();
    const { service, store } = makeService(tmp.stateDir);
    const recorder = service.createRecorder(
      { agentName: "kai", sessionId: "s1", mode: "main", conversationKey: "kai:telegram:42", chatId: "42", channelType: "telegram", cwd: "/work" },
      { fresh: true },
    );
    recorder.cliSession("uuid-1", "/old-cwd/uuid-1.jsonl");
    recorder.cliSession("uuid-1", "/new-cwd/uuid-1.jsonl"); // cwd changed across a restart
    await store.flushMirror("kai", "s1");

    const lines = (await readFile(store.mirrorPath("kai", "s1"), "utf-8")).trim().split("\n");
    expect(lines.filter((l) => l.includes("cli_session"))).toHaveLength(2);
    // readMirrorMeta is last-wins, so the live path is the new one.
    const meta = await store.readMirrorMeta("kai", "s1");
    expect(meta?.cliTranscriptPath).toBe("/new-cwd/uuid-1.jsonl");
  });
});

describe("TranscriptService archive", () => {
  it("archives the CLI JSONL on transcript:session_closed via the recorded path", async () => {
    const tmp = withTmpRondel();
    const cliDir = join(tmp.rondelHome, "fake-cli-projects");
    const { hooks, store, service } = makeService(tmp.stateDir);
    void service;

    const sourcePath = join(cliDir, "uuid-1.jsonl");
    await mkdir(cliDir, { recursive: true });
    await writeFile(sourcePath, '{"type":"user"}\n{"type":"assistant"}\n', "utf-8");

    hooks.emit("transcript:session_closed", {
      agentName: "kai",
      mirrorSessionId: "s1",
      cliSessionId: "uuid-1",
      cliTranscriptPath: sourcePath,
      cwd: "/irrelevant",
      mode: "main",
    });

    await waitFor(() => false, 150).catch(() => {});
    const archived = await readFile(store.archivePath("kai", "s1"), "utf-8");
    expect(archived).toBe('{"type":"user"}\n{"type":"assistant"}\n');
  });

  it("derives the source path when no recorded path exists (v0.1.1 fallback)", async () => {
    const tmp = withTmpRondel();
    const cliDir = join(tmp.rondelHome, "fake-cli-projects");
    const derive = vi.fn((cwd: string, id: string) => join(cliDir, `${id}.jsonl`));
    const { hooks, store, service } = makeService(tmp.stateDir, { deriveCliPath: derive });
    void service;

    await mkdir(cliDir, { recursive: true });
    await writeFile(join(cliDir, "uuid-2.jsonl"), "line\n", "utf-8");

    hooks.emit("transcript:session_closed", {
      agentName: "kai",
      mirrorSessionId: "sub_123",
      cliSessionId: "uuid-2",
      cwd: "/work",
      mode: "subagent",
    });

    await waitFor(() => false, 150).catch(() => {});
    expect(derive).toHaveBeenCalledWith("/work", "uuid-2");
    expect(await readFile(store.archivePath("kai", "sub_123"), "utf-8")).toBe("line\n");
  });

  it("sweep self-heals: re-copies when the source grew, skips when fresh, tolerates missing sources", async () => {
    const tmp = withTmpRondel();
    const cliDir = join(tmp.rondelHome, "fake-cli-projects");
    const { store, service } = makeService(tmp.stateDir, { deriveCliPath: (_cwd, id) => join(cliDir, `${id}.jsonl`) });

    // A mirror whose cli_session records uuid-3; source exists and grows.
    const recorder = service.createRecorder(
      { agentName: "kai", sessionId: "s3", mode: "main", conversationKey: "kai:telegram:42", chatId: "42", channelType: "telegram", cwd: "/work" },
      { fresh: true },
    );
    recorder.cliSession("uuid-3");
    await store.flushMirror("kai", "s3");
    await mkdir(cliDir, { recursive: true });
    await writeFile(join(cliDir, "uuid-3.jsonl"), "v1\n", "utf-8");

    const first = await service.sweep();
    expect(first.archived).toBe(1);
    expect(await readFile(store.archivePath("kai", "s3"), "utf-8")).toBe("v1\n");

    // Unchanged source → fresh, no copy.
    const second = await service.sweep();
    expect(second.archived).toBe(0);

    // Grown source → re-copied (self-heal). Backdate nothing: size differs.
    await writeFile(join(cliDir, "uuid-3.jsonl"), "v1\nv2-more-content\n", "utf-8");
    const third = await service.sweep();
    expect(third.archived).toBe(1);
    expect(await readFile(store.archivePath("kai", "s3"), "utf-8")).toBe("v1\nv2-more-content\n");

    // No stray temp files from the atomic copy.
    const { readdir } = await import("node:fs/promises");
    const archiveDir = dirname(store.archivePath("kai", "s3"));
    const leftovers = (await readdir(archiveDir)).filter((f) => f.includes(".tmp-"));
    expect(leftovers).toEqual([]);
  });
});

describe("TranscriptService retention", () => {
  it("prunes synthetic sessions past the TTL (mirror + archive) and emits transcript:pruned; durable mirrors stay", async () => {
    const tmp = withTmpRondel();
    const { store, service, records } = makeService(tmp.stateDir, { deriveCliPath: (_c, id) => join(tmp.rondelHome, "none", `${id}.jsonl`) });

    // Old synthetic cron mirror + its archive.
    const cronRecorder = service.createRecorder({ agentName: "kai", sessionId: "cron_old_1", mode: "cron", chatId: "cron:old", cwd: "/w" }, { fresh: true });
    void cronRecorder;
    await store.flushMirror("kai", "cron_old_1");
    await mkdir(dirname(store.archivePath("kai", "cron_old_1")), { recursive: true });
    await writeFile(store.archivePath("kai", "cron_old_1"), "archived\n", "utf-8");

    // Old durable main mirror.
    const mainRecorder = service.createRecorder(
      { agentName: "kai", sessionId: "s-main", mode: "main", conversationKey: "kai:telegram:42", chatId: "42", channelType: "telegram", cwd: "/w" },
      { fresh: true },
    );
    void mainRecorder;
    await store.flushMirror("kai", "s-main");

    // Backdate both mirrors beyond the TTL.
    const old = new Date(Date.now() - SYNTHETIC_TTL_MS - 24 * 60 * 60 * 1000);
    await utimes(store.mirrorPath("kai", "cron_old_1"), old, old);
    await utimes(store.mirrorPath("kai", "s-main"), old, old);

    const { pruned } = await service.sweep();
    expect(pruned).toBe(1);
    await expect(stat(store.mirrorPath("kai", "cron_old_1"))).rejects.toThrow();
    await expect(stat(store.archivePath("kai", "cron_old_1"))).rejects.toThrow();
    await expect(stat(store.mirrorPath("kai", "s-main"))).resolves.toBeTruthy();

    const prunedEvent = records.find((r) => r.event === "transcript:pruned")!.payload as { agentName: string; sessionIds: string[] };
    expect(prunedEvent).toEqual({ agentName: "kai", sessionIds: ["cron_old_1"] });
  });

  it("leaves fresh synthetic sessions untouched", async () => {
    const tmp = withTmpRondel();
    const { store, service } = makeService(tmp.stateDir, { deriveCliPath: (_c, id) => join(tmp.rondelHome, "none", `${id}.jsonl`) });
    const recorder = service.createRecorder({ agentName: "kai", sessionId: "sub_fresh", mode: "subagent", chatId: "42", cwd: "/w" }, { fresh: true });
    void recorder;
    await store.flushMirror("kai", "sub_fresh");

    const { pruned } = await service.sweep();
    expect(pruned).toBe(0);
    await expect(stat(store.mirrorPath("kai", "sub_fresh"))).resolves.toBeTruthy();
  });

  it("never prunes a synthetic mirror that is the live tail of a genealogy chain (the agent-mail resume target)", async () => {
    const tmp = withTmpRondel();
    const { store, service } = makeService(tmp.stateDir, { deriveCliPath: (_c, id) => join(tmp.rondelHome, "none", `${id}.jsonl`) });

    for (const id of ["mail-s1", "mail-s2"]) {
      const r = service.createRecorder({ agentName: "kai", sessionId: id, mode: "agent-mail", chatId: "agent-mail", cwd: "/w" }, { fresh: true });
      void r;
      await store.flushMirror("kai", id);
    }
    await store.appendSessionLink("kai", "kai:internal:agent-mail", { sessionId: "mail-s1", startedAt: "2026-01-01T00:00:00Z", reason: "new" });
    await store.appendSessionLink("kai", "kai:internal:agent-mail", { sessionId: "mail-s2", startedAt: "2026-01-02T00:00:00Z", reason: "new" });

    const old = new Date(Date.now() - SYNTHETIC_TTL_MS - 24 * 60 * 60 * 1000);
    await utimes(store.mirrorPath("kai", "mail-s1"), old, old);
    await utimes(store.mirrorPath("kai", "mail-s2"), old, old);

    const { pruned } = await service.sweep();
    expect(pruned).toBe(1);
    await expect(stat(store.mirrorPath("kai", "mail-s1"))).rejects.toThrow(); // superseded chain link: pruned
    await expect(stat(store.mirrorPath("kai", "mail-s2"))).resolves.toBeTruthy(); // live tail: the daemon will --resume this
  });
});
