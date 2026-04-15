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
  // --- Workflow engine integration (optional; non-workflow callers omit these) ---
  /** Workflow run id. Exposed to the subagent process as RONDEL_RUN_ID. */
  readonly workflowRunId?: string;
  /** Workflow step key. Exposed to the subagent process as RONDEL_STEP_KEY. */
  readonly workflowStepKey?: string;
  /** Additional environment variables to inject into the subagent's MCP config. */
  readonly workflowEnv?: Readonly<Record<string, string>>;
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
