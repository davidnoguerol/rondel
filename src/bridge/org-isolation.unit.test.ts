import { describe, it, expect } from "vitest";
import {
  checkOrgIsolation,
  type OrgLookup,
  type OrgResolution,
} from "./org-isolation.js";

/**
 * Table-driven lookup factory. Keys in `map` are agent names; values describe
 * their status. Agents whose name is not in `map` resolve to `{ status: "unknown" }`.
 */
function makeLookup(map: Record<string, OrgResolution>): OrgLookup {
  return (name) => map[name] ?? { status: "unknown" };
}

const GLOBAL: OrgResolution = { status: "global" };
const ORG = (orgName: string): OrgResolution => ({ status: "org", orgName });

describe("checkOrgIsolation — allowed messages", () => {
  it("allows global → global", () => {
    const lookup = makeLookup({ alice: GLOBAL, bob: GLOBAL });
    expect(checkOrgIsolation(lookup, "alice", "bob")).toBeNull();
  });

  it("allows global → org (sender is global)", () => {
    const lookup = makeLookup({ alice: GLOBAL, bob: ORG("acme") });
    expect(checkOrgIsolation(lookup, "alice", "bob")).toBeNull();
  });

  it("allows org → global (recipient is global)", () => {
    const lookup = makeLookup({ alice: ORG("acme"), bob: GLOBAL });
    expect(checkOrgIsolation(lookup, "alice", "bob")).toBeNull();
  });

  it("allows same-org messaging", () => {
    const lookup = makeLookup({ alice: ORG("acme"), bob: ORG("acme") });
    expect(checkOrgIsolation(lookup, "alice", "bob")).toBeNull();
  });
});

describe("checkOrgIsolation — blocked messages", () => {
  it("blocks cross-org messaging", () => {
    const lookup = makeLookup({ alice: ORG("acme"), bob: ORG("other") });
    const result = checkOrgIsolation(lookup, "alice", "bob");
    expect(result).not.toBeNull();
    expect(result).toContain("acme");
    expect(result).toContain("other");
  });

  it("returns the exact contract-locked error format on cross-org block", () => {
    const lookup = makeLookup({ alice: ORG("A"), bob: ORG("B") });
    expect(checkOrgIsolation(lookup, "alice", "bob")).toBe(
      "Cross-org messaging blocked: A → B",
    );
  });

  it("is case-sensitive on org names (org-A ≠ org-a)", () => {
    const lookup = makeLookup({ alice: ORG("org-A"), bob: ORG("org-a") });
    expect(checkOrgIsolation(lookup, "alice", "bob")).toBe(
      "Cross-org messaging blocked: org-A → org-a",
    );
  });
});

describe("checkOrgIsolation — unknown agents", () => {
  // These tests lock the semantic fix: an unknown agent is NOT silently
  // promoted to "global". Unknown sender or recipient is an explicit error.

  it("rejects an unknown sender with a clear error", () => {
    const lookup = makeLookup({ bob: GLOBAL });
    expect(checkOrgIsolation(lookup, "ghost", "bob")).toBe("Unknown agent: ghost");
  });

  it("rejects an unknown recipient with a clear error", () => {
    const lookup = makeLookup({ alice: GLOBAL });
    expect(checkOrgIsolation(lookup, "alice", "ghost")).toBe("Unknown agent: ghost");
  });

  it("rejects when both sender and recipient are unknown (sender reported first)", () => {
    const lookup = makeLookup({});
    expect(checkOrgIsolation(lookup, "a", "b")).toBe("Unknown agent: a");
  });

  it("still rejects an unknown recipient even when sender is in an org", () => {
    const lookup = makeLookup({ alice: ORG("acme") });
    expect(checkOrgIsolation(lookup, "alice", "ghost")).toBe("Unknown agent: ghost");
  });
});
