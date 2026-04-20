/**
 * Zod schemas for bridge response validation.
 *
 * Every bridge method in `client.ts` runs its response through one of these
 * schemas before returning typed data. The daemon also validates its own
 * responses internally, but we validate again at the web boundary for a
 * specific reason:
 *
 *   The web package and daemon package ship independently. A user may
 *   upgrade one without the other. Without a Zod validation at the seam,
 *   a response shape change silently corrupts the UI. With it, we get
 *   a loud, actionable error at the exact boundary (caught and surfaced
 *   as `BridgeSchemaError` → visible in the error boundary).
 *
 * When a daemon endpoint changes its response shape, the schema here must
 * change to match, AND `BRIDGE_API_VERSION` in
 * apps/daemon/src/bridge/schemas.ts must bump. The fixture test in
 * `__tests__/schemas.test.ts` catches passive drift.
 */
import { z } from "zod";

// -----------------------------------------------------------------------------
// Shared atoms
// -----------------------------------------------------------------------------

export const AgentStateSchema = z.enum([
  "starting",
  "idle",
  "busy",
  "crashed",
  "halted",
  "stopped",
]);
export type AgentState = z.infer<typeof AgentStateSchema>;

export const ConversationSummarySchema = z.object({
  chatId: z.string(),
  state: AgentStateSchema,
  sessionId: z.string().nullable(),
});
export type ConversationSummary = z.infer<typeof ConversationSummarySchema>;

// -----------------------------------------------------------------------------
// GET /version
// -----------------------------------------------------------------------------

export const VersionResponseSchema = z.object({
  apiVersion: z.number().int(),
  rondelVersion: z.string(),
});
export type VersionResponse = z.infer<typeof VersionResponseSchema>;

// -----------------------------------------------------------------------------
// GET /agents
// -----------------------------------------------------------------------------

export const AgentSummarySchema = z.object({
  name: z.string(),
  org: z.string().optional(),
  activeConversations: z.number().int().min(0),
  conversations: z.array(ConversationSummarySchema),
});
export type AgentSummary = z.infer<typeof AgentSummarySchema>;

export const ListAgentsResponseSchema = z.object({
  agents: z.array(AgentSummarySchema),
});
export type ListAgentsResponse = z.infer<typeof ListAgentsResponseSchema>;

// -----------------------------------------------------------------------------
// GET /agents/:name/prompt — raw assembled system prompts
// -----------------------------------------------------------------------------

export const AgentPromptResponseSchema = z.object({
  agentName: z.string(),
  systemPrompt: z.string(),
  agentMailPrompt: z.string().nullable(),
});
export type AgentPromptResponse = z.infer<typeof AgentPromptResponseSchema>;

// -----------------------------------------------------------------------------
// GET /conversations/:name
// -----------------------------------------------------------------------------

export const ConversationsResponseSchema = z.object({
  agent: z.string(),
  conversations: z.array(ConversationSummarySchema),
});
export type ConversationsResponse = z.infer<typeof ConversationsResponseSchema>;

// -----------------------------------------------------------------------------
// GET /memory/:agent
// -----------------------------------------------------------------------------

export const MemoryResponseSchema = z.object({
  content: z.string().nullable(),
});
export type MemoryResponse = z.infer<typeof MemoryResponseSchema>;

// -----------------------------------------------------------------------------
// PUT /memory/:agent
// -----------------------------------------------------------------------------

export const MemoryWriteResponseSchema = z.object({
  ok: z.literal(true),
});

// -----------------------------------------------------------------------------
// GET /ledger/query
// -----------------------------------------------------------------------------

/**
 * Wire contract: must stay in sync with the daemon's
 * `LEDGER_EVENT_KINDS` array in
 * `apps/daemon/src/ledger/ledger-types.ts`. Missing entries here cause
 * `/ledger/query` responses with unknown kinds to be rejected by the
 * Zod parser at the HTTP boundary (the symptom is a "Bridge response
 * schema mismatch" error in the UI). Keep this list identical to the
 * daemon's — any new kind added on the daemon side must be added here
 * the same commit.
 */
export const LedgerEventKindSchema = z.enum([
  "user_message",
  "agent_response",
  "inter_agent_sent",
  "inter_agent_received",
  "subagent_spawned",
  "subagent_result",
  "cron_completed",
  "cron_failed",
  "session_start",
  "session_resumed",
  "session_reset",
  "crash",
  "halt",
  "approval_request",
  "approval_decision",
  "tool_call",
  "schedule_created",
  "schedule_updated",
  "schedule_deleted",
  "schedule_overdue",
  "schedule_recovered",
]);

export const LedgerEventSchema = z.object({
  ts: z.string(),
  agent: z.string(),
  kind: LedgerEventKindSchema,
  // Invariant: channelType and chatId are a pair — both present for
  // conversation/session-bound events, both absent for system-wide events
  // (cron). The writer always sets them together.
  channelType: z.string().optional(),
  chatId: z.string().optional(),
  summary: z.string(),
  detail: z.unknown().optional(),
});
export type LedgerEvent = z.infer<typeof LedgerEventSchema>;
export type LedgerEventKind = z.infer<typeof LedgerEventKindSchema>;

export const LedgerQueryResponseSchema = z.object({
  events: z.array(LedgerEventSchema),
});
export type LedgerQueryResponse = z.infer<typeof LedgerQueryResponseSchema>;

// -----------------------------------------------------------------------------
// SSE — GET /ledger/tail and /ledger/tail/:agent
// -----------------------------------------------------------------------------
//
// Each frame is JSON-decoded from the SSE `data:` line. The wrapper carries
// the daemon's event tag so consumers can discriminate even if multiple
// frame kinds arrive on the same stream in the future.

export const LedgerStreamFrameSchema = z.object({
  event: z.literal("ledger.appended"),
  data: LedgerEventSchema,
});
export type LedgerStreamFrame = z.infer<typeof LedgerStreamFrameSchema>;

// -----------------------------------------------------------------------------
// SSE — GET /agents/state/tail
// -----------------------------------------------------------------------------
//
// Two frame kinds on this stream:
//   - `agent_state.snapshot` — the full state of every conversation, sent
//     once per client when the connection opens.
//   - `agent_state.delta` — one entry per state transition.
//
// The Zod schema is a discriminated union so consumers branch on `event`
// statically. The web reducer treats snapshot as "replace the Map" and
// delta as "set one Map entry".

export const AgentStateEntrySchema = z.object({
  agentName: z.string(),
  chatId: z.string(),
  channelType: z.string(),
  state: AgentStateSchema,
  // Contract: ConversationManager always assigns a sessionId (resumed or
  // freshly-minted UUID) BEFORE constructing the AgentProcess, so every
  // state change and every snapshot entry carries a non-empty string. If
  // that invariant ever changes on the daemon side, relax this to
  // `z.string().nullable()` and update the reducer in use-agent-state-tail.
  sessionId: z.string(),
  ts: z.string(),
});
export type AgentStateEntry = z.infer<typeof AgentStateEntrySchema>;

export const AgentStateSnapshotFrameSchema = z.object({
  event: z.literal("agent_state.snapshot"),
  data: z.object({
    kind: z.literal("snapshot"),
    entries: z.array(AgentStateEntrySchema),
  }),
});

export const AgentStateDeltaFrameSchema = z.object({
  event: z.literal("agent_state.delta"),
  data: z.object({
    kind: z.literal("delta"),
    entry: AgentStateEntrySchema,
  }),
});

export const AgentStateFrameSchema = z.discriminatedUnion("event", [
  AgentStateSnapshotFrameSchema,
  AgentStateDeltaFrameSchema,
]);
export type AgentStateFrame = z.infer<typeof AgentStateFrameSchema>;

// -----------------------------------------------------------------------------
// Web chat — POST /web/messages/send, GET /conversations/.../history, SSE tail
// -----------------------------------------------------------------------------
//
// These schemas mirror the daemon's Zod shapes in apps/daemon/src/bridge/schemas.ts.
// The web package re-validates at the boundary so a daemon drift produces a
// loud BridgeSchemaError instead of a silent UI corruption.

/**
 * The single, canonical chat id used by the web channel in Option B
 * ("one web chat per agent"). All browser tabs open to the same
 * conversation for a given agent, which keeps process count flat.
 * Change cautiously — the daemon accepts any `web-`-prefixed id.
 */
export const WEB_MAIN_CHAT_ID = "web-main";

export const WebSendResponseSchema = z.object({
  ok: z.literal(true),
});
export type WebSendResponse = z.infer<typeof WebSendResponseSchema>;

export const ConversationTurnSchema = z.object({
  role: z.enum(["user", "assistant"]),
  text: z.string(),
  ts: z.string().optional(),
});
export type ConversationTurn = z.infer<typeof ConversationTurnSchema>;

export const ConversationHistoryResponseSchema = z.object({
  turns: z.array(ConversationTurnSchema),
  sessionId: z.string().nullable(),
});
export type ConversationHistoryResponse = z.infer<typeof ConversationHistoryResponseSchema>;

export const ConversationStreamFrameDataSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("user_message"),
    ts: z.string(),
    text: z.string(),
    senderName: z.string().optional(),
  }),
  z.object({
    kind: z.literal("agent_response"),
    ts: z.string(),
    text: z.string(),
    // Present when the daemon is emitting partial-message deltas
    // (bridge API v4+). Reconciles with preceding agent_response_delta
    // frames sharing the same blockId — the canonical text in this
    // frame is the source of truth. Accumulated deltas get replaced.
    blockId: z.string().optional(),
  }),
  z.object({
    // One chunk of a streaming assistant response. Append to the
    // in-progress bubble for `blockId`. Ephemeral — not persisted,
    // not replayed on reconnect. The corresponding `agent_response`
    // frame will overwrite accumulated text when it arrives.
    kind: z.literal("agent_response_delta"),
    ts: z.string(),
    blockId: z.string(),
    chunk: z.string(),
  }),
  z.object({
    kind: z.literal("typing_start"),
    ts: z.string(),
  }),
  z.object({
    kind: z.literal("typing_stop"),
    ts: z.string(),
  }),
  z.object({
    kind: z.literal("session"),
    ts: z.string(),
    event: z.enum(["start", "resumed", "reset", "crash", "halt"]),
    sessionId: z.string().optional(),
  }),
]);
export type ConversationStreamFrameData = z.infer<typeof ConversationStreamFrameDataSchema>;

export const ConversationStreamFrameSchema = z.object({
  event: z.literal("conversation.frame"),
  data: ConversationStreamFrameDataSchema,
});
export type ConversationStreamFrame = z.infer<typeof ConversationStreamFrameSchema>;

// -----------------------------------------------------------------------------
// HITL approvals — GET /approvals, GET /approvals/:id, POST /approvals/:id/resolve
// -----------------------------------------------------------------------------
//
// These mirror the daemon Zod shapes in apps/daemon/src/bridge/schemas.ts.
// See apps/daemon/src/approvals/ for the service and
// apps/daemon/templates/framework-hooks/ for the hook script that
// creates pending records.

export const ApprovalReasonSchema = z.enum([
  "dangerous_bash",
  "write_outside_safezone",
  "bash_system_write",
  "potential_secret_in_content",
  "write_without_read",
  "unknown_tool",
  "agent_initiated",
]);
export type ApprovalReason = z.infer<typeof ApprovalReasonSchema>;

export const ApprovalDecisionSchema = z.enum(["allow", "deny"]);
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

/**
 * Tool-use approval record (Tier 1 safety net).
 *
 * Only one record shape exists: a tool-use escalation from the
 * PreToolUse hook. Fields: toolName/toolInput/summary/reason, decision
 * is allow/deny.
 */
export const ToolUseApprovalRecordSchema = z.object({
  requestId: z.string(),
  status: z.enum(["pending", "resolved"]),
  agentName: z.string(),
  channelType: z.string().optional(),
  chatId: z.string().optional(),
  toolName: z.string(),
  toolInput: z.unknown().optional(),
  summary: z.string(),
  reason: ApprovalReasonSchema,
  createdAt: z.string(),
  resolvedAt: z.string().optional(),
  decision: ApprovalDecisionSchema.optional(),
  resolvedBy: z.string().optional(),
});
export type ToolUseApprovalRecord = z.infer<typeof ToolUseApprovalRecordSchema>;

/**
 * After the Tier 2 removal there is only one record shape, so
 * `ApprovalRecord` is a direct alias of `ToolUseApprovalRecord`. The
 * named export is kept so API consumers don't have to pick between two
 * synonyms.
 */
export const ApprovalRecordSchema = ToolUseApprovalRecordSchema;
export type ApprovalRecord = z.infer<typeof ApprovalRecordSchema>;

export const ApprovalListResponseSchema = z.object({
  pending: z.array(ApprovalRecordSchema),
  resolved: z.array(ApprovalRecordSchema),
});
export type ApprovalListResponse = z.infer<typeof ApprovalListResponseSchema>;

export const ApprovalResolveResponseSchema = z.object({
  ok: z.literal(true),
});

// -----------------------------------------------------------------------------
// SSE — GET /approvals/tail
// -----------------------------------------------------------------------------
//
// The daemon fires one frame per approval lifecycle event. Clients merge
// these into the server-rendered initial list:
//   - `approval.requested` → add to `pending`
//   - `approval.resolved`  → remove from `pending`, prepend to `resolved`

export const ApprovalStreamRequestedFrameSchema = z.object({
  event: z.literal("approval.requested"),
  data: ApprovalRecordSchema,
});

export const ApprovalStreamResolvedFrameSchema = z.object({
  event: z.literal("approval.resolved"),
  data: ApprovalRecordSchema,
});

export const ApprovalStreamFrameSchema = z.discriminatedUnion("event", [
  ApprovalStreamRequestedFrameSchema,
  ApprovalStreamResolvedFrameSchema,
]);
export type ApprovalStreamFrame = z.infer<typeof ApprovalStreamFrameSchema>;

// -----------------------------------------------------------------------------
// Schedules — GET /schedules, POST/PATCH/DELETE /schedules/:id, SSE tail
// -----------------------------------------------------------------------------
//
// Mirrors the daemon Zod shapes in apps/daemon/src/bridge/schemas.ts. The
// kind of schedule (every / at / cron) is a discriminated union on `kind`;
// delivery mode is a discriminated union on `mode`. Every field here is
// validated on read; writes go through Server Actions which construct the
// full request payload server-side.

export const ScheduleIntervalRegex = /^\d+[dhms](?:\d+[dhms])*$/;

export const ScheduleIdSchema = z.string().regex(
  /^sched_\d+_[a-f0-9]+$/,
  "Expected schedule id format (sched_<epoch>_<hex>)",
);

export const ScheduleKindSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("every"),
    interval: z.string().regex(ScheduleIntervalRegex, 'Expected interval like "30s", "5m", "1h", "2h30m"'),
  }),
  z.object({
    kind: z.literal("at"),
    at: z.string().min(1),
  }),
  z.object({
    kind: z.literal("cron"),
    expression: z.string().min(1),
    timezone: z.string().optional(),
  }),
]);
export type ScheduleKind = z.infer<typeof ScheduleKindSchema>;

export const ScheduleDeliverySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("none") }),
  z.object({
    mode: z.literal("announce"),
    chatId: z.string().min(1),
    channelType: z.string().min(1).optional(),
    accountId: z.string().min(1).optional(),
  }),
]);
export type ScheduleDelivery = z.infer<typeof ScheduleDeliverySchema>;

export const ScheduleSessionTargetSchema = z.union([
  z.literal("isolated"),
  z.string().regex(/^session:[A-Za-z0-9_-]+$/, 'Expected "isolated" or "session:<name>"'),
]);
export type ScheduleSessionTarget = z.infer<typeof ScheduleSessionTargetSchema>;

export const ScheduleStatusSchema = z.enum(["ok", "error", "skipped"]);
export type ScheduleStatus = z.infer<typeof ScheduleStatusSchema>;

export const ScheduleSourceSchema = z.enum(["declarative", "runtime"]);
export type ScheduleSource = z.infer<typeof ScheduleSourceSchema>;

/**
 * Wire shape of `ScheduleService.summarize()` on the daemon. Every read
 * endpoint and every SSE frame carries this. Kept structurally identical
 * to apps/daemon/src/bridge/schemas.ts `ScheduleSummarySchema` — the
 * fixture test in __tests__/schemas.test.ts catches drift.
 */
export const ScheduleSummarySchema = z.object({
  id: ScheduleIdSchema,
  name: z.string(),
  owner: z.string().optional(),
  enabled: z.boolean(),
  schedule: ScheduleKindSchema,
  prompt: z.string(),
  delivery: ScheduleDeliverySchema.optional(),
  sessionTarget: ScheduleSessionTargetSchema,
  deleteAfterRun: z.boolean().optional(),
  model: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
  source: ScheduleSourceSchema,
  createdAtMs: z.number().int().nonnegative().optional(),
  nextRunAtMs: z.number().int().nonnegative().optional(),
  lastRunAtMs: z.number().int().nonnegative().optional(),
  lastStatus: ScheduleStatusSchema.optional(),
  consecutiveErrors: z.number().int().nonnegative().optional(),
});
export type ScheduleSummary = z.infer<typeof ScheduleSummarySchema>;

export const ScheduleListResponseSchema = z.object({
  schedules: z.array(ScheduleSummarySchema),
});
export type ScheduleListResponse = z.infer<typeof ScheduleListResponseSchema>;

export const ScheduleDeleteResponseSchema = z.object({
  deleted: z.literal(true),
});

export const ScheduleRunResponseSchema = z.object({
  triggered: z.literal(true),
});

/**
 * Shape consumed by `bridge.schedules.create` (Server Actions). Mirrors
 * the daemon's `ScheduleCreateSchema`. `targetAgent` is never sent from
 * the web — the caller's own agent is always the target.
 */
export const ScheduleCreateInputSchema = z.object({
  name: z.string().min(1).max(200),
  schedule: ScheduleKindSchema,
  prompt: z.string().min(1),
  delivery: ScheduleDeliverySchema.optional(),
  sessionTarget: ScheduleSessionTargetSchema.optional(),
  model: z.string().min(1).optional(),
  timeoutMs: z.number().int().positive().max(2 * 60 * 60 * 1000).optional(),
  deleteAfterRun: z.boolean().optional(),
  enabled: z.boolean().optional(),
});
export type ScheduleCreateInput = z.infer<typeof ScheduleCreateInputSchema>;

export const ScheduleUpdateInputSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  schedule: ScheduleKindSchema.optional(),
  prompt: z.string().min(1).optional(),
  delivery: ScheduleDeliverySchema.optional(),
  sessionTarget: ScheduleSessionTargetSchema.optional(),
  model: z.string().min(1).nullable().optional(),
  timeoutMs: z.number().int().positive().max(2 * 60 * 60 * 1000).optional(),
  deleteAfterRun: z.boolean().optional(),
  enabled: z.boolean().optional(),
});
export type ScheduleUpdateInput = z.infer<typeof ScheduleUpdateInputSchema>;

// -----------------------------------------------------------------------------
// SSE — GET /schedules/tail
// -----------------------------------------------------------------------------

export const ScheduleCreatedFrameSchema = z.object({
  event: z.literal("schedule.created"),
  data: ScheduleSummarySchema,
});

export const ScheduleUpdatedFrameSchema = z.object({
  event: z.literal("schedule.updated"),
  data: ScheduleSummarySchema,
});

export const ScheduleDeletedFrameSchema = z.object({
  event: z.literal("schedule.deleted"),
  data: ScheduleSummarySchema.extend({
    reason: z.enum(["requested", "ran_once", "owner_deleted"]),
  }),
});

export const ScheduleRanFrameSchema = z.object({
  event: z.literal("schedule.ran"),
  data: ScheduleSummarySchema,
});

export const ScheduleStreamFrameSchema = z.discriminatedUnion("event", [
  ScheduleCreatedFrameSchema,
  ScheduleUpdatedFrameSchema,
  ScheduleDeletedFrameSchema,
  ScheduleRanFrameSchema,
]);
export type ScheduleStreamFrame = z.infer<typeof ScheduleStreamFrameSchema>;
