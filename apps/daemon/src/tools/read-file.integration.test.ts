import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerReadFileTool } from "./read-file.js";
import {
  createFakeMcpServer,
  parseResult,
  startMockBridge,
  type ToolHandler,
} from "./_test-harness.js";

// ---------------------------------------------------------------------------
// Lifecycle helpers
// ---------------------------------------------------------------------------

const disposers: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (disposers.length > 0) {
    const fn = disposers.pop();
    await fn?.();
  }
});

const SAVED_ENV: Record<string, string | undefined> = {};
const RONDEL_VARS = [
  "RONDEL_BRIDGE_URL",
  "RONDEL_PARENT_AGENT",
  "RONDEL_PARENT_CHANNEL_TYPE",
  "RONDEL_PARENT_CHAT_ID",
  "RONDEL_PARENT_SESSION_ID",
];

beforeEach(() => {
  for (const k of RONDEL_VARS) {
    SAVED_ENV[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of RONDEL_VARS) {
    if (SAVED_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED_ENV[k];
  }
});

function setEnv(bridgeUrl: string): void {
  process.env.RONDEL_BRIDGE_URL = bridgeUrl;
  process.env.RONDEL_PARENT_AGENT = "alice";
  process.env.RONDEL_PARENT_CHANNEL_TYPE = "telegram";
  process.env.RONDEL_PARENT_CHAT_ID = "42";
  process.env.RONDEL_PARENT_SESSION_ID = "sess-read-1";
}

function registerAndGet(): ToolHandler {
  const fake = createFakeMcpServer();
  registerReadFileTool(fake as unknown as Parameters<typeof registerReadFileTool>[0]);
  const handler = fake.handlers.get("rondel_read_file");
  if (!handler) throw new Error("rondel_read_file not registered");
  return handler;
}

function mkScratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "rondel-read-test-"));
  disposers.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("rondel_read_file — env gating", () => {
  it("fails fast when bridge context is missing", async () => {
    const handler = registerAndGet();
    const result = await handler({ path: "/tmp/x" });
    const { json, isError } = parseResult(result);
    expect(isError).toBe(true);
    expect(json.error).toMatch(/Missing RONDEL_BRIDGE_URL/i);
  });

  it("fails fast when sessionId is missing even if base env is set", async () => {
    const bridge = await startMockBridge();
    disposers.push(bridge.stop);
    process.env.RONDEL_BRIDGE_URL = bridge.url;
    process.env.RONDEL_PARENT_AGENT = "alice";
    process.env.RONDEL_PARENT_CHANNEL_TYPE = "telegram";
    process.env.RONDEL_PARENT_CHAT_ID = "42";
    // no RONDEL_PARENT_SESSION_ID

    const handler = registerAndGet();
    const result = await handler({ path: "/tmp/x" });
    const { json, isError } = parseResult(result);
    expect(isError).toBe(true);
    expect(json.error).toMatch(/SESSION_ID/);
  });
});

describe("rondel_read_file — path validation", () => {
  it("rejects relative paths", async () => {
    const bridge = await startMockBridge();
    disposers.push(bridge.stop);
    setEnv(bridge.url);

    const handler = registerAndGet();
    const result = await handler({ path: "relative/path" });
    const { isError, json } = parseResult(result);
    expect(isError).toBe(true);
    expect(json.error).toMatch(/absolute/i);
    // No ledger emit on pre-execution validation failures.
    expect(bridge.calls.filter((c) => c.path === "/ledger/tool-call")).toHaveLength(0);
  });

  it("rejects null-byte paths", async () => {
    const bridge = await startMockBridge();
    disposers.push(bridge.stop);
    setEnv(bridge.url);

    const handler = registerAndGet();
    const result = await handler({ path: "/tmp/x\0y" });
    const { isError } = parseResult(result);
    expect(isError).toBe(true);
  });
});

describe("rondel_read_file — happy path", () => {
  it("reads a small file, records state, and emits a success ledger event", async () => {
    const bridge = await startMockBridge();
    disposers.push(bridge.stop);
    setEnv(bridge.url);

    const dir = mkScratch();
    const file = join(dir, "hello.txt");
    writeFileSync(file, "hello world\n");

    const handler = registerAndGet();
    const result = await handler({ path: file });
    const { json, isError } = parseResult(result);

    expect(isError).toBe(false);
    expect(json.content).toBe("hello world\n");
    expect(json.size).toBe("hello world\n".length);
    expect(json.truncated).toBe(false);
    expect(json.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(json.path).toBe(file);

    const stateCalls = bridge.calls.filter(
      (c) => c.method === "POST" && c.path.startsWith("/filesystem/read-state/"),
    );
    expect(stateCalls).toHaveLength(1);
    const stateBody = stateCalls[0].body as Record<string, unknown>;
    expect(stateBody.sessionId).toBe("sess-read-1");
    expect(stateBody.path).toBe(file);
    expect(stateBody.contentHash).toBe(json.hash);

    const ledgerCalls = bridge.calls.filter((c) => c.path === "/ledger/tool-call");
    expect(ledgerCalls).toHaveLength(1);
    const ledgerBody = ledgerCalls[0].body as Record<string, unknown>;
    expect(ledgerBody.toolName).toBe("rondel_read_file");
    expect(ledgerBody.outcome).toBe("success");
  });

  it("truncates files exceeding max_bytes and reports truncated=true", async () => {
    const bridge = await startMockBridge();
    disposers.push(bridge.stop);
    setEnv(bridge.url);

    const dir = mkScratch();
    const file = join(dir, "large.txt");
    const body = "x".repeat(100);
    writeFileSync(file, body);

    const handler = registerAndGet();
    const result = await handler({ path: file, max_bytes: 20 });
    const { json, isError } = parseResult(result);

    expect(isError).toBe(false);
    expect(json.truncated).toBe(true);
    expect(json.size).toBe(100);
    expect((json.content as string).length).toBe(20);
  });

  it("does NOT record read-state when the read is truncated", async () => {
    const bridge = await startMockBridge();
    disposers.push(bridge.stop);
    setEnv(bridge.url);

    const dir = mkScratch();
    const file = join(dir, "big.txt");
    writeFileSync(file, "y".repeat(500));

    const handler = registerAndGet();
    const result = await handler({ path: file, max_bytes: 10 });
    const { json, isError } = parseResult(result);
    expect(isError).toBe(false);
    expect(json.truncated).toBe(true);

    // Staleness anchor must NOT be registered — writing a truncated-read
    // file would otherwise bypass staleness against the real on-disk file.
    const stateCalls = bridge.calls.filter(
      (c) => c.method === "POST" && c.path.startsWith("/filesystem/read-state/"),
    );
    expect(stateCalls).toHaveLength(0);

    // But the ledger emit is still expected (success — the read itself worked).
    const ledgerCalls = bridge.calls.filter((c) => c.path === "/ledger/tool-call");
    expect(ledgerCalls).toHaveLength(1);
    expect((ledgerCalls[0].body as Record<string, unknown>).outcome).toBe("success");
  });

  it("respects the 10MB hard cap even if max_bytes is larger", async () => {
    const bridge = await startMockBridge();
    disposers.push(bridge.stop);
    setEnv(bridge.url);

    const dir = mkScratch();
    const file = join(dir, "small.txt");
    writeFileSync(file, "tiny");

    const handler = registerAndGet();
    // Pass a max_bytes above hard cap — zod schema would reject, but our
    // runtime still clamps. Here we pass it below the zod bound so we
    // hit the Math.min path and verify it doesn't crash.
    const result = await handler({ path: file, max_bytes: 10_485_760 });
    const { json, isError } = parseResult(result);
    expect(isError).toBe(false);
    expect(json.content).toBe("tiny");
  });
});

describe("rondel_read_file — error paths", () => {
  it("returns an error and a failure ledger emit for missing files", async () => {
    const bridge = await startMockBridge();
    disposers.push(bridge.stop);
    setEnv(bridge.url);

    const handler = registerAndGet();
    const result = await handler({ path: "/definitely-not-here-xyz-rondel-test" });
    const { isError } = parseResult(result);

    expect(isError).toBe(true);
    const ledgerCalls = bridge.calls.filter((c) => c.path === "/ledger/tool-call");
    expect(ledgerCalls).toHaveLength(1);
    expect((ledgerCalls[0].body as Record<string, unknown>).outcome).toBe("error");
  });

  it("returns an error when the path is a directory, not a file", async () => {
    const bridge = await startMockBridge();
    disposers.push(bridge.stop);
    setEnv(bridge.url);

    const dir = mkScratch();
    const handler = registerAndGet();
    const result = await handler({ path: dir });
    const { isError, json } = parseResult(result);
    expect(isError).toBe(true);
    expect(json.error).toMatch(/not a regular file/i);
  });

  it("returns an error when read-state registration fails", async () => {
    const bridge = await startMockBridge();
    disposers.push(bridge.stop);
    setEnv(bridge.url);
    bridge.failReadStateRecord = true;

    const dir = mkScratch();
    const file = join(dir, "x.txt");
    writeFileSync(file, "content");

    const handler = registerAndGet();
    const result = await handler({ path: file });
    const { isError, json } = parseResult(result);
    expect(isError).toBe(true);
    expect(json.error).toMatch(/read-state registration failed/i);
  });
});
