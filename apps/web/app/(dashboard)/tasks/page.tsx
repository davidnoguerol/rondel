/**
 * /tasks — read-only task board.
 *
 * Phase 1 scope: snapshot + live delta only. No create/claim/complete
 * UI; agents do those via MCP tools. The board is for visibility.
 *
 * The web is a loopback-only admin surface — same convention as the
 * /schedules page. We borrow the first available agent's identity and
 * forward `isAdmin: true` so the daemon's cross-org listing works.
 * If there are no agents, render an empty state instead of hitting the
 * bridge with a bogus caller.
 */
import { bridge } from "@/lib/bridge/client";
import type { TaskRecord } from "@/lib/bridge";
import { TasksLiveBoard } from "@/components/tasks/tasks-live-board";

export const dynamic = "force-dynamic";

export default async function TasksPage() {
  const agents = await bridge.agents.list();
  if (agents.length === 0) {
    return (
      <div className="p-6">
        <div className="mb-6">
          <h1 className="text-2xl font-semibold">Tasks</h1>
        </div>
        <p className="text-sm italic text-muted-foreground">
          No agents configured yet. Run{" "}
          <code className="font-mono not-italic">rondel add agent</code> to
          create one.
        </p>
      </div>
    );
  }

  const callerAgent = agents[0].name;
  const tasks: readonly TaskRecord[] = await bridge.tasks.list({
    callerAgent,
    isAdmin: true,
  });

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold">Tasks</h1>
        <p className="text-sm text-muted-foreground">
          Shared work queue across every org. Read-only — agents create and
          claim via MCP tools.
        </p>
      </div>
      <TasksLiveBoard initial={tasks} callerAgent={callerAgent} />
    </div>
  );
}
