/**
 * Dashboard layout — sidebar + main content area.
 *
 * `force-dynamic` because everything we show is live state over a
 * mutable file-backed backend. Next 14 caches fetch by default; Next 15
 * doesn't. We set `dynamic = 'force-dynamic'` at the layout level so we
 * don't depend on which version is installed. Combined with the
 * `cache: 'no-store'` on every bridge call, this makes "stale data"
 * impossible by construction.
 *
 * The Sidebar receives the agent list from a SINGLE server-side fetch,
 * memoized via React `cache()` in `bridge.agents.list()`. If a child
 * page (e.g. the agents list page) also calls `bridge.agents.list()`,
 * it gets the same result without a second HTTP round-trip.
 */
import { bridge } from "@/lib/bridge/client";
import { Sidebar } from "@/components/layout/Sidebar";

export const dynamic = "force-dynamic";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const agents = await bridge.agents.list();

  return (
    <div className="flex min-h-screen">
      <Sidebar agents={agents} />
      <main className="flex-1 min-w-0">{children}</main>
    </div>
  );
}
