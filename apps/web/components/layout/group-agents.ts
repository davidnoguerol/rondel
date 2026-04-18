/**
 * Pure helper for the Sidebar agent grouping.
 *
 * Extracted from sidebar.tsx so it can be unit-tested without pulling
 * in React / next/link. The sidebar re-imports this — one source of
 * truth for the grouping policy.
 */

import type { AgentSummary } from "@/lib/bridge";

export type AgentGroup = {
  org: string;
  agents: readonly AgentSummary[];
};

/**
 * Partition agents by org. Global agents (no `org` field) come first
 * under the label "Global", then each named org sorted alphabetically.
 *
 * If there are no agents at all, returns a single empty "Global" group
 * so the UI still renders the section header.
 */
export function groupByOrg(agents: readonly AgentSummary[]): AgentGroup[] {
  const globals: AgentSummary[] = [];
  const byOrg = new Map<string, AgentSummary[]>();

  for (const agent of agents) {
    if (!agent.org) {
      globals.push(agent);
    } else {
      const list = byOrg.get(agent.org) ?? [];
      list.push(agent);
      byOrg.set(agent.org, list);
    }
  }

  const groups: AgentGroup[] = [];
  if (globals.length > 0 || byOrg.size === 0) {
    groups.push({ org: "Global", agents: globals });
  }
  for (const [org, list] of [...byOrg.entries()].sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    groups.push({ org, agents: list });
  }
  return groups;
}
