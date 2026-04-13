/**
 * Integration tests for AgentManager's synthetic web-account lifecycle.
 *
 * Scope: the correctness invariant that every registered agent has a
 * corresponding `web:<agentName>` account registered on the WebChannelAdapter,
 * and that unregister cleans it up on both sides (reverse-lookup map AND the
 * adapter). This is load-bearing because:
 *
 *   1. If registration silently skips the web account, the `POST /web/messages/send`
 *      endpoint returns 503 with no clear signal.
 *   2. If unregister doesn't clean up, rondel_add_agent → rondel_remove_agent
 *      cycles leak adapter state and future re-adds throw "already registered".
 *
 * We use withTmpRondel to give AgentManager a real filesystem; the agents
 * have no channel bindings so no external adapters (Telegram) are needed.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { AgentManager } from "./agent-manager.js";
import { WebChannelAdapter } from "../channels/web/adapter.js";
import { withTmpRondel, type TmpRondelHandle } from "../../tests/helpers/tmp.js";
import { createCapturingLogger } from "../../tests/helpers/logger.js";
import { makeAgentConfig } from "../../tests/helpers/fixtures.js";
import type { DiscoveredAgent } from "../shared/types/index.js";

function makeDiscoveredAgent(agentName: string, agentDir: string): DiscoveredAgent {
  return {
    agentName,
    agentDir,
    config: makeAgentConfig({ agentName, channels: [] }),
  };
}

describe("AgentManager — synthetic web account lifecycle", () => {
  let tmp: TmpRondelHandle;

  beforeEach(() => {
    tmp = withTmpRondel();
    // assembleContext refuses to produce an empty prompt. Seed every agent
    // with a minimal AGENT.md so initialize() and registerAgent() succeed.
  });

  async function initWithAgent(agentName: string): Promise<{ mgr: AgentManager; agent: DiscoveredAgent }> {
    const agentDir = tmp.mkAgent(agentName, { "AGENT.md": `# ${agentName}\nhello` });
    const mgr = new AgentManager(createCapturingLogger());
    const agent = makeDiscoveredAgent(agentName, agentDir);
    await mgr.initialize(tmp.rondelHome, [agent], []);
    return { mgr, agent };
  }

  it("registers a synthetic web:<agentName> account during initialize()", async () => {
    const { mgr } = await initWithAgent("alice");

    // Reverse lookup works (used by Router and the bridge's /web/messages/send).
    expect(mgr.resolveAgentByChannel("web", "alice")).toBe("alice");

    // And the adapter has the account — sendText must not throw "unknown account".
    const adapter = mgr.getChannelRegistry().get("web");
    expect(adapter).toBeInstanceOf(WebChannelAdapter);
    await expect((adapter as WebChannelAdapter).sendText("alice", "web-1", "hi")).resolves.toBeUndefined();
  });

  it("unregisterAgent removes the synthetic web account from both the reverse-map and the adapter", async () => {
    const { mgr } = await initWithAgent("alice");
    const adapter = mgr.getChannelRegistry().get("web") as WebChannelAdapter;

    mgr.unregisterAgent("alice");

    // Reverse lookup is cleared.
    expect(mgr.resolveAgentByChannel("web", "alice")).toBeUndefined();

    // Adapter state is cleared — sendText now throws "unknown account".
    await expect(adapter.sendText("alice", "web-1", "hi")).rejects.toThrow(/Unknown web account/);
  });

  it("allows re-registering an agent after unregister (no adapter leak across cycles)", async () => {
    // This is the scenario master-docs-checker flagged: without cleanup, the
    // second registerAgent() call would make WebChannelAdapter.addAccount
    // throw "already registered". If this test ever fails, unregister leaked.
    const { mgr, agent } = await initWithAgent("alice");

    mgr.unregisterAgent("alice");

    await expect(mgr.registerAgent(agent)).resolves.toBeUndefined();
    expect(mgr.resolveAgentByChannel("web", "alice")).toBe("alice");
  });

  it("registerChannelBindings fails loudly if the web adapter is missing (framework invariant)", async () => {
    // Constructing a plain AgentManager without initialize() leaves the
    // channelRegistry null — registerAgent should refuse to proceed. This
    // guards the "fail loudly at boundaries" contract from agent-manager.ts.
    const mgr = new AgentManager(createCapturingLogger());
    const agentDir = tmp.mkAgent("bob", { "AGENT.md": "# bob" });
    await expect(mgr.registerAgent(makeDiscoveredAgent("bob", agentDir))).rejects.toThrow(
      /not initialized/,
    );
  });
});
