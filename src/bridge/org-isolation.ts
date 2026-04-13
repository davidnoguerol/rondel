/**
 * Cross-org messaging isolation check.
 *
 * This module is the multi-tenant security boundary for inter-agent
 * messaging. An unknown agent is NOT silently promoted to "global" —
 * that would let typos or deleted agents slip past isolation. Callers
 * must supply a lookup that explicitly distinguishes the three states.
 *
 * Extracted as a pure function so the boundary can be exhaustively
 * tested without spinning up the HTTP bridge or an AgentManager.
 */

/**
 * Result of resolving an agent name against the current registry.
 *
 * - `global`  : the agent exists and belongs to no organization
 * - `org`     : the agent exists and belongs to an organization
 * - `unknown` : the agent does not exist in the registry
 */
export type OrgResolution =
  | { readonly status: "global" }
  | { readonly status: "org"; readonly orgName: string }
  | { readonly status: "unknown" };

export type OrgLookup = (agentName: string) => OrgResolution;

/**
 * Check whether `from` is allowed to send an inter-agent message to `to`.
 *
 * Rules:
 * 1. Unknown agents are rejected — messaging must target a registered recipient.
 * 2. A global agent (no org) can message any registered agent.
 * 3. Anyone can message a global agent.
 * 4. Same-org messaging is allowed.
 * 5. Cross-org messaging is blocked.
 *
 * @returns `null` when the message is allowed, or an error string when blocked.
 */
export function checkOrgIsolation(
  lookup: OrgLookup,
  from: string,
  to: string,
): string | null {
  const fromRes = lookup(from);
  if (fromRes.status === "unknown") return `Unknown agent: ${from}`;

  const toRes = lookup(to);
  if (toRes.status === "unknown") return `Unknown agent: ${to}`;

  // Either side being global permits the message.
  if (fromRes.status === "global" || toRes.status === "global") return null;

  // Both are in an org — must match.
  if (fromRes.orgName === toRes.orgName) return null;

  return `Cross-org messaging blocked: ${fromRes.orgName} → ${toRes.orgName}`;
}
