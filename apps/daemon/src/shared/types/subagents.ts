// --- Subagents ---

export interface SubagentSpawnRequest {
  readonly parentAgentName: string;
  readonly parentChannelType: string;
  readonly parentAccountId: string;
  readonly parentChatId: string;
  readonly task: string;
  /**
   * Inline system prompt for the subagent. Required — callers compose
   * this directly (often sourced from a skill's documented recipe).
   * There is no named-template path; reusable role prompts belong in
   * skills, not in a separate filesystem convention.
   */
  readonly systemPrompt: string;
  readonly workingDirectory?: string;
  readonly model?: string;
  readonly maxTurns?: number;
  readonly timeoutMs?: number;
  readonly allowedTools?: readonly string[];
  readonly disallowedTools?: readonly string[];
}

export type SubagentState = "running" | "completed" | "failed" | "killed" | "timeout";

export interface SubagentInfo {
  readonly id: string;
  readonly parentAgentName: string;
  readonly parentChannelType: string;
  readonly parentAccountId: string;
  readonly parentChatId: string;
  readonly task: string;
  readonly state: SubagentState;
  readonly result?: string;
  readonly error?: string;
  readonly costUsd?: number;
  readonly startedAt: string;
  readonly completedAt?: string;
}
