/**
 * Unit tests for the Sidebar's groupByOrg helper.
 *
 * Groups agents by their `org` field into sections the sidebar
 * renders. Ordering is a real product concern: globals always come
 * first, then named orgs alphabetically. Regressions here lead to
 * visible reordering in the sidebar.
 */

import { describe, expect, it } from "vitest";

import type { AgentSummary } from "../../../lib/bridge";

import { groupByOrg } from "../group-agents";

function agent(name: string, org?: string): AgentSummary {
  return {
    name,
    org,
    activeConversations: 0,
    conversations: [],
  };
}

describe("groupByOrg", () => {
  it("returns a single empty Global group when given no agents", () => {
    // Sidebar still wants the section header to render, so we
    // emit a zero-length group rather than an empty array.
    expect(groupByOrg([])).toEqual([{ org: "Global", agents: [] }]);
  });

  it("puts agents without an org under Global", () => {
    const agents = [agent("alpha"), agent("beta")];
    const groups = groupByOrg(agents);
    expect(groups).toHaveLength(1);
    expect(groups[0].org).toBe("Global");
    expect(groups[0].agents.map((a) => a.name)).toEqual(["alpha", "beta"]);
  });

  it("groups agents sharing an org together", () => {
    const groups = groupByOrg([
      agent("a", "acme"),
      agent("b", "acme"),
      agent("c", "acme"),
    ]);
    // No globals → no Global group.
    expect(groups).toHaveLength(1);
    expect(groups[0].org).toBe("acme");
    expect(groups[0].agents.map((a) => a.name)).toEqual(["a", "b", "c"]);
  });

  it("puts Global first and orders named orgs alphabetically", () => {
    const groups = groupByOrg([
      agent("x", "zeta"),
      agent("g1"),
      agent("y", "alpha"),
      agent("g2"),
      agent("z", "mu"),
    ]);
    expect(groups.map((g) => g.org)).toEqual(["Global", "alpha", "mu", "zeta"]);
    expect(groups[0].agents.map((a) => a.name)).toEqual(["g1", "g2"]);
    expect(groups[1].agents.map((a) => a.name)).toEqual(["y"]);
    expect(groups[2].agents.map((a) => a.name)).toEqual(["z"]);
    expect(groups[3].agents.map((a) => a.name)).toEqual(["x"]);
  });

  it("omits Global when every agent has an org", () => {
    const groups = groupByOrg([agent("a", "acme"), agent("b", "other")]);
    expect(groups.map((g) => g.org)).toEqual(["acme", "other"]);
  });

  it("preserves insertion order within a named org", () => {
    const groups = groupByOrg([
      agent("c", "acme"),
      agent("a", "acme"),
      agent("b", "acme"),
    ]);
    expect(groups[0].agents.map((a) => a.name)).toEqual(["c", "a", "b"]);
  });

  it("treats an empty-string org as global (falsy check)", () => {
    // AgentSummarySchema marks org as `.optional()` so in practice
    // it's either a non-empty string or undefined. This guards
    // against a regression where a caller passes "".
    const groups = groupByOrg([agent("empty", ""), agent("none")]);
    expect(groups).toHaveLength(1);
    expect(groups[0].org).toBe("Global");
    expect(groups[0].agents.map((a) => a.name)).toEqual(["empty", "none"]);
  });
});
