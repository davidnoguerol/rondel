// --- Config shapes ---

export interface FlowclawConfig {
  readonly projectId: string;
  readonly defaultModel: string;
  readonly agents: readonly string[];
  readonly allowedUsers: readonly string[];
}

// --- MCP config (shared between agent config and process spawning) ---

export interface McpServerEntry {
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
}

// --- Agent config ---

export interface AgentConfig {
  readonly agentName: string;
  readonly enabled: boolean;
  readonly model: string;
  readonly permissionMode: string;
  readonly workingDirectory: string | null;
  readonly telegram: {
    readonly botToken: string;
  };
  readonly tools: {
    readonly allowed: readonly string[];
    readonly disallowed: readonly string[];
  };
  readonly mcp?: {
    readonly servers?: Readonly<Record<string, McpServerEntry>>;
  };
  readonly crons?: readonly CronJob[];
}

// --- Cron / Scheduler ---

export interface CronJob {
  readonly id: string;
  readonly name: string;
  readonly enabled?: boolean; // default: true
  readonly schedule: CronSchedule;
  readonly prompt: string;
  readonly sessionTarget?: CronSessionTarget; // default: "isolated"
  readonly delivery?: CronDelivery;
  readonly model?: string;
  readonly timeoutMs?: number;
}

export interface CronSchedule {
  readonly kind: "every";
  readonly interval: string; // e.g. "30s", "5m", "1h", "24h", "2h30m"
}

export type CronSessionTarget = "isolated" | `session:${string}`;

export type CronDelivery =
  | { readonly mode: "none" }
  | { readonly mode: "announce"; readonly chatId: string };

export type CronRunStatus = "ok" | "error" | "skipped";

export interface CronJobState {
  lastRunAtMs?: number;
  nextRunAtMs?: number;
  consecutiveErrors: number;
  lastStatus?: CronRunStatus;
  lastError?: string;
  lastDurationMs?: number;
  lastCostUsd?: number;
}

export interface CronRunResult {
  readonly status: CronRunStatus;
  readonly result?: string;
  readonly error?: string;
  readonly costUsd?: number;
  readonly durationMs: number;
}

// --- Agent process events (stream-json protocol) ---

export interface AgentInitEvent {
  readonly type: "system";
  readonly subtype: "init";
  readonly session_id: string;
  readonly tools: readonly unknown[];
}

export interface AgentAssistantEvent {
  readonly type: "assistant";
  readonly message: {
    readonly content: readonly AgentContentBlock[];
  };
  readonly session_id: string;
}

export type AgentContentBlock =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "tool_use"; readonly id: string; readonly name: string; readonly input: unknown }
  | { readonly type: "tool_result"; readonly tool_use_id: string; readonly content: string };

export interface AgentResultEvent {
  readonly type: "result";
  readonly result: string;
  readonly session_id: string;
  readonly total_cost_usd: number;
  readonly is_error: boolean;
}

export type AgentEvent = AgentInitEvent | AgentAssistantEvent | AgentResultEvent | AgentRawEvent;

export interface AgentRawEvent {
  readonly type: string;
  readonly [key: string]: unknown;
}

// --- Agent state ---

export type AgentState = "starting" | "idle" | "busy" | "crashed" | "halted" | "stopped";

// --- Subagents ---

export interface SubagentSpawnRequest {
  readonly parentAgentName: string;
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
  readonly parentChatId: string;
  readonly task: string;
  readonly state: SubagentState;
  readonly result?: string;
  readonly error?: string;
  readonly costUsd?: number;
  readonly startedAt: string;
  readonly completedAt?: string;
}

// --- Session persistence ---

export interface SessionEntry {
  readonly sessionId: string;          // Claude CLI session UUID
  readonly agentName: string;
  readonly chatId: string;
  readonly createdAt: number;          // epoch ms
  updatedAt: number;                   // epoch ms — updated on each turn
}

/** Maps conversation keys ({agentName}:{chatId}) to session entries. */
export type SessionIndex = Record<string, SessionEntry>;

// --- Transcript entries (user-constructed; stream-json events are written raw) ---

export interface TranscriptSessionHeader {
  readonly type: "session_start";
  readonly sessionId: string;
  readonly agentName: string;
  readonly chatId: string;
  readonly model: string;
  readonly timestamp: string;          // ISO 8601
}

export interface TranscriptUserEntry {
  readonly type: "user";
  readonly text: string;
  readonly senderId?: string;
  readonly senderName?: string;
  readonly timestamp: string;          // ISO 8601
}

// --- Router ---

export interface QueuedMessage {
  readonly agentName: string;
  readonly accountId: string;
  readonly chatId: string;
  readonly text: string;
  readonly queuedAt: number;
}
