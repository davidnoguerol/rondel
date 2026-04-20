/**
 * Integration test for `GET /agents/:name/prompt`.
 *
 * The endpoint is O(1) — it reads from the `AgentTemplate` cache set at
 * `AgentManager.initialize`. This test boots a real bridge + real agent
 * manager with a temp workspace, hits the endpoint, and asserts:
 *
 * - Happy path: 200 with both `systemPrompt` and `agentMailPrompt`
 *   populated and containing the framework Identity line.
 * - Unknown agent: 404 with an error payload.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
  const agentDir = tmp.mkAgent(name, { "AGENT.md": `# ${name}\nbehave` });
  return {
    agentName: name,
    agentDir,
    config: makeAgentConfig({ agentName: name, channels: [] }),
  };
}

describe("Bridge — GET /agents/:name/prompt", () => {
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

  it("returns both prompts with framework content for a known agent", async () => {
    const res = await fetch(`${url}/agents/alice/prompt`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      agentName: string;
      systemPrompt: string;
      agentMailPrompt: string | null;
    };

    expect(json.agentName).toBe("alice");
    // Framework identity line appears in both variants — confirms the
    // prompt module actually ran, not just that something was cached.
    expect(json.systemPrompt).toContain("You are a personal assistant running inside Rondel.");
    expect(json.agentMailPrompt).not.toBeNull();
    expect(json.agentMailPrompt ?? "").toContain("You are a personal assistant running inside Rondel.");
    // The agent-mail variant carries the Agent-Mail Context block — the
    // differentiator between the two cached prompts.
    expect(json.agentMailPrompt ?? "").toContain("Agent-Mail Context");
    expect(json.systemPrompt).not.toContain("Agent-Mail Context");
  });

  it("returns 404 for an unknown agent", async () => {
    const res = await fetch(`${url}/agents/ghost/prompt`);
    expect(res.status).toBe(404);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain("not found");
  });
});
