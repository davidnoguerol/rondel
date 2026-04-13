/**
 * /agents/[name] — Overview tab.
 *
 * Shows per-conversation state and basic metadata. The layout has already
 * validated that the agent exists, so we can look it up in the list.
 */
import { bridge } from "@/lib/bridge";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { AgentStateBadge } from "@/components/agents/AgentStateBadge";

export default async function AgentOverviewPage({
  params,
}: {
  params: Promise<{ name: string }>;
}) {
  const { name } = await params;

  // Cached by React `cache()` — no second HTTP call even though the
  // layout also called this.
  const agents = await bridge.agents.list();
  const agent = agents.find((a) => a.name === name)!;

  return (
    <div className="p-8 space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Conversations</CardTitle>
        </CardHeader>
        <CardBody>
          {agent.conversations.length === 0 ? (
            <p className="text-sm text-ink-muted">
              No active conversations. Message this agent on its configured
              channel to start one.
            </p>
          ) : (
            <ul className="divide-y divide-border -mx-5">
              {agent.conversations.map((conv) => (
                <li
                  key={conv.chatId}
                  className="flex items-center justify-between px-5 py-3"
                >
                  <div className="min-w-0">
                    <p className="font-mono text-sm text-ink truncate">
                      chat {conv.chatId}
                    </p>
                    {conv.sessionId && (
                      <p className="font-mono text-[11px] text-ink-subtle truncate mt-0.5">
                        session {conv.sessionId.slice(0, 8)}…
                      </p>
                    )}
                  </div>
                  <AgentStateBadge state={conv.state} />
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>At a glance</CardTitle>
        </CardHeader>
        <CardBody>
          <dl className="grid grid-cols-2 gap-4 text-sm">
            <Field label="Name" value={agent.name} mono />
            <Field label="Organization" value={agent.org ?? "—"} />
            <Field
              label="Active conversations"
              value={String(agent.activeConversations)}
            />
          </dl>
        </CardBody>
      </Card>
    </div>
  );
}

function Field({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wider text-ink-subtle mb-0.5">
        {label}
      </dt>
      <dd className={`text-ink ${mono ? "font-mono text-xs" : ""}`}>{value}</dd>
    </div>
  );
}
