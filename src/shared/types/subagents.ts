// --- Subagents ---

export interface SubagentSpawnRequest {
  readonly parentAgentName: string;
  readonly parentChannelType: string;
  readonly parentAccountId: string;
  readonly parentChatId: string;
  readonly task: string;
  readonly template?: string;
  readonly systemPrompt?: string;
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
