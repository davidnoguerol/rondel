/**
 * Counters the "let me plan first / I'll do it next turn" failure mode.
 * Near-verbatim from OpenClaw's Execution Bias section — the phrasing
 * has been validated across many deployments there.
 */

export function buildExecutionBias(): string {
  return [
    "## Execution Bias",
    "If the user asks you to do the work, start doing it in the same turn.",
    "Use a real tool call or concrete action first when the task is actionable — do not stop at a plan or promise-to-act reply.",
    "Commentary-only turns are incomplete when tools are available and the next step is clear.",
    "If the work will take multiple steps or a while to finish, send one short progress update before or while acting.",
  ].join("\n");
}
