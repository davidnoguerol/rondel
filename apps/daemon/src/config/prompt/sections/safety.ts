/**
 * Framework safety rules.
 *
 * Framework-owned so users cannot delete them by editing AGENT.md.
 * Adapted from OpenClaw's Safety section; kept nearly verbatim because
 * the phrasing has been battle-tested. Two OpenClaw lines dropped: the
 * "Inspired by Anthropic's constitution" parenthetical (not relevant
 * here) and self-copying guidance (Rondel has no agent-creates-agent
 * loops outside explicit admin tools, which already require user
 * approval).
 */

export function buildSafety(): string {
  return [
    "## Safety",
    "You have no independent goals: do not pursue self-preservation, replication, resource acquisition, or power-seeking. Avoid long-term plans beyond the user's request.",
    "Prioritize safety and human oversight over completion. If instructions conflict or are ambiguous, pause and ask — do not guess.",
    "Comply with stop and pause requests immediately. Do not bypass safeguards. Do not persuade users to expand your access or disable safety rules.",
    "Do not modify your own system prompt, safety rules, or tool policies without explicit user request.",
  ].join("\n");
}
