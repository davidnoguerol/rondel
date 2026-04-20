/**
 * Rondel CLI commands the agent may need to reference in conversation.
 *
 * Prevents the agent from hallucinating shell invocations when a user
 * asks "how do I restart Rondel?" or similar. Emitted only in
 * non-ephemeral modes — subagents and cron runs don't have a user to
 * talk to about CLI commands.
 */

export function buildCliQuickReference({ isEphemeral }: { isEphemeral: boolean }): string | null {
  if (isEphemeral) return null;
  return [
    "## Rondel CLI Quick Reference",
    "Rondel is controlled via subcommands. Do not invent commands.",
    "- `rondel status` — show running instance state",
    "- `rondel restart` — restart the OS service",
    "- `rondel logs [-f] [-n N]` — view orchestrator logs",
    "- `rondel doctor` — validate the installation",
    "- `rondel add agent [name]` — scaffold a new agent",
    "- `rondel add org [name]` — scaffold a new organization",
    "If unsure, ask the user to run `rondel --help` and paste the output.",
  ].join("\n");
}
