/**
 * Per-agent layout. Validates the agent exists (so all three tabs share
 * one 404 check) and renders the header + tab nav above `children`.
 *
 * We call `bridge.agents.list()` here instead of a dedicated "agent
 * exists?" endpoint because the list is already cached via React
 * `cache()` — no extra bridge round-trip.
 */
import { notFound } from "next/navigation";

import { bridge } from "@/lib/bridge/client";
import { PageHeader } from "@/components/ui/page-header";
import { AgentTabs } from "@/components/agents/agent-tabs";
import { AgentStateBadge } from "@/components/agents/agent-state-badge";

export default async function AgentLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ name: string }>;
}) {
  const { name } = await params;
  const agents = await bridge.agents.list();
  const agent = agents.find((a) => a.name === name);

  if (!agent) {
    notFound();
  }

  // Derive a single-line state label for the header. Pick the most
  // "interesting" conversation state if there are multiple.
  const headlineState = agent.conversations.find(
    (c) => c.state === "busy" || c.state === "crashed" || c.state === "halted",
  )?.state;

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={agent.name}
        subtitle={
          <span className="flex items-center gap-2">
            {agent.org && <span>{agent.org}</span>}
            {agent.org && headlineState && <span>·</span>}
            {headlineState && <AgentStateBadge state={headlineState} />}
            {!headlineState && agent.activeConversations === 0 && (
              <span className="text-muted-foreground">
                no active conversations
              </span>
            )}
            {!headlineState && agent.activeConversations > 0 && (
              <span className="text-muted-foreground">
                {agent.activeConversations} active conversation
                {agent.activeConversations === 1 ? "" : "s"}
              </span>
            )}
          </span>
        }
      />
      <AgentTabs agentName={name} />
      {/*
        Scroll responsibility moves from the outer dashboard main into the
        tab content area. This lets the chat tab claim the full remaining
        height (with its own inner scroll) while overview/ledger/memory
        still scroll normally on overflow.
      */}
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </div>
  );
}
