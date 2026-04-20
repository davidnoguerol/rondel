/**
 * Cron MCP env wiring test.
 *
 * Cron runs must populate RONDEL_PARENT_SESSION_ID and a non-empty
 * RONDEL_PARENT_CHAT_ID so the filesystem tools' env validator accepts
 * them. Before this fix cron passed `""` for chat id — the validator
 * rejected it and filesystem tools became unusable from cron.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const capturedOptions: Array<{ id: string; mcpConfig: unknown }> = [];

vi.mock("../agents/subagent-process.js", () => {
  class FakeSubagentProcess {
    readonly done: Promise<{ state: string }> = Promise.resolve({ state: "completed" });
    constructor(options: { id: string; mcpConfig?: unknown }) {
      capturedOptions.push({ id: options.id, mcpConfig: options.mcpConfig });
    }
    start(): void {}
    getId(): string {
      return "fake";
    }
  }
  return { SubagentProcess: FakeSubagentProcess };
});

vi.mock("../config/prompt/index.js", () => ({
  loadPromptInputs: vi.fn(async () => "system prompt"),
}));

vi.mock("../shared/transcript.js", () => ({
  resolveTranscriptPath: () => "/tmp/ignored",
  createTranscript: vi.fn(async () => undefined),
}));

import { CronRunner } from "./cron-runner.js";
import { createLogger } from "../shared/logger.js";
import type { AgentConfig, CronJob } from "../shared/types/index.js";
import type { AgentTemplate } from "../agents/conversation-manager.js";

function makeTemplate(): AgentTemplate {
  const config: AgentConfig = {
    name: "alice",
    model: "sonnet",
    tools: { allowed: [], disallowed: [] },
    channels: [],
    admin: false,
  } as unknown as AgentConfig;
  return {
    name: "alice",
    agentDir: "/tmp/agents/alice",
    config,
    systemPrompt: "You are Alice.",
  };
}

function makeJob(): CronJob {
  return {
    id: "nightly-report",
    prompt: "summarize logs",
    schedule: { kind: "cron", expression: "0 2 * * *" },
  } as unknown as CronJob;
}

describe("CronRunner.runIsolated — MCP env wiring", () => {
  beforeEach(() => {
    capturedOptions.length = 0;
  });

  it("stamps RONDEL_PARENT_SESSION_ID and a non-empty synthetic chat id", async () => {
    const template = makeTemplate();
    const runner = new CronRunner(
      "/tmp/rondel-home",
      "/tmp/transcripts",
      "/tmp/mcp-server.js",
      () => "http://127.0.0.1:12345",
      (name) => (name === "alice" ? template : undefined),
      () => undefined,
      { getOrSpawn: vi.fn() } as unknown as import("../agents/conversation-manager.js").ConversationManager,
      createLogger("test"),
    );

    await runner.runIsolated("alice", makeJob());

    expect(capturedOptions).toHaveLength(1);
    const mcp = capturedOptions[0].mcpConfig as {
      rondel: { env: Record<string, string> };
    };
    const env = mcp.rondel.env;

    expect(env.RONDEL_BRIDGE_URL).toBe("http://127.0.0.1:12345");
    expect(env.RONDEL_PARENT_AGENT).toBe("alice");
    expect(env.RONDEL_PARENT_SESSION_ID).toBe(capturedOptions[0].id);
    // Non-empty — validator rejects empty strings. Synthetic job id is fine.
    expect(env.RONDEL_PARENT_CHAT_ID).toBe("cron:nightly-report");
    // Channel type omitted so the tool-side validator falls back to "internal".
    expect("RONDEL_PARENT_CHANNEL_TYPE" in env).toBe(false);
  });

  it("each cron run uses a fresh session id (isolation from prior runs)", async () => {
    const template = makeTemplate();
    const runner = new CronRunner(
      "/tmp/rondel-home",
      "/tmp/transcripts",
      "/tmp/mcp-server.js",
      () => "http://127.0.0.1:12345",
      (name) => (name === "alice" ? template : undefined),
      () => undefined,
      { getOrSpawn: vi.fn() } as unknown as import("../agents/conversation-manager.js").ConversationManager,
      createLogger("test"),
    );

    await runner.runIsolated("alice", makeJob());
    await new Promise((r) => setTimeout(r, 2));
    await runner.runIsolated("alice", makeJob());

    const sess1 = (capturedOptions[0].mcpConfig as { rondel: { env: Record<string, string> } }).rondel.env.RONDEL_PARENT_SESSION_ID;
    const sess2 = (capturedOptions[1].mcpConfig as { rondel: { env: Record<string, string> } }).rondel.env.RONDEL_PARENT_SESSION_ID;
    expect(sess1).not.toBe(sess2);
  });
});
