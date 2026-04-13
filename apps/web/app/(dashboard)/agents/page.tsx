/**
 * /agents — overview of every configured agent.
 *
 * Server Component: fetches the agent list directly. React's `cache()`
 * wrapper around `bridge.agents.list()` means this and the sidebar fetch
 * share one underlying HTTP round-trip per render.
 */
import Link from "next/link";

import { bridge } from "@/lib/bridge";
import { Card, CardBody } from "@/components/ui/Card";
import { PageHeader } from "@/components/ui/PageHeader";
import { AgentStateBadge } from "@/components/agents/AgentStateBadge";

export default async function AgentsPage() {
  const agents = await bridge.agents.list();

  return (
    <>
      <PageHeader
        title="Agents"
        subtitle={`${agents.length} configured`}
      />

      <div className="p-8">
        {agents.length === 0 ? (
          <Card>
            <CardBody>
              <p className="text-sm text-ink-muted">
                No agents configured. Run{" "}
                <code className="px-1 py-0.5 rounded bg-surface-muted font-mono text-xs">
                  rondel add agent
                </code>{" "}
                to create one.
              </p>
            </CardBody>
          </Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {agents.map((agent) => (
              <Link
                key={agent.name}
                href={`/agents/${agent.name}`}
                className="block"
              >
                <Card className="hover:border-accent/50 transition-colors h-full">
                  <CardBody>
                    <div className="flex items-start justify-between gap-3 mb-3">
                      <div className="min-w-0">
                        <h3 className="text-sm font-semibold text-ink truncate">
                          {agent.name}
                        </h3>
                        {agent.org && (
                          <p className="text-xs text-ink-subtle mt-0.5">
                            {agent.org}
                          </p>
                        )}
                      </div>
                    </div>
                    <dl className="space-y-1 text-xs">
                      <div className="flex justify-between">
                        <dt className="text-ink-subtle">Active conversations</dt>
                        <dd className="text-ink font-medium tabular-nums">
                          {agent.activeConversations}
                        </dd>
                      </div>
                      {agent.conversations.length > 0 && (
                        <div className="pt-2 mt-2 border-t border-border">
                          <dt className="text-ink-subtle mb-1.5">Conversations</dt>
                          <dd className="space-y-1">
                            {agent.conversations.slice(0, 3).map((conv) => (
                              <div
                                key={conv.chatId}
                                className="flex items-center justify-between gap-2"
                              >
                                <span className="font-mono text-[11px] text-ink-muted truncate">
                                  {conv.chatId}
                                </span>
                                <AgentStateBadge state={conv.state} />
                              </div>
                            ))}
                            {agent.conversations.length > 3 && (
                              <p className="text-[11px] text-ink-subtle italic">
                                +{agent.conversations.length - 3} more
                              </p>
                            )}
                          </dd>
                        </div>
                      )}
                    </dl>
                  </CardBody>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
