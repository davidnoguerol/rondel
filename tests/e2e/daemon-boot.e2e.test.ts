/**
 * Daemon boot smoke test (Tier 3) — the end-to-end validation the memory
 * substrate ships with.
 *
 * Spawns the REAL daemon (dist/index.js) against a scratch RONDEL_HOME
 * seeded with one agent and a transcript corpus, then exercises the full
 * pipeline over the live bridge:
 *
 *   boot → /version handshake → kb index rebuild (worker thread, real
 *   node:sqlite FTS5) → POST /kb/query (verbatim hit with provenance,
 *   redaction) → POST /memory/:agent/append (structured op + backup +
 *   ledger row) → GET /memory/:agent → GET /transcripts/:agent/sessions
 *   (genealogy + orphans) → entries endpoint (normalized + redacted) →
 *   usage rollup → SIGTERM clean shutdown.
 *
 * No Claude CLI process is ever spawned: conversations spawn lazily on
 * first message and this test never sends one. Costs nothing, hits no
 * network, runs in ~5s. Requires a prior `pnpm build` (vitest config
 * orders e2e after unit/integration; CI runs build first).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DAEMON_ENTRY = join(REPO_ROOT, "apps", "daemon", "dist", "index.js");

const BOOT_TIMEOUT_MS = 30_000;

let home: string;
let daemon: ChildProcess | null = null;
let bridgeUrl = "";
let daemonLog = "";

async function seedScratchHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rondel-e2e-"));
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "config.json"), JSON.stringify({ allowedUsers: ["e2e-smoke"] }, null, 2));
  const agentDir = join(root, "workspaces", "global", "agents", "smokey");
  await mkdir(agentDir, { recursive: true });
  await writeFile(
    join(agentDir, "agent.json"),
    JSON.stringify(
      {
        agentName: "smokey",
        enabled: true,
        model: "sonnet",
        workingDirectory: null,
        // "smoke" has no adapter implementation — the daemon warns and skips
        // it (no network); the synthetic web binding still registers, so the
        // bridge is fully functional. SMOKE_FAKE_TOKEN is set in the spawn env.
        channels: [{ channelType: "smoke", accountId: "smokey", credentialEnvVar: "SMOKE_FAKE_TOKEN" }],
        tools: { allowed: [], disallowed: [] },
      },
      null,
      2,
    ),
  );
  await writeFile(join(agentDir, "AGENT.md"), "# Smokey\nA smoke-test agent.\n");
  // Legacy free-prose MEMORY.md — exercises §5.5 migration on first append.
  await writeFile(join(agentDir, "MEMORY.md"), "# Smokey's Memory\n## Facts\nThe owner runs three companies.\n");

  // Seed a gen-2 mirror with searchable content + a planted secret.
  const transcriptsDir = join(root, "state", "transcripts", "smokey");
  await mkdir(transcriptsDir, { recursive: true });
  const mirror = [
    JSON.stringify({ type: "session_start", version: 2, sessionId: "sess-e2e-1", agentName: "smokey", mode: "main", conversationKey: "smokey:web:web-main", channelType: "web", chatId: "web-main", timestamp: "2026-06-09T10:00:00.000Z" }),
    JSON.stringify({ type: "user", text: "let's finalize the lisbon offsite agenda, key is sk-plantedsecretvalue123", timestamp: "2026-06-09T10:00:01.000Z" }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "agenda drafted: lisbon offsite day one is workshops" }] }, timestamp: "2026-06-09T10:00:02.000Z" }),
    JSON.stringify({ type: "tool_use", id: "toolu_e2e", name: "rondel_task_create", input: { title: "book venue" }, timestamp: "2026-06-09T10:00:03.000Z" }),
    JSON.stringify({ type: "turn", usage: { inputTokens: 1200, outputTokens: 80, cacheReadTokens: 900, cacheCreationTokens: 0 }, stopReason: "end_turn", isError: false, costUsd: 0.005, toolNames: ["rondel_task_create"], timestamp: "2026-06-09T10:00:04.000Z" }),
  ];
  await writeFile(join(transcriptsDir, "sess-e2e-1.jsonl"), mirror.join("\n") + "\n");
  return root;
}

async function waitForBridge(stateDir: string): Promise<string> {
  const lockPath = join(stateDir, "rondel.lock");
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  for (;;) {
    if (Date.now() > deadline) throw new Error(`daemon did not publish a bridge URL in time. Log:\n${daemonLog}`);
    if (existsSync(lockPath)) {
      try {
        const lock = JSON.parse(await readFile(lockPath, "utf-8")) as { bridgeUrl?: string };
        if (lock.bridgeUrl && lock.bridgeUrl.startsWith("http")) return lock.bridgeUrl;
      } catch {
        /* partial write — retry */
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function getJson(path: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${bridgeUrl}${path}`);
  return { status: res.status, body: await res.json() };
}

async function postJson(path: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${bridgeUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

/** Poll until the kb index answers with hits (worker rebuild is async). */
async function waitForKbHit(query: string, timeoutMs = 20_000): Promise<Record<string, unknown>> {
  const caller = { agentName: "smokey", channelType: "web", chatId: "e2e-probe" };
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { body } = await postJson("/kb/query", { caller, args: { query } });
    const result = body as { kind: string; hits?: unknown[] };
    if (result.kind === "discovery" && (result.hits?.length ?? 0) > 0) return result as Record<string, unknown>;
    if (Date.now() > deadline) throw new Error(`kb never returned hits for "${query}": ${JSON.stringify(body).slice(0, 400)}\nLog:\n${daemonLog.slice(-2000)}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

beforeAll(async () => {
  if (!existsSync(DAEMON_ENTRY)) {
    throw new Error(`dist build missing at ${DAEMON_ENTRY} — run pnpm build first`);
  }
  home = await seedScratchHome();
  daemon = spawn(process.execPath, [DAEMON_ENTRY], {
    env: { ...process.env, RONDEL_HOME: home, RONDEL_DAEMON: "", SMOKE_FAKE_TOKEN: "not-a-real-credential" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  daemon.stdout?.on("data", (d: Buffer) => (daemonLog += d.toString()));
  daemon.stderr?.on("data", (d: Buffer) => (daemonLog += d.toString()));
  bridgeUrl = await waitForBridge(join(home, "state"));
}, BOOT_TIMEOUT_MS + 5_000);

afterAll(async () => {
  if (daemon && daemon.exitCode === null) {
    daemon.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        daemon?.kill("SIGKILL");
        resolve();
      }, 5_000);
      daemon!.on("exit", () => {
        clearTimeout(t);
        resolve();
      });
    });
  }
  if (home) await rm(home, { recursive: true, force: true });
});

describe("daemon boot smoke (real daemon, scratch home, no Claude spawns)", () => {
  it("serves the version handshake", async () => {
    const { status, body } = await getJson("/version");
    expect(status).toBe(200);
    expect(body).toMatchObject({ apiVersion: 21 });
  });

  it("kb pipeline: worker rebuild → verbatim discovery hit with provenance, secrets redacted", async () => {
    const result = await waitForKbHit("lisbon offsite");
    const hits = result.hits as Array<{ snippet: string; provenance: { sessionId?: string }; window: Array<{ text: string }> }>;
    expect(hits[0]!.provenance.sessionId).toBe("sess-e2e-1");
    expect(hits[0]!.snippet).toContain("«lisbon»");

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("sk-plantedsecretvalue123");
    expect(serialized).toContain("[REDACTED:api-key]");
  }, 30_000);

  it("memory pipeline: structured append migrates legacy prose and persists", async () => {
    const append = await postJson("/memory/smokey/append", { entry: "Owner prefers terse updates" });
    expect(append.status).toBe(200);
    expect(append.body).toMatchObject({ ok: true, migrated: true });

    const memory = await getJson("/memory/smokey");
    const content = (memory.body as { content: string }).content;
    expect(content).toContain("Owner prefers terse updates");
    expect(content).toContain("Legacy memory preserved at memory/topics/legacy.md");

    const legacyTopic = await readFile(join(home, "workspaces", "global", "agents", "smokey", "memory", "topics", "legacy.md"), "utf-8");
    expect(legacyTopic).toContain("The owner runs three companies.");
  });

  it("consolidate-on-overflow returns every entry with a 409", async () => {
    // Default cap is 8192 bytes; ~60 entries of ~140B fill it.
    let overflow: { status: number; body: unknown } | null = null;
    for (let i = 0; i < 80; i++) {
      const res = await postJson("/memory/smokey/append", { entry: `bulk fact ${i} ${"x".repeat(110)}` });
      if (res.status === 409) {
        overflow = res;
        break;
      }
      expect(res.status).toBe(200);
    }
    expect(overflow).not.toBeNull();
    const body = overflow!.body as { code: string; entries: string[] };
    expect(body.code).toBe("index_overflow");
    expect(body.entries.length).toBeGreaterThan(10);
  });

  it("transcript browser: sessions, normalized entries (redacted), usage rollup", async () => {
    const sessions = await getJson("/transcripts/smokey/sessions");
    expect(sessions.status).toBe(200);
    const conversations = (sessions.body as { conversations: Array<{ conversationKey: string; sessions: Array<{ sessionId: string }> }> }).conversations;
    expect(conversations.some((c) => c.sessions.some((s) => s.sessionId === "sess-e2e-1"))).toBe(true);

    const entries = await getJson("/transcripts/smokey/sessions/sess-e2e-1/entries");
    expect(entries.status).toBe(200);
    const entryList = (entries.body as { entries: Array<{ type: string; text?: string }> }).entries;
    expect(entryList.map((e) => e.type)).toEqual(["session_start", "user", "assistant", "tool_use", "turn"]);
    expect(entryList[1]!.text).toContain("[REDACTED:api-key]");

    const usage = await getJson("/transcripts/smokey/usage");
    expect(usage.status).toBe(200);
    expect((usage.body as { totals: { turns: number; inputTokens: number } }).totals).toMatchObject({ turns: 1, inputTokens: 1200 });
  });

  it("ledger recorded the memory writes", async () => {
    const ledger = await readFile(join(home, "state", "ledger", "smokey.jsonl"), "utf-8");
    expect(ledger).toContain('"kind":"memory_saved"');
    expect(ledger).toContain('"op":"migrate"');
  });

  it("shuts down cleanly on SIGTERM", async () => {
    daemon!.kill("SIGTERM");
    const code = await new Promise<number | null>((resolve) => {
      const t = setTimeout(() => resolve(null), 8_000);
      daemon!.on("exit", (c) => {
        clearTimeout(t);
        resolve(c);
      });
    });
    expect(code).toBe(0);
    daemon = null;
  });
});
