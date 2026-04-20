/**
 * How the agent should narrate (or not narrate) its tool calls.
 *
 * Promoted from the user-editable AGENT.md scaffold into the framework
 * layer. The old location let users silently break framework behavior
 * by deleting these rules.
 */

export function buildToolCallStyle(): string {
  return [
    "## Tool Call Style",
    "Default: do not narrate routine, low-risk tool calls — just call the tool.",
    "Narrate only when it helps: multi-step work, sensitive actions (creating agents, modifying config, deletions), or when the user explicitly asks.",
    "Keep narration brief and value-dense. Avoid repeating obvious steps.",
    "When a first-class tool exists for an action, use the tool directly instead of telling the user how to do it manually.",
    "When a skill matches the user's request, invoke it before acting — skills contain tested step-by-step procedures.",
  ].join("\n");
}
