/**
 * /agents/[name]/ledger — recent ledger events for the agent.
 *
 * RSC parent: fetches the historical events server-side via the existing
 * request-response endpoint, then renders the `<LedgerStream>` Client
 * Component which opens an SSE tail and merges live events into the same
 * timeline. The `RefreshButton` from M1 stays as a fallback for explicit
 * "give me latest" interactions; remove in M3 once live tail is proven.
 */
import { bridge } from "@/lib/bridge/client";
import { LedgerStream } from "@/components/ledger/LedgerStream";
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
            Ledger events
          </h2>
          <p className="text-xs text-ink-subtle mt-0.5">
            Live tail with historical backfill — newest first
          </p>
        </div>
        <RefreshButton />
      </div>

      <LedgerStream agent={name} initialEvents={events} />
    </div>
  );
}
