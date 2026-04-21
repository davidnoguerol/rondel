/**
 * /tasks — read-only task board.
 *
 * Phase 1 scope: snapshot + live delta only. No create/claim/complete
 * UI; agents do those via MCP tools. The board is for visibility.
 *
 * Server-rendered initial list (admin scope via `root` caller — the
 * web is a loopback-only admin surface) + a client-side SSE listener
 * that folds deltas into the view.
 */
import { bridge } from "@/lib/bridge/client";
import type { TaskRecord } from "@/lib/bridge";
import { TasksLiveBoard } from "@/components/tasks/tasks-live-board";

export const dynamic = "force-dynamic";

export default async function TasksPage() {
  // The web runs on the local machine as the operator — treat every
  // read as admin so the board surfaces every org. This matches how
  // /schedules and /approvals already behave.
  const tasks: readonly TaskRecord[] = await bridge.tasks.list({
    callerAgent: "root",
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
      <TasksLiveBoard initial={tasks} />
    </div>
  );
}
