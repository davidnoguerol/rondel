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

/**
 * A single conversation's current state, surfaced to in-process subscribers
 * (e.g. the SSE stream that powers the web UI's live agent badges).
 *
 * Used as both:
 *   - delta payload (one entry per state transition), and
 *   - snapshot entry (one entry per active conversation when a client connects).
 *
 * For deltas, `ts` is the transition time. For snapshots, all entries share
 * the snapshot time. The fields are otherwise identical so the consumer can
 * use one shape for both.
 */
export interface AgentStateEvent {
  readonly agentName: string;
  readonly chatId: string;
  readonly channelType: string;
  readonly state: AgentState;
  readonly sessionId: string;
  readonly ts: string; // ISO 8601
}
