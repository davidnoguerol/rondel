/**
 * /agents/[name]/schedules — list and manage an agent's runtime schedules.
 *
 * Server-renders the initial schedule list. The Client Component below
 * subscribes to the live tail so create/update/delete/run events in any
 * tab — including those triggered by the agent itself via
 * `rondel_schedule_*` — flow back immediately.
 */
import { bridge } from "@/lib/bridge/client";

import { SchedulesView } from "./SchedulesView";

// Schedules mutate frequently (every SSE frame bumps state, every run
// updates lastRun). Matches the approvals page which makes the same
// tradeoff for the same reason.
export const dynamic = "force-dynamic";

export default async function AgentSchedulesPage({
  params,
}: {
  params: Promise<{ name: string }>;
}) {
  const { name } = await params;
  const schedules = await bridge.schedules.list(name);

  return <SchedulesView agent={name} initial={schedules} />;
}
