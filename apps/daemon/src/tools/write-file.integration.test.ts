import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { registerWriteFileTool } from "./write-file.js";
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
  process.env.RONDEL_PARENT_SESSION_ID = "sess-w-1";
  if (agentDir) process.env.RONDEL_AGENT_DIR = agentDir;
}

function registerAndGet(): ToolHandler {
  const fake = createFakeMcpServer();
  registerWriteFileTool(fake as unknown as Parameters<typeof registerWriteFileTool>[0]);
  const handler = fake.handlers.get("rondel_write_file");
  if (!handler) throw new Error("rondel_write_file not registered");
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

describe("rondel_write_file — env + path validation", () => {
  it("errors with a clear message when bridge context is missing", async () => {
    const handler = registerAndGet();
    const result = await handler({ path: "/tmp/x", content: "hi" });
    const { json, isError } = parseResult(result);
    expect(isError).toBe(true);
    expect(json.error).toMatch(/Missing RONDEL_BRIDGE_URL/i);
  });

  it("rejects relative paths", async () => {
    const bridge = await startMockBridge();
    disposers.push(bridge.stop);
    setEnv(bridge.url);
    const handler = registerAndGet();
    const result = await handler({ path: "relative", content: "hi" });
    const { isError } = parseResult(result);
    expect(isError).toBe(true);
  });
});

describe("rondel_write_file — new file creation", () => {
  it("creates a new file with no prior read, no approval, no backup", async () => {
    const scratch = makeScratchContext();
    disposers.push(() => scratch.dispose());
    const dir = scratch.mk();
    const target = join(dir, "new.txt");

    const bridge = await startMockBridge();
    disposers.push(bridge.stop);
    setEnv(bridge.url, dir);

    const handler = registerAndGet();
    const result = await handler({ path: target, content: "fresh" });
    const { json, isError } = parseResult(result);

    expect(isError).toBe(false);
    expect(json.operation).toBe("create");
    expect(json.backupId).toBeNull();
    expect(json.bytesWritten).toBe(5);
    expect(readFileSync(target, "utf-8")).toBe("fresh");

    // No approval requested; no backup.
    expect(bridge.calls.filter((c) => c.path === "/approvals/tool-use")).toHaveLength(0);
    expect(bridge.calls.filter((c) => c.path.includes("/backup"))).toHaveLength(0);

    // One ledger success emit.
    const ledgerCalls = bridge.calls.filter((c) => c.path === "/ledger/tool-call");
    expect(ledgerCalls).toHaveLength(1);
    expect((ledgerCalls[0].body as Record<string, unknown>).outcome).toBe("success");

    // Post-write read-state recorded with new content hash.
    const stateRecordCalls = bridge.calls.filter(
      (c) => c.method === "POST" && c.path.startsWith("/filesystem/read-state/"),
    );
    expect(stateRecordCalls).toHaveLength(1);
    expect((stateRecordCalls[0].body as Record<string, unknown>).contentHash).toBe(hashOf("fresh"));
  });
});

describe("rondel_write_file — overwrite without prior read escalates", () => {
  it("escalates write_without_read when the file exists but no read recorded", async () => {
    const scratch = makeScratchContext();
    disposers.push(() => scratch.dispose());
    const dir = scratch.mk();
    const target = join(dir, "existing.txt");
    writeFileSync(target, "old");

    const bridge = await startMockBridge();
    bridge.approvalDecision = "allow";
    disposers.push(bridge.stop);
    setEnv(bridge.url, dir);

    const handler = registerAndGet();
    const result = await handler({ path: target, content: "new" });
    const { json, isError } = parseResult(result);

    expect(isError).toBe(false);
    expect(json.operation).toBe("update");
    expect(json.backupId).toMatch(/^backup-/);

    // Approval was requested with write_without_read.
    const apprCalls = bridge.calls.filter((c) => c.path === "/approvals/tool-use");
    expect(apprCalls).toHaveLength(1);
    expect((apprCalls[0].body as Record<string, unknown>).reason).toBe("write_without_read");

    // File was overwritten and backup captured.
    expect(readFileSync(target, "utf-8")).toBe("new");
  }, 15_000);

  it("returns an error and does NOT write when approval is denied", async () => {
    const scratch = makeScratchContext();
    disposers.push(() => scratch.dispose());
    const dir = scratch.mk();
    const target = join(dir, "existing.txt");
    writeFileSync(target, "old");

    const bridge = await startMockBridge();
    bridge.approvalDecision = "deny";
    disposers.push(bridge.stop);
    setEnv(bridge.url, dir);

    const handler = registerAndGet();
    const result = await handler({ path: target, content: "new" });
    const { isError } = parseResult(result);

    expect(isError).toBe(true);
    // File unchanged
    expect(readFileSync(target, "utf-8")).toBe("old");
    // No backup when denied
    expect(bridge.calls.filter((c) => c.path.includes("/backup"))).toHaveLength(0);
  }, 15_000);
});

describe("rondel_write_file — overwrite with prior read", () => {
  it("proceeds without approval when recorded hash matches", async () => {
    const scratch = makeScratchContext();
    disposers.push(() => scratch.dispose());
    const dir = scratch.mk();
    const target = join(dir, "existing.txt");
    writeFileSync(target, "old");

    const bridge = await startMockBridge();
    disposers.push(bridge.stop);
    setEnv(bridge.url, dir);
    seedReadState(bridge, "sess-w-1", target, "old");

    const handler = registerAndGet();
    const result = await handler({ path: target, content: "new" });
    const { isError, json } = parseResult(result);

    expect(isError).toBe(false);
    expect(json.operation).toBe("update");
    expect(readFileSync(target, "utf-8")).toBe("new");
    // No approval
    expect(bridge.calls.filter((c) => c.path === "/approvals/tool-use")).toHaveLength(0);
    // Backup captured
    expect(bridge.calls.filter((c) => c.path.includes("/backup"))).toHaveLength(1);
  });

  it("escalates when file changed on disk since the recorded read", async () => {
    const scratch = makeScratchContext();
    disposers.push(() => scratch.dispose());
    const dir = scratch.mk();
    const target = join(dir, "existing.txt");
    writeFileSync(target, "disk-different");

    const bridge = await startMockBridge();
    bridge.approvalDecision = "allow";
    disposers.push(bridge.stop);
    setEnv(bridge.url, dir);
    // Seed a read hash that doesn't match on-disk content.
    seedReadState(bridge, "sess-w-1", target, "old-version");

    const handler = registerAndGet();
    const result = await handler({ path: target, content: "new" });
    const { isError } = parseResult(result);
    expect(isError).toBe(false);

    const apprCalls = bridge.calls.filter((c) => c.path === "/approvals/tool-use");
    expect(apprCalls).toHaveLength(1);
    expect((apprCalls[0].body as Record<string, unknown>).reason).toBe("write_without_read");
  }, 15_000);
});

describe("rondel_write_file — secret detection", () => {
  it("escalates potential_secret_in_content when content looks like a credential", async () => {
    const scratch = makeScratchContext();
    disposers.push(() => scratch.dispose());
    const dir = scratch.mk();
    const target = join(dir, "cfg.env");

    const bridge = await startMockBridge();
    bridge.approvalDecision = "allow";
    disposers.push(bridge.stop);
    setEnv(bridge.url, dir);

    // Creating a new file, so staleness doesn't kick in. Safe zone is
    // the agent dir. The only escalation cause should be the secret.
    const secret = "AKIAIOSFODNN7EXAMPLE"; // matches aws_access_key_id pattern
    const handler = registerAndGet();
    const result = await handler({ path: target, content: `token=${secret}\n` });
    parseResult(result);

    const apprCalls = bridge.calls.filter((c) => c.path === "/approvals/tool-use");
    expect(apprCalls).toHaveLength(1);
    expect((apprCalls[0].body as Record<string, unknown>).reason).toBe("potential_secret_in_content");
  }, 15_000);
});

describe("rondel_write_file — safe-zone", () => {
  it("escalates when target is outside the agent dir and Rondel home", async () => {
    const scratch = makeScratchContext();
    disposers.push(() => scratch.dispose());
    const agentDir = scratch.mk();
    const outside = scratch.mk();
    const target = join(outside, "file.txt");

    const bridge = await startMockBridge();
    bridge.approvalDecision = "allow";
    disposers.push(bridge.stop);
    setEnv(bridge.url, agentDir);
    // Point RONDEL_HOME at a different place too.
    process.env.RONDEL_HOME = scratch.mk();

    const handler = registerAndGet();
    const result = await handler({ path: target, content: "x" });
    parseResult(result);

    const apprCalls = bridge.calls.filter((c) => c.path === "/approvals/tool-use");
    expect(apprCalls).toHaveLength(1);
    expect((apprCalls[0].body as Record<string, unknown>).reason).toBe("write_outside_safezone");
  }, 15_000);
});

describe("rondel_write_file — error paths", () => {
  it("emits a tool_call error and does NOT write when backup fails", async () => {
    const scratch = makeScratchContext();
    disposers.push(() => scratch.dispose());
    const dir = scratch.mk();
    const target = join(dir, "existing.txt");
    writeFileSync(target, "old");

    const bridge = await startMockBridge();
    bridge.failBackup = true;
    disposers.push(bridge.stop);
    setEnv(bridge.url, dir);
    seedReadState(bridge, "sess-w-1", target, "old");

    const handler = registerAndGet();
    const result = await handler({ path: target, content: "new" });
    const { isError, json } = parseResult(result);

    expect(isError).toBe(true);
    expect(json.error).toMatch(/Backup failed/i);
    expect(readFileSync(target, "utf-8")).toBe("old");

    const ledgerCalls = bridge.calls.filter((c) => c.path === "/ledger/tool-call");
    expect(ledgerCalls).toHaveLength(1);
    expect((ledgerCalls[0].body as Record<string, unknown>).outcome).toBe("error");
  });
});

describe("rondel_write_file — TOCTOU guard after approval", () => {
  it("aborts with tool_error when the file changes while awaiting approval", async () => {
    const scratch = makeScratchContext();
    disposers.push(() => scratch.dispose());
    const agentDir = scratch.mk();
    const outside = scratch.mk();
    const target = join(outside, "file.txt");
    writeFileSync(target, "pre-approval content");

    const bridge = await startMockBridge();
    bridge.approvalDecision = "allow";
    disposers.push(bridge.stop);
    setEnv(bridge.url, agentDir);
    process.env.RONDEL_HOME = scratch.mk();
    seedReadState(bridge, "sess-w-1", target, "pre-approval content");

    bridge.onApprovalCreated = () => {
      writeFileSync(target, "external override");
    };

    const handler = registerAndGet();
    const result = await handler({ path: target, content: "agent wants this" });
    const { isError, json } = parseResult(result);
    expect(isError).toBe(true);
    expect(json.error).toMatch(/File changed after approval was granted/i);

    // External change preserved. Backup never taken — we abort before it.
    expect(readFileSync(target, "utf-8")).toBe("external override");
    expect(bridge.calls.filter((c) => c.path.includes("/backup"))).toHaveLength(0);

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
    seedReadState(bridge, "sess-w-1", target, "original");

    bridge.onApprovalCreated = async () => {
      const { unlink } = await import("node:fs/promises");
      await unlink(target);
    };

    const handler = registerAndGet();
    const result = await handler({ path: target, content: "replacement" });
    const { isError, json } = parseResult(result);
    expect(isError).toBe(true);
    expect(json.error).toMatch(/File disappeared after approval/i);
    expect(bridge.calls.filter((c) => c.path.includes("/backup"))).toHaveLength(0);
  }, 15_000);

  it("fresh creates (file did not exist at escalation time) skip the TOCTOU check", async () => {
    // Even if the file suddenly appears during the approval wait (very edge),
    // writes for new files should succeed because there's nothing to back up.
    const scratch = makeScratchContext();
    disposers.push(() => scratch.dispose());
    const agentDir = scratch.mk();
    const target = join(agentDir, "new.env");

    const bridge = await startMockBridge();
    bridge.approvalDecision = "allow";
    disposers.push(bridge.stop);
    setEnv(bridge.url, agentDir);

    const secret = "AKIAIOSFODNN7EXAMPLE";
    const handler = registerAndGet();
    const result = await handler({ path: target, content: `token=${secret}\n` });
    const { isError } = parseResult(result);
    expect(isError).toBe(false);
    expect(readFileSync(target, "utf-8")).toBe(`token=${secret}\n`);
  }, 15_000);
});
