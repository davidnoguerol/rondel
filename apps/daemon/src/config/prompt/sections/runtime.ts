/**
 * One-line Runtime summary — concrete facts about this spawn so the
 * agent can answer "what model am I? which channel am I on?" without a
 * tool call.
 *
 * Inspired by OpenClaw's Runtime line, trimmed to fields we have and use.
 */

export interface RuntimeInputs {
  readonly agentName: string;
  readonly orgName: string | null;
  readonly model: string;
  readonly channelType: string | null;
  readonly workingDirectory: string;
}

export function buildRuntime({
  agentName,
  orgName,
  model,
  channelType,
  workingDirectory,
}: RuntimeInputs): string {
  const parts = [
    `agent=${agentName}`,
    `org=${orgName ?? "global"}`,
    `model=${model}`,
    channelType ? `channel=${channelType}` : null,
    `working_dir=${workingDirectory}`,
  ].filter((p): p is string => p !== null);
  return ["## Runtime", parts.join(" | ")].join("\n");
}
