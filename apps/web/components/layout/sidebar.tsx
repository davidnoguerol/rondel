import { ShieldCheck, Users } from "lucide-react";
import Link from "next/link";
import type { AgentSummary } from "@/lib/bridge";
import { groupByOrg } from "./group-agents";
import { LiveAgentBadges } from "./live-agent-badges";

/**
 * Dashboard sidebar. Static nav + grouped agent lists (by org).
 *
 * Server Component — receives agents as props from the dashboard layout,
 * which does the single memoized fetch. Live state dots live inside the
 * client-side <LiveAgentBadges>.
 */
export function Sidebar({ agents }: { agents: readonly AgentSummary[] }) {
  const grouped = groupByOrg(agents);

  return (
    <aside className="hidden h-full w-60 shrink-0 border-r border-border bg-card md:flex md:flex-col">
      <nav className="flex-1 overflow-y-auto px-3 py-4">
        <ul className="mb-4 space-y-0.5">
          <li>
            <NavLink href="/agents" icon={<Users className="size-4" />}>
              All agents
            </NavLink>
          </li>
          <li>
            <NavLink
              href="/approvals"
              icon={<ShieldCheck className="size-4" />}
            >
              Approvals
            </NavLink>
          </li>
        </ul>

        {agents.length === 0 ? (
          <p className="mt-2 px-3 py-2 text-xs italic text-muted-foreground">
            No agents configured. Run{" "}
            <code className="font-mono not-italic">rondel add agent</code> to
            create one.
          </p>
        ) : (
          grouped.map(({ org, agents: groupAgents }) => (
            <div key={org} className="mb-5">
              <SectionLabel>
                {org}{" "}
                <span className="text-muted-foreground/70">
                  ({groupAgents.length})
                </span>
              </SectionLabel>
              <LiveAgentBadges agents={groupAgents} />
            </div>
          ))
        )}
      </nav>

      <div className="border-t border-border px-4 py-2.5 text-[11px] text-muted-foreground">
        Local · read-only
      </div>
    </aside>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mb-1 px-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
      {children}
    </h2>
  );
}

function NavLink({
  href,
  icon,
  children,
}: {
  href: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href as `/${string}`}
      className="flex items-center gap-2 rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      <span className="text-muted-foreground/80">{icon}</span>
      {children}
    </Link>
  );
}
