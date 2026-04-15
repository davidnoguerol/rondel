/**
 * Integration tests for `POST /agent/schedule-skill-reload`.
 *
 * Focus: the three reachable failure paths for the endpoint that backs the
 * `rondel_reload_skills` MCP tool. These go through a real Bridge HTTP server
 * + real AgentManager (no spawned Claude CLI), so they exercise the routing,
 * `validateBody`, agent existence check, and `ConversationManager.scheduleRestartAfterTurn`
 * "no active conversation" path end-to-end.
 *
 * What's deferred to Tier 3 (see docs/TESTING.md §10 — apps/daemon/src/agents/
 * is deferred until a mocked-CLI harness exists):
 *   - The 200 happy path where an active AgentProcess exists in the
 *     conversations Map and the pending-restart flag actually gets set.
 *     Asserting that requires a real (or fake) Claude CLI child process.
 *   - The Router consuming the flag on the next idle transition and calling
 *     `process.restart()` BEFORE draining queued messages.
 *   - Session preservation via `--resume` after the post-turn restart.
 *
 * Pattern source: bridge-web.integration.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { Bridge } from "./bridge.js";
import { AgentManager } from "../agents/agent-manager.js";
import { withTmpRondel, type TmpRondelHandle } from "../../tests/helpers/tmp.js";
import { createCapturingLogger } from "../../tests/helpers/logger.js";
import { makeAgentConfig } from "../../tests/helpers/fixtures.js";
import type { DiscoveredAgent } from "../shared/types/index.js";

async function bootBridge(
  tmp: TmpRondelHandle,
  agents: DiscoveredAgent[],
): Promise<{ bridge: Bridge; url: string; mgr: AgentManager }> {
  const log = createCapturingLogger();
  const mgr = new AgentManager(log);
  await mgr.initialize(tmp.rondelHome, agents, []);
  const bridge = new Bridge(mgr, log, tmp.rondelHome);
  await bridge.start();
  return { bridge, url: bridge.getUrl(), mgr };
}

function makeAgent(tmp: TmpRondelHandle, name: string): DiscoveredAgent {
  const agentDir = tmp.mkAgent(name, { "AGENT.md": `# ${name}\nhi` });
  return {
    agentName: name,
    agentDir,
    config: makeAgentConfig({ agentName: name, channels: [] }),
  };
}

describe("Bridge — POST /agent/schedule-skill-reload", () => {
  let tmp: TmpRondelHandle;
  let bridge: Bridge;
  let url: string;
  let mgr: AgentManager;

  beforeEach(async () => {
    tmp = withTmpRondel();
    ({ bridge, url, mgr } = await bootBridge(tmp, [makeAgent(tmp, "alice")]));
  });

  afterEach(() => {
    bridge.stop();
    mgr.stopAll();
  });

  async function post(body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await fetch(`${url}/agent/schedule-skill-reload`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as Record<string, unknown>;
    return { status: res.status, json };
  }

  it("returns 400 when the body is missing required fields", async () => {
    // Missing channel_type + chat_id — schema must reject before we hit
    // any agent-existence or conversation-existence logic.
    const { status, json } = await post({ agent_name: "alice" });
    expect(status).toBe(400);
    expect(json.error).toBeDefined();
  });

  it("returns 400 when channel_type is empty", async () => {
    const { status, json } = await post({
      agent_name: "alice",
      channel_type: "",
      chat_id: "123",
    });
    expect(status).toBe(400);
    // validateBody prefixes the offending field.
    expect(String(json.error)).toMatch(/channel_type/);
  });

  it("returns 400 when chat_id is empty", async () => {
    const { status, json } = await post({
      agent_name: "alice",
      channel_type: "telegram",
      chat_id: "",
    });
    expect(status).toBe(400);
    expect(String(json.error)).toMatch(/chat_id/);
  });

  it("returns 400 when agent_name violates the name regex", async () => {
    const { status, json } = await post({
      agent_name: "-bad",
      channel_type: "telegram",
      chat_id: "123",
    });
    expect(status).toBe(400);
    expect(String(json.error)).toMatch(/agent_name/);
  });

  it("returns 404 when the agent does not exist", async () => {
    const { status, json } = await post({
      agent_name: "ghost",
      channel_type: "telegram",
      chat_id: "123",
    });
    expect(status).toBe(404);
    expect(String(json.error)).toMatch(/ghost/);
  });

  it("returns 404 when the agent exists but has no active conversation", async () => {
    // Agent "alice" exists as a template, but no Claude CLI process has been
    // spawned for any (channel, chat) pair. ConversationManager.scheduleRestartAfterTurn
    // must return false, and the bridge must surface that as 404 rather than
    // silently claiming success. This is the invariant that prevents stale
    // reload flags from living in memory against nonexistent conversations.
    const { status, json } = await post({
      agent_name: "alice",
      channel_type: "telegram",
      chat_id: "never-spawned",
    });
    expect(status).toBe(404);
    expect(String(json.error)).toMatch(/No active conversation/);
  });

  it("is not gated by admin — any agent can schedule its own reload", async () => {
    // Regression guard: `rondel_reload_skills` is intentionally available to
    // all agents (skills are per-agent, so non-admins must be able to reload
    // their own). The endpoint lives under /agent/, not /admin/, so there's
    // no admin middleware to bypass. If someone ever moves it under /admin/,
    // this test will still return 404 (not 403), but the existing admin-gated
    // endpoints would start rejecting the same shape — so the test documents
    // the location decision rather than asserting a specific auth behavior.
    //
    // We assert the response is the expected 404 "no active conversation",
    // NOT a 401/403 "forbidden".
    const { status } = await post({
      agent_name: "alice",
      channel_type: "telegram",
      chat_id: "x",
    });
    expect(status).toBe(404);
    expect(status).not.toBe(401);
    expect(status).not.toBe(403);
  });
});
