import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerBashTool } from "./bash.js";
import {
  createFakeMcpServer,
  parseResult,
  startMockBridge,
  type ToolHandler,
} from "./_test-harness.js";

/**
 * Integration tests for rondel_bash. We capture the handler as it is
 * registered on a minimal McpServer-shaped object, then invoke it
 * directly with env vars pointing at an in-process mock bridge.
 *
 * The real process would spawn the MCP server as a subprocess and drive
 * it via JSON-RPC over stdio — that coverage is deferred to an e2e
 * suite. These tests verify the tool's behavior: classification gating,
 * approval flow, execution, ledger emit.
 */

// ---------------------------------------------------------------------------
// Test lifecycle
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
  process.env.RONDEL_PARENT_AGENT = "bot1";
  process.env.RONDEL_PARENT_CHANNEL_TYPE = "telegram";
  process.env.RONDEL_PARENT_CHAT_ID = "42";
}

function registerAndGetHandler(): ToolHandler {
  const fake = createFakeMcpServer();
  // The zod type on registerTool expects a real McpServer — cast via unknown.
  registerBashTool(fake as unknown as Parameters<typeof registerBashTool>[0]);
  const handler = fake.handlers.get("rondel_bash");
  if (!handler) throw new Error("rondel_bash was not registered");
  return handler;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("rondel_bash — env-var gating", () => {
  it("fails fast when bridge context is missing", async () => {
    // No env set (beforeEach stripped them).
    const handler = registerAndGetHandler();
    const result = await handler({ command: "echo hi" });
    const { json, isError } = parseResult(result);
    expect(isError).toBe(true);
    expect(json.error).toMatch(/bridge context/i);
  });
});

describe("rondel_bash — safe commands", () => {
  it("runs a simple echo and emits a success ledger event", async () => {
    const bridge = await startMockBridge();
    disposers.push(bridge.stop);
    setEnv(bridge.url);

    const handler = registerAndGetHandler();
    const result = await handler({ command: "echo hi" });
    const { json, isError } = parseResult(result);

    expect(isError).toBe(false);
    expect(json.stdout).toBe("hi\n");
    expect(json.exit_code).toBe(0);
    expect(typeof json.duration_ms).toBe("number");
    expect(json.truncated).toBe(false);

    // Safe command: no approval request, one ledger emit with success.
    const approvalCalls = bridge.calls.filter((c) => c.path === "/approvals/tool-use");
    expect(approvalCalls).toHaveLength(0);

    const ledgerCalls = bridge.calls.filter((c) => c.path === "/ledger/tool-call");
    expect(ledgerCalls).toHaveLength(1);
    expect((ledgerCalls[0].body as Record<string, unknown>).toolName).toBe("rondel_bash");
    expect((ledgerCalls[0].body as Record<string, unknown>).outcome).toBe("success");
    expect((ledgerCalls[0].body as Record<string, unknown>).agentName).toBe("bot1");
  });

  it("honors an existing working_directory (absolute)", async () => {
    const bridge = await startMockBridge();
    disposers.push(bridge.stop);
    setEnv(bridge.url);

    const scratch = mkdtempSync(join(tmpdir(), "rondel-bash-test-"));
    disposers.push(() => rm(scratch, { recursive: true, force: true }));

    const handler = registerAndGetHandler();
    const result = await handler({ command: "pwd", working_directory: scratch });
    const { json, isError } = parseResult(result);

    expect(isError).toBe(false);
    // macOS resolves /tmp via symlink to /private/tmp. Match on ends-with.
    expect((json.stdout as string).trim()).toMatch(new RegExp(`${scratch.replace("/private", "")}$`));
  });

  it("rejects a relative working_directory without spawning", async () => {
    const bridge = await startMockBridge();
    disposers.push(bridge.stop);
    setEnv(bridge.url);

    const handler = registerAndGetHandler();
    const result = await handler({ command: "echo hi", working_directory: "relative/path" });
    const { json, isError } = parseResult(result);

    expect(isError).toBe(true);
    expect(json.error).toMatch(/absolute/i);
    // No ledger emit on pre-execution validation failures.
    const ledgerCalls = bridge.calls.filter((c) => c.path === "/ledger/tool-call");
    expect(ledgerCalls).toHaveLength(0);
  });

  it("rejects a non-existent working_directory without spawning", async () => {
    const bridge = await startMockBridge();
    disposers.push(bridge.stop);
    setEnv(bridge.url);

    const handler = registerAndGetHandler();
    const result = await handler({
      command: "echo hi",
      working_directory: "/nonexistent-rondel-test-path-xyz",
    });
    const { json, isError } = parseResult(result);

    expect(isError).toBe(true);
    expect(json.error).toMatch(/does not exist/i);
  });
});

describe("rondel_bash — approval flow", () => {
  it("escalates system-write commands and runs them when approved", async () => {
    const bridge = await startMockBridge();
    bridge.approvalDecision = "allow";
    disposers.push(bridge.stop);
    setEnv(bridge.url);

    const handler = registerAndGetHandler();
    // Use a pattern that classifies as dangerous but is safe to actually
    // execute — a stdout redirect into /etc will fail on permissions but
    // won't damage anything. The tool flow is: classify → approve →
    // execute. We verify approval and ledger calls; execution result
    // depends on OS permissions and is not asserted.
    const result = await handler({ command: "echo test > /etc/rondel-test-nonexistent" });
    parseResult(result); // still JSON

    const approvalCalls = bridge.calls.filter((c) => c.path === "/approvals/tool-use");
    expect(approvalCalls).toHaveLength(1);
    const body = approvalCalls[0].body as Record<string, unknown>;
    expect(body.toolName).toBe("rondel_bash");
    expect(body.reason).toBe("bash_system_write");
    expect(body.agentName).toBe("bot1");

    // Approved path → ledger emit runs after execution.
    const ledgerCalls = bridge.calls.filter((c) => c.path === "/ledger/tool-call");
    expect(ledgerCalls.length).toBe(1);
  }, 20_000);

  it("does NOT emit a ledger event on approval denial (command never ran)", async () => {
    const bridge = await startMockBridge();
    bridge.approvalDecision = "deny";
    disposers.push(bridge.stop);
    setEnv(bridge.url);

    const handler = registerAndGetHandler();
    // A pattern that the classifier flags — but since approval returns
    // "deny" the tool never executes.
    const result = await handler({ command: "echo pwned > /etc/passwd" });
    const { json, isError } = parseResult(result);

    expect(isError).toBe(true);
    expect(json.error).toMatch(/denied/i);

    const approvalCalls = bridge.calls.filter((c) => c.path === "/approvals/tool-use");
    expect(approvalCalls).toHaveLength(1);
    // No ledger event: the tool did not execute. The
    // approval_request / approval_decision ledger events (emitted by
    // the approval service itself) cover the denial visibility.
    const ledgerCalls = bridge.calls.filter((c) => c.path === "/ledger/tool-call");
    expect(ledgerCalls).toHaveLength(0);
  }, 20_000);
});

describe("rondel_bash — timeout", () => {
  it("kills long-running commands and reports an error", async () => {
    const bridge = await startMockBridge();
    disposers.push(bridge.stop);
    setEnv(bridge.url);

    const handler = registerAndGetHandler();
    const started = Date.now();
    const result = await handler({ command: "sleep 30", timeout_ms: 1000 });
    const elapsed = Date.now() - started;
    const { json, isError } = parseResult(result);

    expect(isError).toBe(true);
    expect(elapsed).toBeLessThan(10_000); // well under the 30s sleep
    // exit_code is null when killed by signal; error carries the timeout note.
    expect(json.error).toMatch(/timed out|timeout/i);

    const ledgerCalls = bridge.calls.filter((c) => c.path === "/ledger/tool-call");
    expect(ledgerCalls).toHaveLength(1);
    expect((ledgerCalls[0].body as Record<string, unknown>).outcome).toBe("error");
  }, 15_000);
});
