/**
 * /agents/[name]/ledger — recent ledger events for the agent.
 *
 * Server-rendered. A Client Component "Refresh" button at the top
 * triggers `router.refresh()` to re-run this server component and
 * stream in the newest events.
 */
import { bridge } from "@/lib/bridge";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { LedgerRow } from "@/components/ledger/LedgerRow";
import { RefreshButton } from "@/components/ledger/RefreshButton";

export default async function AgentLedgerPage({
  params,
}: {
  params: Promise<{ name: string }>;
}) {
  const { name } = await params;

  const events = await bridge.ledger.query({
    agent: name,
    limit: 100,
  });

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-sm font-semibold text-ink">
            Recent ledger events
          </h2>
          <p className="text-xs text-ink-subtle mt-0.5">
            Last {events.length} event{events.length === 1 ? "" : "s"} —
            newest first
          </p>
        </div>
        <RefreshButton />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>
            Events
            <span className="ml-2 text-ink-subtle font-normal">
              ({events.length})
            </span>
          </CardTitle>
        </CardHeader>
        <CardBody className="p-0">
          {events.length === 0 ? (
            <div className="px-5 py-8 text-center">
              <p className="text-sm text-ink-muted">
                No ledger events for this agent yet.
              </p>
              <p className="text-xs text-ink-subtle mt-1">
                Events appear here as the agent sends and receives messages,
                spawns subagents, or runs crons.
              </p>
            </div>
          ) : (
            <ul>
              {events.map((event, idx) => (
                <LedgerRow
                  key={`${event.ts}-${idx}`}
                  event={event}
                />
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
