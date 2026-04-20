/**
 * /agents/[name]/context — raw dump of the assembled system prompts.
 *
 * Shows the exact strings passed to Claude CLI via `--system-prompt`, for
 * both the main conversation and the agent-mail variant. Nothing fancy:
 * one tab per variant, scrollable `pre` block, byte counter. The goal is
 * ground truth — you read what the model reads.
 *
 * Data flows through `bridge.agents.prompt(name)`, which pulls the
 * strings from the cached `AgentTemplate` on the daemon side (no disk
 * I/O per request).
 */
import { bridge } from "@/lib/bridge/client";

import { ContextView } from "./context-view";

export default async function AgentContextPage({
  params,
}: {
  params: Promise<{ name: string }>;
}) {
  const { name } = await params;
  const prompt = await bridge.agents.prompt(name);

  return (
    <div className="p-8 flex flex-col h-full min-h-0">
      <div className="mb-4 flex-none">
        <h2 className="text-sm font-semibold text-foreground">Context</h2>
        <p className="text-xs text-muted-foreground mt-0.5">
          The exact system prompt this agent is spawned with. Reload the
          daemon or update the agent to refresh.
        </p>
      </div>
      <ContextView
        systemPrompt={prompt.systemPrompt}
        agentMailPrompt={prompt.agentMailPrompt}
      />
    </div>
  );
}
