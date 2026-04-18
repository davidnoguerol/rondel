import { bridge } from "@/lib/bridge/client";
import { CommandPaletteProvider } from "@/components/command-palette";
import { HotkeyProvider } from "@/components/hotkey-provider";
import { RouteTransition } from "@/components/layout/route-transition";
import { Sidebar } from "@/components/layout/sidebar";
import { TopBar } from "@/components/layout/topbar";

/**
 * Dashboard layout — TopBar above a Sidebar + Main split.
 *
 * `force-dynamic` because everything we show is live state over a
 * mutable file-backed backend. Combined with `cache: 'no-store'` on
 * every bridge call, this makes "stale data" impossible by construction.
 *
 * Agent list and approvals queue are fetched ONCE here and passed to
 * subtree Server Components that re-call the bridge — React `cache()`
 * in `bridge.*` deduplicates to one HTTP round-trip per render.
 */
export const dynamic = "force-dynamic";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [agents, approvals] = await Promise.all([
    bridge.agents.list(),
    bridge.approvals.list(),
  ]);

  return (
    <CommandPaletteProvider agents={agents}>
      <HotkeyProvider>
        <div className="flex h-screen flex-col">
          <TopBar
            initialPending={approvals.pending}
            initialResolved={approvals.resolved}
          />
          <div className="flex min-h-0 flex-1">
            <Sidebar agents={agents} />
            <main className="min-w-0 flex-1 overflow-y-auto">
              <RouteTransition>{children}</RouteTransition>
            </main>
          </div>
        </div>
      </HotkeyProvider>
    </CommandPaletteProvider>
  );
}
