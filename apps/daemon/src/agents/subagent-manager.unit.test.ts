/**
 * Subagent MCP env wiring test.
 *
 * Filesystem-capable MCP tools require RONDEL_PARENT_SESSION_ID, plus a
 * parent channel+chat id for approval routing. These are stamped into the
 * MCP config at spawn time. If they go missing, subagents can't write
 * files at all (the env validator rejects the call). This test asserts
 * the exact env surface rather than running a full subagent — a dedicated
 * unit test for what is otherwise only exercised end-to-end.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const capturedOptions: Array<{ id: string; mcpConfig: unknown }> = [];

// Hoisted mock of SubagentProcess so we can capture the options the manager
// passes in without actually spawning a Claude CLI process.
vi.mock("./subagent-process.js", () => {
  class FakeSubagentProcess {
    readonly done: Promise<{ state: string }> = Promise.resolve({ state: "completed" });
    constructor(options: { id: string; mcpConfig?: unknown }) {
      capturedOptions.push({ id: options.id, mcpConfig: options.mcpConfig });
    }
    getId(): string {
      return "fake";
    }
    getState(): string {
      return "running";
    }
    getResult(): { state: string } {
      return { state: "running" };
    }
    start(): void {
      /* no-op */
    }
    kill(): void {
      /* no-op */
    }
  }
  return { SubagentProcess: FakeSubagentProcess };
});

// Avoid hitting disk for transcripts.
vi.mock("../shared/transcript.js", () => ({
  resolveTranscriptPath: () => "/tmp/ignored",
  createTranscript: vi.fn(async () => undefined),
}));

import { SubagentManager } from "./subagent-manager.js";
import { createLogger } from "../shared/logger.js";
import type { AgentConfig } from "../shared/types/index.js";

function makeTemplate(): { config: AgentConfig; systemPrompt: string } {
  const config: AgentConfig = {
    name: "alice",
    model: "sonnet",
    tools: { allowed: [], disallowed: [] },
    channels: [],
    admin: false,
  } as unknown as AgentConfig;
  return { config, systemPrompt: "You are Alice." };
}

describe("SubagentManager.spawn — MCP env wiring", () => {
  beforeEach(() => {
    capturedOptions.length = 0;
  });

  it("stamps RONDEL_PARENT_SESSION_ID, channel type, and chat id so filesystem tools work", async () => {
    const template = makeTemplate();
    const manager = new SubagentManager(
      "/tmp/rondel-home",
      "/tmp/transcripts",
      "/tmp/mcp-server.js",
      () => "http://127.0.0.1:12345",
      (name) => (name === "alice" ? template : undefined),
      undefined,
      createLogger("test"),
    );

    await manager.spawn({
      parentAgentName: "alice",
      parentChannelType: "telegram",
      parentAccountId: "bot1",
      parentChatId: "42",
      task: "do stuff",
      systemPrompt: "helper",
    });

    expect(capturedOptions).toHaveLength(1);
    const mcp = capturedOptions[0].mcpConfig as {
      rondel: { env: Record<string, string> };
    };
    const env = mcp.rondel.env;

    // All four env vars filesystem tools need must be present.
    expect(env.RONDEL_BRIDGE_URL).toBe("http://127.0.0.1:12345");
    expect(env.RONDEL_PARENT_AGENT).toBe("alice");
    expect(env.RONDEL_PARENT_SESSION_ID).toBe(capturedOptions[0].id);
    expect(env.RONDEL_PARENT_CHANNEL_TYPE).toBe("telegram");
    expect(env.RONDEL_PARENT_CHAT_ID).toBe("42");

    manager.stopPruning();
  });

  it("omits RONDEL_PARENT_CHANNEL_TYPE when parent has no channel context", async () => {
    const template = makeTemplate();
    const manager = new SubagentManager(
      "/tmp/rondel-home",
      "/tmp/transcripts",
      "/tmp/mcp-server.js",
      () => "http://127.0.0.1:12345",
      (name) => (name === "alice" ? template : undefined),
      undefined,
      createLogger("test"),
    );

    await manager.spawn({
      parentAgentName: "alice",
      parentChannelType: "", // no channel context (e.g. called from cron)
      parentAccountId: "",
      parentChatId: "42",
      task: "do stuff",
      systemPrompt: "helper",
    });

    const mcp = capturedOptions[0].mcpConfig as {
      rondel: { env: Record<string, string> };
    };
    const env = mcp.rondel.env;

    // Omitted when parent has no channel — env validator defaults to "internal".
    expect("RONDEL_PARENT_CHANNEL_TYPE" in env).toBe(false);
    // Session id and agent still present — filesystem tools still work.
    expect(env.RONDEL_PARENT_SESSION_ID).toBe(capturedOptions[0].id);
    expect(env.RONDEL_PARENT_AGENT).toBe("alice");

    manager.stopPruning();
  });

  it("each spawn uses a fresh session id (isolation from other subagents)", async () => {
    const template = makeTemplate();
    const manager = new SubagentManager(
      "/tmp/rondel-home",
      "/tmp/transcripts",
      "/tmp/mcp-server.js",
      () => "http://127.0.0.1:12345",
      (name) => (name === "alice" ? template : undefined),
      undefined,
      createLogger("test"),
    );

    await manager.spawn({
      parentAgentName: "alice",
      parentChannelType: "telegram",
      parentAccountId: "bot1",
      parentChatId: "42",
      task: "first",
      systemPrompt: "helper",
    });
    // Force a 2ms gap so the Date.now-based id differs.
    await new Promise((r) => setTimeout(r, 2));
    await manager.spawn({
      parentAgentName: "alice",
      parentChannelType: "telegram",
      parentAccountId: "bot1",
      parentChatId: "42",
      task: "second",
      systemPrompt: "helper",
    });

    expect(capturedOptions).toHaveLength(2);
    const sess1 = (capturedOptions[0].mcpConfig as { rondel: { env: Record<string, string> } }).rondel.env.RONDEL_PARENT_SESSION_ID;
    const sess2 = (capturedOptions[1].mcpConfig as { rondel: { env: Record<string, string> } }).rondel.env.RONDEL_PARENT_SESSION_ID;
    expect(sess1).not.toBe(sess2);

    manager.stopPruning();
  });
});
