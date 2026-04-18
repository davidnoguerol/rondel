import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { registerEditFileTool } from "./edit-file.js";
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
  process.env.RONDEL_PARENT_SESSION_ID = "sess-e-1";
  if (agentDir) process.env.RONDEL_AGENT_DIR = agentDir;
}

function registerAndGet(): ToolHandler {
  const fake = createFakeMcpServer();
  registerEditFileTool(fake as unknown as Parameters<typeof registerEditFileTool>[0]);
  const handler = fake.handlers.get("rondel_edit_file");
  if (!handler) throw new Error("rondel_edit_file not registered");
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

describe("rondel_edit_file — env + path validation", () => {
  it("errors when bridge context is missing", async () => {
    const handler = registerAndGet();
    const result = await handler({ path: "/tmp/x", old_string: "a", new_string: "b" });
    const { isError, json } = parseResult(result);
    expect(isError).toBe(true);
    expect(json.error).toMatch(/Missing RONDEL/i);
  });

  it("rejects relative paths", async () => {
    const bridge = await startMockBridge();
    disposers.push(bridge.stop);
    setEnv(bridge.url);
    const handler = registerAndGet();
    const result = await handler({ path: "rel", old_string: "a", new_string: "b" });
    const { isError } = parseResult(result);
    expect(isError).toBe(true);
  });
});

describe("rondel_edit_file — prior-read requirement", () => {
  it("returns tool_error when the file has not been read in this session", async () => {
    const scratch = makeScratchContext();
    disposers.push(() => scratch.dispose());
    const dir = scratch.mk();
    const target = join(dir, "file.txt");
    writeFileSync(target, "hello world");

    const bridge = await startMockBridge();
    disposers.push(bridge.stop);
    setEnv(bridge.url, dir);

    const handler = registerAndGet();
    const result = await handler({
      path: target,
      old_string: "hello",
      new_string: "hi",
    });
    const { isError, json } = parseResult(result);
    expect(isError).toBe(true);
    expect(json.error).toMatch(/not been read in this session/i);
    // No approval flow, no write.
    expect(bridge.calls.filter((c) => c.path === "/approvals/tool-use")).toHaveLength(0);
    expect(readFileSync(target, "utf-8")).toBe("hello world");
  });

  it("returns an error when the file does not exist", async () => {
    const scratch = makeScratchContext();
    disposers.push(() => scratch.dispose());
    const dir = scratch.mk();
    const target = join(dir, "missing.txt");

    const bridge = await startMockBridge();
    disposers.push(bridge.stop);
    setEnv(bridge.url, dir);

    const handler = registerAndGet();
    const result = await handler({ path: target, old_string: "a", new_string: "b" });
    const { isError, json } = parseResult(result);
    expect(isError).toBe(true);
    expect(json.error).toMatch(/does not exist/i);
  });
});

describe("rondel_edit_file — occurrence counting", () => {
  it("returns an error when old_string is not found", async () => {
    const scratch = makeScratchContext();
    disposers.push(() => scratch.dispose());
    const dir = scratch.mk();
    const target = join(dir, "file.txt");
    writeFileSync(target, "hello world");

    const bridge = await startMockBridge();
    disposers.push(bridge.stop);
    setEnv(bridge.url, dir);
    seedReadState(bridge, "sess-e-1", target, "hello world");

    const handler = registerAndGet();
    const result = await handler({
      path: target,
      old_string: "goodbye",
      new_string: "hi",
    });
    const { isError, json } = parseResult(result);
    expect(isError).toBe(true);
    expect(json.error).toMatch(/not found/i);
    expect(readFileSync(target, "utf-8")).toBe("hello world");
  });

  it("returns an error when old_string occurs multiple times without replace_all", async () => {
    const scratch = makeScratchContext();
    disposers.push(() => scratch.dispose());
    const dir = scratch.mk();
    const target = join(dir, "file.txt");
    writeFileSync(target, "foo foo foo");

    const bridge = await startMockBridge();
    disposers.push(bridge.stop);
    setEnv(bridge.url, dir);
    seedReadState(bridge, "sess-e-1", target, "foo foo foo");

    const handler = registerAndGet();
    const result = await handler({
      path: target,
      old_string: "foo",
      new_string: "bar",
    });
    const { isError, json } = parseResult(result);
    expect(isError).toBe(true);
    expect(json.error).toMatch(/matches 3 locations/i);
    expect(readFileSync(target, "utf-8")).toBe("foo foo foo");
  });

  it("happy path: exactly one occurrence replaces and writes", async () => {
    const scratch = makeScratchContext();
    disposers.push(() => scratch.dispose());
    const dir = scratch.mk();
    const target = join(dir, "file.txt");
    writeFileSync(target, "hello world");

    const bridge = await startMockBridge();
    disposers.push(bridge.stop);
    setEnv(bridge.url, dir);
    seedReadState(bridge, "sess-e-1", target, "hello world");

    const handler = registerAndGet();
    const result = await handler({
      path: target,
      old_string: "hello",
      new_string: "hi",
    });
    const { isError, json } = parseResult(result);
    expect(isError).toBe(false);
    expect(json.replacedCount).toBe(1);
    expect(json.backupId).toMatch(/^backup-/);
    expect(readFileSync(target, "utf-8")).toBe("hi world");
    // No escalation needed (safe zone, no secret, fresh read).
    expect(bridge.calls.filter((c) => c.path === "/approvals/tool-use")).toHaveLength(0);
    // One backup captured.
    expect(bridge.calls.filter((c) => c.path.includes("/backup"))).toHaveLength(1);
    // Ledger success emit.
    const ledgerCalls = bridge.calls.filter((c) => c.path === "/ledger/tool-call");
    expect(ledgerCalls).toHaveLength(1);
    expect((ledgerCalls[0].body as Record<string, unknown>).outcome).toBe("success");
  });

  it("replace_all=true replaces every occurrence", async () => {
    const scratch = makeScratchContext();
    disposers.push(() => scratch.dispose());
    const dir = scratch.mk();
    const target = join(dir, "file.txt");
    writeFileSync(target, "foo foo foo");

    const bridge = await startMockBridge();
    disposers.push(bridge.stop);
    setEnv(bridge.url, dir);
    seedReadState(bridge, "sess-e-1", target, "foo foo foo");

    const handler = registerAndGet();
    const result = await handler({
      path: target,
      old_string: "foo",
      new_string: "bar",
      replace_all: true,
    });
    const { isError, json } = parseResult(result);
    expect(isError).toBe(false);
    expect(json.replacedCount).toBe(3);
    expect(readFileSync(target, "utf-8")).toBe("bar bar bar");
  });

  it("replace_all=true with zero occurrences errors", async () => {
    const scratch = makeScratchContext();
    disposers.push(() => scratch.dispose());
    const dir = scratch.mk();
    const target = join(dir, "file.txt");
    writeFileSync(target, "nothing here");

    const bridge = await startMockBridge();
    disposers.push(bridge.stop);
    setEnv(bridge.url, dir);
    seedReadState(bridge, "sess-e-1", target, "nothing here");

    const handler = registerAndGet();
    const result = await handler({
      path: target,
      old_string: "xyz",
      new_string: "zzz",
      replace_all: true,
    });
    const { isError, json } = parseResult(result);
    expect(isError).toBe(true);
    expect(json.error).toMatch(/not found/i);
    expect(readFileSync(target, "utf-8")).toBe("nothing here");
  });
});

describe("rondel_edit_file — $-pattern literal replacement", () => {
  // String.prototype.replace treats `$&`, `$$`, `$1-9`, `` $` ``, `$'`,
  // `$<name>` as special patterns. We must treat `new_string` as a
  // literal, so split/join is used unconditionally.
  const DOLLAR_CASES: ReadonlyArray<{ label: string; newStr: string; expected: string }> = [
    { label: "$& (matched substring)", newStr: "value-$&", expected: "value-$&" },
    { label: "$$ (literal dollar)", newStr: "value-$$", expected: "value-$$" },
    { label: "$1 (capture group ref)", newStr: "value-$1", expected: "value-$1" },
    { label: "$' (after match)", newStr: "value-$'", expected: "value-$'" },
    { label: "$` (before match)", newStr: "value-$`", expected: "value-$`" },
  ];

  for (const { label, newStr, expected } of DOLLAR_CASES) {
    it(`replace_all=false: treats ${label} as literal`, async () => {
      const scratch = makeScratchContext();
      disposers.push(() => scratch.dispose());
      const dir = scratch.mk();
      const target = join(dir, "file.txt");
      writeFileSync(target, 'const X = "replace me";');

      const bridge = await startMockBridge();
      disposers.push(bridge.stop);
      setEnv(bridge.url, dir);
      seedReadState(bridge, "sess-e-1", target, 'const X = "replace me";');

      const handler = registerAndGet();
      const result = await handler({
        path: target,
        old_string: "replace me",
        new_string: newStr,
      });
      const { isError } = parseResult(result);
      expect(isError).toBe(false);
      expect(readFileSync(target, "utf-8")).toBe(`const X = "${expected}";`);
    });

    it(`replace_all=true: treats ${label} as literal`, async () => {
      const scratch = makeScratchContext();
      disposers.push(() => scratch.dispose());
      const dir = scratch.mk();
      const target = join(dir, "file.txt");
      writeFileSync(target, "XX YY XX");

      const bridge = await startMockBridge();
      disposers.push(bridge.stop);
      setEnv(bridge.url, dir);
      seedReadState(bridge, "sess-e-1", target, "XX YY XX");

      const handler = registerAndGet();
      const result = await handler({
        path: target,
        old_string: "XX",
        new_string: newStr,
        replace_all: true,
      });
      const { isError, json } = parseResult(result);
      expect(isError).toBe(false);
      expect(json.replacedCount).toBe(2);
      expect(readFileSync(target, "utf-8")).toBe(`${expected} YY ${expected}`);
    });
  }
});

describe("rondel_edit_file — staleness drift escalates", () => {
  it("escalates write_without_read when recorded hash mismatches on-disk content", async () => {
    const scratch = makeScratchContext();
    disposers.push(() => scratch.dispose());
    const dir = scratch.mk();
    const target = join(dir, "file.txt");
    writeFileSync(target, "disk-version");

    const bridge = await startMockBridge();
    bridge.approvalDecision = "allow";
    disposers.push(bridge.stop);
    setEnv(bridge.url, dir);
    // Seed a read hash for the OLD content, not the current on-disk content.
    seedReadState(bridge, "sess-e-1", target, "stale-version");

    const handler = registerAndGet();
    const result = await handler({
      path: target,
      old_string: "disk",
      new_string: "DISK",
    });
    parseResult(result);

    const apprCalls = bridge.calls.filter((c) => c.path === "/approvals/tool-use");
    expect(apprCalls).toHaveLength(1);
    expect((apprCalls[0].body as Record<string, unknown>).reason).toBe("write_without_read");
  }, 15_000);
});

describe("rondel_edit_file — TOCTOU guard after approval", () => {
  it("aborts with tool_error when the file changes while we wait for approval", async () => {
    const scratch = makeScratchContext();
    disposers.push(() => scratch.dispose());
    // Write outside the agent dir so escalation is triggered. RONDEL_HOME
    // also points elsewhere.
    const agentDir = scratch.mk();
    const outside = scratch.mk();
    const target = join(outside, "file.txt");
    writeFileSync(target, "original");

    const bridge = await startMockBridge();
    bridge.approvalDecision = "allow";
    disposers.push(bridge.stop);
    setEnv(bridge.url, agentDir);
    process.env.RONDEL_HOME = scratch.mk();
    seedReadState(bridge, "sess-e-1", target, "original");

    // Simulate an external writer clobbering the file while the tool is
    // blocked on the approval wait.
    bridge.onApprovalCreated = () => {
      writeFileSync(target, "clobbered by external");
    };

    const handler = registerAndGet();
    const result = await handler({
      path: target,
      old_string: "original",
      new_string: "NEW",
    });
    const { isError, json } = parseResult(result);
    expect(isError).toBe(true);
    expect(json.error).toMatch(/File changed after approval was granted/i);

    // File left as the external writer wrote it — we MUST NOT clobber.
    expect(readFileSync(target, "utf-8")).toBe("clobbered by external");
    // No backup should have been recorded: we never touched the file.
    expect(bridge.calls.filter((c) => c.path.includes("/backup"))).toHaveLength(0);

    // Ledger error emit captures the race.
    const ledgerCalls = bridge.calls.filter((c) => c.path === "/ledger/tool-call");
    expect(ledgerCalls).toHaveLength(1);
    expect((ledgerCalls[0].body as Record<string, unknown>).outcome).toBe("error");
  }, 15_000);

  it("aborts with tool_error when the file is deleted during the approval wait", async () => {
    const scratch = makeScratchContext();
    disposers.push(() => scratch.dispose());
    const agentDir = scratch.mk();
    const outside = scratch.mk();
    const target = join(outside, "file.txt");
    writeFileSync(target, "original");

    const bridge = await startMockBridge();
    bridge.approvalDecision = "allow";
    disposers.push(bridge.stop);
    setEnv(bridge.url, agentDir);
    process.env.RONDEL_HOME = scratch.mk();
    seedReadState(bridge, "sess-e-1", target, "original");

    bridge.onApprovalCreated = async () => {
      const { unlink } = await import("node:fs/promises");
      await unlink(target);
    };

    const handler = registerAndGet();
    const result = await handler({
      path: target,
      old_string: "original",
      new_string: "NEW",
    });
    const { isError, json } = parseResult(result);
    expect(isError).toBe(true);
    expect(json.error).toMatch(/File disappeared after approval/i);
    expect(bridge.calls.filter((c) => c.path.includes("/backup"))).toHaveLength(0);
  }, 15_000);
});
