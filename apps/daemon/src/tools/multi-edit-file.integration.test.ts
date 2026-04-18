import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { registerMultiEditFileTool } from "./multi-edit-file.js";
import {
  startMockBridge,
  createFakeMcpServer,
  parseResult,
  makeScratchContext,
  type MockBridgeHandle,
  type ToolHandler,
} from "./_test-harness.js";

// ---------------------------------------------------------------------------
// Env lifecycle
// ---------------------------------------------------------------------------

const SAVED_ENV: Record<string, string | undefined> = {};
const RONDEL_VARS = [
  "RONDEL_BRIDGE_URL",
  "RONDEL_PARENT_AGENT",
  "RONDEL_PARENT_CHANNEL_TYPE",
  "RONDEL_PARENT_CHAT_ID",
  "RONDEL_PARENT_SESSION_ID",
  "RONDEL_AGENT_DIR",
  "RONDEL_HOME",
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

const disposers: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (disposers.length > 0) {
    const fn = disposers.pop();
    await fn?.();
  }
});

function setEnv(bridgeUrl: string, agentDir?: string): void {
  process.env.RONDEL_BRIDGE_URL = bridgeUrl;
  process.env.RONDEL_PARENT_AGENT = "alice";
  process.env.RONDEL_PARENT_CHANNEL_TYPE = "telegram";
  process.env.RONDEL_PARENT_CHAT_ID = "42";
  process.env.RONDEL_PARENT_SESSION_ID = "sess-m-1";
  if (agentDir) process.env.RONDEL_AGENT_DIR = agentDir;
}

function registerAndGet(): ToolHandler {
  const fake = createFakeMcpServer();
  registerMultiEditFileTool(fake as unknown as Parameters<typeof registerMultiEditFileTool>[0]);
  const handler = fake.handlers.get("rondel_multi_edit_file");
  if (!handler) throw new Error("rondel_multi_edit_file not registered");
  return handler;
}

function hashOf(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function seedReadState(bridge: MockBridgeHandle, sessionId: string, path: string, content: string): void {
  bridge.readState.set(`${sessionId}::${path}`, {
    contentHash: hashOf(content),
    readAt: new Date().toISOString(),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("rondel_multi_edit_file — prior-read requirement", () => {
  it("returns tool_error when the file has not been read", async () => {
    const scratch = makeScratchContext();
    disposers.push(() => scratch.dispose());
    const dir = scratch.mk();
    const target = join(dir, "f.txt");
    writeFileSync(target, "a b c");

    const bridge = await startMockBridge();
    disposers.push(bridge.stop);
    setEnv(bridge.url, dir);

    const handler = registerAndGet();
    const result = await handler({
      path: target,
      edits: [{ old_string: "a", new_string: "A" }],
    });
    const { isError, json } = parseResult(result);
    expect(isError).toBe(true);
    expect(json.error).toMatch(/not been read/i);
    expect(readFileSync(target, "utf-8")).toBe("a b c");
  });
});

describe("rondel_multi_edit_file — atomic all-or-nothing", () => {
  it("applies multiple edits atomically when all succeed", async () => {
    const scratch = makeScratchContext();
    disposers.push(() => scratch.dispose());
    const dir = scratch.mk();
    const target = join(dir, "f.txt");
    writeFileSync(target, "a b c");

    const bridge = await startMockBridge();
    disposers.push(bridge.stop);
    setEnv(bridge.url, dir);
    seedReadState(bridge, "sess-m-1", target, "a b c");

    const handler = registerAndGet();
    const result = await handler({
      path: target,
      edits: [
        { old_string: "a", new_string: "A" },
        { old_string: "b", new_string: "B" },
        { old_string: "c", new_string: "C" },
      ],
    });
    const { isError, json } = parseResult(result);
    expect(isError).toBe(false);
    expect(json.editCount).toBe(3);
    expect(json.totalReplacements).toBe(3);
    expect(json.backupId).toMatch(/^backup-/);
    expect(readFileSync(target, "utf-8")).toBe("A B C");

    // Exactly one ledger emit for the whole operation.
    const ledgerCalls = bridge.calls.filter((c) => c.path === "/ledger/tool-call");
    expect(ledgerCalls).toHaveLength(1);
    const ledgerBody = ledgerCalls[0].body as Record<string, unknown>;
    expect(ledgerBody.toolName).toBe("rondel_multi_edit_file");
    expect(ledgerBody.outcome).toBe("success");
  });

  it("rolls back entirely when a middle edit fails — nothing written", async () => {
    const scratch = makeScratchContext();
    disposers.push(() => scratch.dispose());
    const dir = scratch.mk();
    const target = join(dir, "f.txt");
    writeFileSync(target, "alpha beta gamma");

    const bridge = await startMockBridge();
    disposers.push(bridge.stop);
    setEnv(bridge.url, dir);
    seedReadState(bridge, "sess-m-1", target, "alpha beta gamma");

    const handler = registerAndGet();
    const result = await handler({
      path: target,
      edits: [
        { old_string: "alpha", new_string: "ALPHA" },
        { old_string: "NOPE", new_string: "wat" }, // fails
        { old_string: "gamma", new_string: "GAMMA" },
      ],
    });
    const { isError, json } = parseResult(result);
    expect(isError).toBe(true);
    expect(json.error).toMatch(/Edit #1/);
    // File untouched.
    expect(readFileSync(target, "utf-8")).toBe("alpha beta gamma");
    // No backup should have been taken (backup is AFTER validation).
    expect(bridge.calls.filter((c) => c.path.includes("/backup"))).toHaveLength(0);
  });

  it("subsequent edits operate on the in-memory result of prior edits", async () => {
    const scratch = makeScratchContext();
    disposers.push(() => scratch.dispose());
    const dir = scratch.mk();
    const target = join(dir, "f.txt");
    writeFileSync(target, "abc");

    const bridge = await startMockBridge();
    disposers.push(bridge.stop);
    setEnv(bridge.url, dir);
    seedReadState(bridge, "sess-m-1", target, "abc");

    const handler = registerAndGet();
    // First edit produces "xbc"; second edit replaces x with Y → "Ybc".
    const result = await handler({
      path: target,
      edits: [
        { old_string: "a", new_string: "x" },
        { old_string: "x", new_string: "Y" },
      ],
    });
    const { isError, json } = parseResult(result);
    expect(isError).toBe(false);
    expect(json.editCount).toBe(2);
    expect(readFileSync(target, "utf-8")).toBe("Ybc");
  });

  it("too-many-matches without replace_all fails with the edit index", async () => {
    const scratch = makeScratchContext();
    disposers.push(() => scratch.dispose());
    const dir = scratch.mk();
    const target = join(dir, "f.txt");
    writeFileSync(target, "foo foo foo");

    const bridge = await startMockBridge();
    disposers.push(bridge.stop);
    setEnv(bridge.url, dir);
    seedReadState(bridge, "sess-m-1", target, "foo foo foo");

    const handler = registerAndGet();
    const result = await handler({
      path: target,
      edits: [{ old_string: "foo", new_string: "bar" }],
    });
    const { isError, json } = parseResult(result);
    expect(isError).toBe(true);
    expect(json.error).toMatch(/Edit #0.*matches 3 locations/i);
    expect(readFileSync(target, "utf-8")).toBe("foo foo foo");
  });
});

describe("rondel_multi_edit_file — $-pattern literal replacement", () => {
  it("treats $&, $$, $1 as literals across sequential edits", async () => {
    const scratch = makeScratchContext();
    disposers.push(() => scratch.dispose());
    const dir = scratch.mk();
    const target = join(dir, "f.txt");
    writeFileSync(target, "A|B|C");

    const bridge = await startMockBridge();
    disposers.push(bridge.stop);
    setEnv(bridge.url, dir);
    seedReadState(bridge, "sess-m-1", target, "A|B|C");

    const handler = registerAndGet();
    const result = await handler({
      path: target,
      edits: [
        { old_string: "A", new_string: "$&" },
        { old_string: "B", new_string: "$$" },
        { old_string: "C", new_string: "$1" },
      ],
    });
    const { isError, json } = parseResult(result);
    expect(isError).toBe(false);
    expect(json.editCount).toBe(3);
    expect(readFileSync(target, "utf-8")).toBe("$&|$$|$1");
  });

  it("a later edit can depend on the literal $& produced by an earlier edit", async () => {
    // Proves split/join semantics: edit #0 emits literal `$&`, then edit #1
    // must find that literal `$&` in the buffer. With `replace()` semantics
    // edit #0 would emit the matched substring, edit #1 would fail.
    const scratch = makeScratchContext();
    disposers.push(() => scratch.dispose());
    const dir = scratch.mk();
    const target = join(dir, "f.txt");
    writeFileSync(target, "marker");

    const bridge = await startMockBridge();
    disposers.push(bridge.stop);
    setEnv(bridge.url, dir);
    seedReadState(bridge, "sess-m-1", target, "marker");

    const handler = registerAndGet();
    const result = await handler({
      path: target,
      edits: [
        { old_string: "marker", new_string: "prefix $& suffix" },
        { old_string: "$&", new_string: "FOUND" },
      ],
    });
    const { isError, json } = parseResult(result);
    expect(isError).toBe(false);
    expect(json.editCount).toBe(2);
    expect(readFileSync(target, "utf-8")).toBe("prefix FOUND suffix");
  });

  it("replace_all=true also treats $-patterns as literals", async () => {
    const scratch = makeScratchContext();
    disposers.push(() => scratch.dispose());
    const dir = scratch.mk();
    const target = join(dir, "f.txt");
    writeFileSync(target, "x x x");

    const bridge = await startMockBridge();
    disposers.push(bridge.stop);
    setEnv(bridge.url, dir);
    seedReadState(bridge, "sess-m-1", target, "x x x");

    const handler = registerAndGet();
    const result = await handler({
      path: target,
      edits: [{ old_string: "x", new_string: "$&", replace_all: true }],
    });
    const { isError } = parseResult(result);
    expect(isError).toBe(false);
    expect(readFileSync(target, "utf-8")).toBe("$& $& $&");
  });
});

describe("rondel_multi_edit_file — TOCTOU guard after approval", () => {
  it("aborts with tool_error when the file changes during the approval wait", async () => {
    const scratch = makeScratchContext();
    disposers.push(() => scratch.dispose());
    const agentDir = scratch.mk();
    const outside = scratch.mk();
    const target = join(outside, "f.txt");
    writeFileSync(target, "alpha beta gamma");

    const bridge = await startMockBridge();
    bridge.approvalDecision = "allow";
    disposers.push(bridge.stop);
    setEnv(bridge.url, agentDir);
    process.env.RONDEL_HOME = scratch.mk();
    seedReadState(bridge, "sess-m-1", target, "alpha beta gamma");

    bridge.onApprovalCreated = () => {
      writeFileSync(target, "overwritten mid-flight");
    };

    const handler = registerAndGet();
    const result = await handler({
      path: target,
      edits: [
        { old_string: "alpha", new_string: "ALPHA" },
        { old_string: "gamma", new_string: "GAMMA" },
      ],
    });
    const { isError, json } = parseResult(result);
    expect(isError).toBe(true);
    expect(json.error).toMatch(/File changed after approval was granted/i);
    // External content preserved — we did not clobber.
    expect(readFileSync(target, "utf-8")).toBe("overwritten mid-flight");
    expect(bridge.calls.filter((c) => c.path.includes("/backup"))).toHaveLength(0);

    const ledgerCalls = bridge.calls.filter((c) => c.path === "/ledger/tool-call");
    expect(ledgerCalls).toHaveLength(1);
    expect((ledgerCalls[0].body as Record<string, unknown>).outcome).toBe("error");
  }, 15_000);
});
