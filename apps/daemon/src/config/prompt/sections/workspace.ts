/**
 * Workspace section — the agent's concrete filesystem footprint.
 *
 * Replaces the legacy "## Your environment" block (Layer 0.5) which had
 * a literal `<skill-name>` placeholder that models sometimes echoed
 * verbatim. The new version uses a concrete placeholder slug with a
 * parenthetical telling the model not to use it literally.
 *
 * Two shapes:
 * - Persistent agents: lists memory + skills paths and prompt-load structure.
 * - Ephemeral runs (subagent, cron): minimal — memory/user not loaded,
 *   and the agent is reminded it's a one-shot process.
 */

export interface WorkspaceInputs {
  readonly agentDir: string;
  readonly workingDirectory: string | null;
  readonly isEphemeral: boolean;
}

export function buildWorkspace({
  agentDir,
  workingDirectory,
  isEphemeral,
}: WorkspaceInputs): string {
  const workDir = workingDirectory ?? agentDir;
  if (isEphemeral) {
    return [
      "## Workspace",
      `Your agent directory is: ${agentDir}`,
      `Your working directory for tool calls is: ${workDir}`,
      "You are an ephemeral process — memory and user profile are not loaded. Complete the task and exit.",
    ].join("\n");
  }
  return [
    "## Workspace",
    `Your agent directory is: ${agentDir}`,
    `Your working directory for tool calls (bash, file reads/writes) is: ${workDir}`,
    `Author new skills at ${agentDir}/.claude/skills/<your-chosen-slug>/SKILL.md (pick a real slug — do not use the literal text \`<your-chosen-slug>\`).`,
    "Save memory via `rondel_memory_save` — do not write directly to MEMORY.md.",
  ].join("\n");
}
