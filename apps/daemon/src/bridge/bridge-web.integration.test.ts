/**
 * Integration tests for bridge endpoints touching the web channel.
 *
 * Focus: the three failure paths + happy path for `POST /web/messages/send`
 * and channel-type validation on `GET /conversations/.../history`.
 *
 * These go through a real Bridge HTTP server + real AgentManager; the test
 * builds a minimal agent with no external channel bindings (so no Telegram
 * bot token is needed) and hits the server via `fetch`. This is the cheapest
 * level at which the routing + validateBody + resolveAgentByChannel wiring
 * can be exercised end-to-end.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { Bridge } from "./bridge.js";
import { AgentManager } from "../agents/agent-manager.js";
import { withTmpRondel, type TmpRondelHandle } from "../../tests/helpers/tmp.js";
import { createCapturingLogger } from "../../tests/helpers/logger.js";
import { makeAgentConfig } from "../../tests/helpers/fixtures.js";
import type { DiscoveredAgent } from "../shared/types/index.js";

async function bootBridge(tmp: TmpRondelHandle, agents: DiscoveredAgent[]): Promise<{
  bridge: Bridge;
  url: string;
  mgr: AgentManager;
}> {
  const log = createCapturingLogger();
  const mgr = new AgentManager(log);
  await mgr.initialize(tmp.rondelHome, agents, []);
  const bridge = new Bridge(mgr, log, tmp.rondelHome);
  await bridge.start();
  return { bridge, url: bridge.getUrl(), mgr };
}

function makeAgent(tmp: TmpRondelHandle, name: string): DiscoveredAgent {
  const agentDir = tmp.mkAgent(name, { "AGENT.md": `# ${name}\nhi` });
  return { agentName: name, agentDir, config: makeAgentConfig({ agentName: name, channels: [] }) };
}

describe("Bridge — POST /web/messages/send", () => {
  let tmp: TmpRondelHandle;
  let bridge: Bridge;
  let url: string;
  let mgr: AgentManager;

  beforeEach(async () => {
    tmp = withTmpRondel();
    const agent = makeAgent(tmp, "alice");
    ({ bridge, url, mgr } = await bootBridge(tmp, [agent]));
  });

  afterEach(() => {
    bridge.stop();
    mgr.stopAll();
  });

  async function post(body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await fetch(`${url}/web/messages/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as Record<string, unknown>;
    return { status: res.status, json };
  }

  it("returns 400 when the body fails schema validation", async () => {
    // Missing chat_id and text — a well-formed request must carry all three.
    const { status, json } = await post({ agent_name: "alice" });
    expect(status).toBe(400);
    expect(json.error).toBeDefined();
  });

  it("returns 400 when chat_id lacks the required web- prefix", async () => {
    const { status } = await post({ agent_name: "alice", chat_id: "not-web", text: "hi" });
    expect(status).toBe(400);
  });

  it("returns 404 when the agent is unknown", async () => {
    const { status, json } = await post({ agent_name: "ghost", chat_id: "web-1", text: "hi" });
    expect(status).toBe(404);
    expect(String(json.error)).toMatch(/ghost/);
  });

  it("returns 200 and injects a user message on the happy path", async () => {
    // Tap the adapter's onMessage hook before sending so we can observe that
    // ingestUserMessage actually dispatched a normalized ChannelMessage.
    const adapter = mgr.getChannelRegistry().get("web")!;
    const received: string[] = [];
    adapter.onMessage((msg) => received.push(msg.text));

    const { status, json } = await post({ agent_name: "alice", chat_id: "web-1", text: "ping" });
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    expect(received).toEqual(["ping"]);
  });

  // NOTE on the 503 "no registered web account" path: it's unreachable from
  // outside without surgically editing AgentManager's internal reverse map.
  // The fail-loudly invariant in registerChannelBindings means the only way
  // to desync the template registry and the web account map is via a future
  // refactor that regresses the invariant. The AgentManager unit test above
  // guards that invariant directly; replicating it here would require
  // reaching into private state and would test the mock, not the behavior.
});

describe("Bridge — GET /conversations/:agent/:channelType/:chatId/history", () => {
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

  it("returns 404 when the agent is unknown", async () => {
    const res = await fetch(`${url}/conversations/ghost/web/web-1/history`);
    expect(res.status).toBe(404);
  });

  it("returns 400 when the channelType is not a known adapter", async () => {
    const res = await fetch(`${url}/conversations/alice/telgrm/web-1/history`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/Unknown channel type/);
  });

  it("returns 200 with empty turns when there is no session entry yet", async () => {
    const res = await fetch(`${url}/conversations/alice/web/web-1/history`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { turns: unknown[]; sessionId: null };
    expect(body.turns).toEqual([]);
    expect(body.sessionId).toBeNull();
  });
});
