import Link from "next/link";

import type { AgentSummary } from "@/lib/bridge";
import { LiveAgentBadges } from "./LiveAgentBadges";

/**
 * Dashboard sidebar — navigation across the agents list, plus direct
 * links to each individual agent. Rendered by the dashboard layout, which
 * fetches the agent list server-side.
 *
 * Purely presentational: receives data as props, has no own data fetching.
 * Swapping to a different data source (filters, org grouping) changes
 * only the parent layout.
 */
export function Sidebar({ agents }: { agents: readonly AgentSummary[] }) {
  return (
    <aside className="w-64 shrink-0 border-r border-border bg-surface-raised flex flex-col">
      <div className="px-5 py-5 border-b border-border">
        <Link href="/" className="block">
          <span className="text-base font-semibold tracking-tight text-ink">
            Rondel
          </span>
        </Link>
        <p className="mt-0.5 text-xs text-ink-subtle">orchestration console</p>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-4">
        <SectionLabel>Navigation</SectionLabel>
        <ul className="space-y-0.5 mb-6">
          <li>
            <NavLink href="/agents">All agents</NavLink>
          </li>
          <li>
            <NavLink href="/approvals">Approvals</NavLink>
          </li>
        </ul>

        <SectionLabel>
          Agents{" "}
          <span className="ml-1 text-ink-subtle">({agents.length})</span>
        </SectionLabel>
        {agents.length === 0 ? (
          <p className="px-3 py-2 text-xs text-ink-subtle italic">
            No agents configured
          </p>
        ) : (
          // The agents list is delegated to a Client Component because
          // it owns the live-state SSE subscription. It receives the
          // same `agents` array the Server Component already fetched, so
          // initial render matches what a server-only render would show
          // — dots only appear after the snapshot frame arrives.
          <LiveAgentBadges agents={agents} />
        )}
      </nav>

      <div className="px-5 py-3 border-t border-border text-[11px] text-ink-subtle">
        Local · read-only
      </div>
    </aside>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="px-3 mb-2 text-[10px] font-semibold uppercase tracking-wider text-ink-subtle">
      {children}
    </h2>
  );
}

function NavLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href as `/${string}`}
      className="block px-3 py-1.5 rounded-md text-sm text-ink-muted hover:bg-surface-muted hover:text-ink transition-colors"
    >
      {children}
    </Link>
  );
}
