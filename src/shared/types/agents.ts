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
