import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { registerAskUserTool } from "./ask-user.js";
import {
  createFakeMcpServer,
  parseResult,
  startMockBridge,
  type ToolHandler,
} from "./_test-harness.js";

/**
 * Integration tests for rondel_ask_user.
 *
 * The tool runs in the per-agent MCP server process and talks to the bridge
 * over HTTP. We capture its handler via a fake McpServer, point it at an
 * in-process mock bridge, and drive the POST/GET flow (happy path, timeout,
 * daemon-restart 404).
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
  registerAskUserTool(fake as unknown as Parameters<typeof registerAskUserTool>[0]);
  const handler = fake.handlers.get("rondel_ask_user");
  if (!handler) throw new Error("rondel_ask_user was not registered");
  return handler;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("rondel_ask_user — env gating", () => {
  it("fails fast when bridge context is missing", async () => {
    const handler = registerAndGetHandler();
    const result = await handler({
      prompt: "Pick one",
      options: [{ label: "a" }, { label: "b" }],
    });
    const { json, isError } = parseResult(result);
    expect(isError).toBe(true);
    expect(json.error).toMatch(/bridge context/i);
  });
});

describe("rondel_ask_user — happy path", () => {
  it("returns the selected option and emits a success ledger event", async () => {
    const bridge = await startMockBridge();
    disposers.push(bridge.stop);
    setEnv(bridge.url);
    bridge.askUserResponse = {
      status: "resolved",
      selected_index: 1,
      selected_label: "blue",
      resolvedBy: "telegram:101",
    };

    const handler = registerAndGetHandler();
    const result = await handler({
      prompt: "Pick a color",
      options: [{ label: "red" }, { label: "blue" }, { label: "green" }],
      timeout_ms: 10_000,
    });
    const { json, isError } = parseResult(result);

    expect(isError).toBe(false);
    expect(json.selected_index).toBe(1);
    expect(json.selected_label).toBe("blue");
    expect(json.resolved_by).toBe("telegram:101");

    const postCalls = bridge.calls.filter(
      (c) => c.method === "POST" && c.path === "/prompts/ask-user",
    );
    expect(postCalls).toHaveLength(1);
    const postBody = postCalls[0].body as Record<string, unknown>;
    expect(postBody.agentName).toBe("bot1");
    expect(postBody.channelType).toBe("telegram");
    expect(postBody.chatId).toBe("42");
    expect(postBody.prompt).toBe("Pick a color");

    const ledgerCalls = bridge.calls.filter((c) => c.path === "/ledger/tool-call");
    expect(ledgerCalls).toHaveLength(1);
    const ledgerBody = ledgerCalls[0].body as Record<string, unknown>;
    expect(ledgerBody.toolName).toBe("rondel_ask_user");
    expect(ledgerBody.outcome).toBe("success");
    expect(String(ledgerBody.summary)).toMatch(/^ask_user: Pick a color/);
  });
});

describe("rondel_ask_user — timeout", () => {
  it("returns a timeout error and emits an error ledger event when the user doesn't answer", async () => {
    const bridge = await startMockBridge();
    disposers.push(bridge.stop);
    setEnv(bridge.url);
    bridge.askUserResponse = { status: "pending" };

    const handler = registerAndGetHandler();
    const result = await handler({
      prompt: "Pick",
      options: [{ label: "a" }, { label: "b" }],
      timeout_ms: 5_000, // tool's min; GET keeps returning pending
    });
    const { json, isError } = parseResult(result);

    expect(isError).toBe(true);
    expect(String(json.error)).toMatch(/timeout/i);

    const ledgerCalls = bridge.calls.filter((c) => c.path === "/ledger/tool-call");
    expect(ledgerCalls).toHaveLength(1);
    const ledgerBody = ledgerCalls[0].body as Record<string, unknown>;
    expect(ledgerBody.outcome).toBe("error");
    expect(ledgerBody.error).toBe("timeout");
  }, 15_000);

  it("treats a 404 on GET (daemon restart) as a timeout", async () => {
    const bridge = await startMockBridge();
    disposers.push(bridge.stop);
    setEnv(bridge.url);
    bridge.askUserMissing = true;

    const handler = registerAndGetHandler();
    const result = await handler({
      prompt: "Pick",
      options: [{ label: "a" }],
      timeout_ms: 5_000,
    });
    const { json, isError } = parseResult(result);

    expect(isError).toBe(true);
    expect(String(json.error)).toMatch(/timeout/i);
  }, 15_000);
});
