/**
 * Zod schemas for bridge admin endpoint validation.
 *
 * Validates request bodies at the HTTP boundary before they reach
 * AdminApi business logic. Replaces manual property checks with
 * structured validation that produces clear error messages.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Bridge API version
// ---------------------------------------------------------------------------

/**
 * Bridge API version. Bumped manually when any endpoint's contract changes
 * in a way that would break existing consumers (web UI, future CLI clients).
 *
 * Exposed via GET /version so clients can detect daemon/client version skew
 * and render a clear "daemon too old, please upgrade" message instead of
 * cryptic Zod validation failures.
 *
 * Rules of thumb for bumping:
 *  - Adding a new endpoint:        no bump
 *  - Adding a new optional field:  no bump
 *  - Removing/renaming a field:    BUMP
 *  - Changing a field type:        BUMP
 *  - Tightening validation:        BUMP
 *  - Adding NEW PRIMITIVE (e.g. SSE streams):  BUMP — clients need to
 *    know whether the streaming endpoints exist before opening a tail.
 *
 * History:
 *   1 — initial M1 surface (request-response only)
 *   2 — M2 adds SSE streams: /ledger/tail, /ledger/tail/:agent,
 *       /agents/state/tail
 *   3 — Web chat: POST /web/messages/send,
 *       GET /conversations/:agent/:channelType/:chatId/history,
 *       GET /conversations/:agent/:channelType/:chatId/tail (SSE)
 *   4 — Token-level streaming on the conversation tail: new frame kind
 *       `agent_response_delta` and optional `blockId` on `agent_response`.
 *       Additive — old clients (v3) ignore unknown kinds but lose
 *       smooth streaming until they upgrade.
 *   5 — Workflow engine v0: new /workflows/* endpoints, new ledger kinds
 *       (`workflow_*`), new MCP tools (`rondel_workflow_start`,
 *       `rondel_step_complete`, `rondel_resolve_gate`). Fully additive —
 *       clients on v4 keep working, they just don't see workflow frames.
 */
export const BRIDGE_API_VERSION = 5 as const;

// ---------------------------------------------------------------------------
// Reusable field validators
// ---------------------------------------------------------------------------

const agentName = z.string().regex(
  /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/,
  "Must start with a letter/number and contain only letters, numbers, hyphens, underscores",
);

const botToken = z.string().regex(
  /^\d+:.+$/,
  "Expected Telegram bot token format (e.g., 123456:ABC...)",
);

const envKey = z.string().regex(
  /^[A-Z_][A-Z0-9_]*$/,
  "Must be uppercase letters, digits, and underscores (e.g., BOT_TOKEN)",
);

// ---------------------------------------------------------------------------
// Admin endpoint schemas
// ---------------------------------------------------------------------------

/** POST /admin/agents */
export const AddAgentSchema = z.object({
  agent_name: agentName,
  bot_token: botToken,
  model: z.string().optional(),
  location: z.string().optional(),
  working_directory: z.string().optional(),
});
export type AddAgentInput = z.infer<typeof AddAgentSchema>;

/** PATCH /admin/agents/:name */
export const UpdateAgentSchema = z.object({
  model: z.string().optional(),
  enabled: z.boolean().optional(),
  admin: z.boolean().optional(),
  workingDirectory: z.string().nullable().optional(),
});
export type UpdateAgentInput = z.infer<typeof UpdateAgentSchema>;

/** POST /admin/orgs */
export const AddOrgSchema = z.object({
  org_name: agentName,
  display_name: z.string().optional(),
});
export type AddOrgInput = z.infer<typeof AddOrgSchema>;

/** PUT /admin/env */
export const SetEnvSchema = z.object({
  key: envKey,
  value: z.string(),
});
export type SetEnvInput = z.infer<typeof SetEnvSchema>;

// ---------------------------------------------------------------------------
// Inter-agent messaging schemas
// ---------------------------------------------------------------------------

/** POST /messages/send */
export const SendMessageSchema = z.object({
  from: agentName,
  to: agentName,
  content: z.string().min(1, "Message content must not be empty"),
  reply_to_chat_id: z.string().min(1),
});
export type SendMessageInput = z.infer<typeof SendMessageSchema>;

// ---------------------------------------------------------------------------
// Web-chat schemas
// ---------------------------------------------------------------------------

/**
 * Chat ids that the web UI generates for its own conversations. The prefix
 * is a soft boundary: it distinguishes browser-originated chats from
 * Telegram chats so the POST /web/messages/send endpoint can refuse to inject
 * into channels it doesn't own.
 */
const WEB_CHAT_ID_PREFIX = "web-";

const webChatId = z.string()
  .min(1)
  .refine(
    (v) => v.startsWith(WEB_CHAT_ID_PREFIX),
    `Web chat IDs must start with "${WEB_CHAT_ID_PREFIX}"`,
  );

/** POST /web/messages/send */
export const WebSendRequestSchema = z.object({
  agent_name: agentName,
  chat_id: webChatId,
  text: z.string().min(1, "Message text must not be empty"),
});
export type WebSendRequestInput = z.infer<typeof WebSendRequestSchema>;

/**
 * Shape for a single historical turn returned by
 * GET /conversations/{agent}/{channelType}/{chatId}/history.
 */
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

/**
 * Single-kind SSE frame for the per-conversation tail. The bridge always
 * emits this as `event: "conversation.frame"`, so the web client only needs
 * one Zod schema at the boundary. The `data.kind` discriminator tells the
 * reducer what to do with the payload.
 */
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
    // Present when partial-message streaming is active (bridge API v4+).
    // Matches the blockId on preceding `agent_response_delta` frames so
    // clients can reconcile streamed chunks with the canonical complete
    // text ("deltas are hints, blocks are truth").
    blockId: z.string().optional(),
  }),
  z.object({
    // One chunk of a streaming assistant response. Consumers accumulate
    // by `blockId` and overwrite with the corresponding `agent_response`
    // frame's text when it arrives. Ephemeral — never persisted, never
    // replayed on reconnect.
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

// ---------------------------------------------------------------------------
// Workflow engine schemas (Layer 4 v0)
// ---------------------------------------------------------------------------

/**
 * Workflow identifier format. Matches agent naming rules — letters, digits,
 * hyphens, underscores, must start with an alphanumeric. Kept intentionally
 * narrow so workflow ids can also be used as directory-safe names.
 */
const workflowId = z.string().regex(
  /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/,
  "Must start with a letter/number and contain only letters, numbers, hyphens, underscores",
);

/** Runtime run id as generated by the manager ("run_{unixMs}_{rand6}"). */
const workflowRunId = z.string().regex(
  /^run_\d+_[a-z0-9]{6}$/,
  "Expected run id format run_{unixMs}_{rand6}",
);

/** Gate id as generated by the manager ("gate_{unixMs}_{rand6}"). */
const workflowGateId = z.string().regex(
  /^gate_\d+_[a-z0-9]{6}$/,
  "Expected gate id format gate_{unixMs}_{rand6}",
);

/**
 * Program counter path into a (possibly nested) workflow definition.
 * Examples: "architecture", "dev-qa-loop/attempt:2/qa". Validation is
 * permissive — the runner enforces structural correctness internally.
 */
const stepKey = z.string().min(1).max(256);

/**
 * POST /workflows/start — begin a new workflow run. Called by an agent via
 * the `rondel_workflow_start` MCP tool; the originator fields are populated
 * by the MCP server from its env, not by the agent itself.
 */
export const WorkflowStartRequestSchema = z.object({
  workflow_id: workflowId,
  inputs: z.record(z.string(), z.string()).default({}),
  originator_agent: agentName,
  originator_channel_type: z.string().min(1),
  originator_account_id: z.string().min(1),
  originator_chat_id: z.string().min(1),
});
export type WorkflowStartRequestInput = z.infer<typeof WorkflowStartRequestSchema>;

/**
 * POST /workflows/step-complete — called by a step agent via the
 * `rondel_step_complete` MCP tool to signal the end of its assignment.
 */
export const StepCompleteRequestSchema = z.object({
  run_id: workflowRunId,
  step_key: stepKey,
  status: z.enum(["ok", "fail"]),
  summary: z.string().min(1).max(500),
  artifact: z.string().max(256).optional(),
  fail_reason: z.string().max(1000).optional(),
});
export type StepCompleteRequestInput = z.infer<typeof StepCompleteRequestSchema>;

/**
 * POST /workflows/gates/:id/resolve — called by the gate-channel agent via
 * the `rondel_resolve_gate` MCP tool once the human has decided.
 */
export const ResolveGateRequestSchema = z.object({
  run_id: workflowRunId,
  decision: z.enum(["approved", "denied"]),
  decided_by: z.string().min(1).max(200),        // "{channelType}:{accountId}"
  note: z.string().max(1000).optional(),
});
export type ResolveGateRequestInput = z.infer<typeof ResolveGateRequestSchema>;

/** GET /workflows?status=&limit= — list recent runs. */
export const ListWorkflowsQuerySchema = z.object({
  status: z.enum(["pending", "running", "waiting-gate", "completed", "failed", "interrupted", "all"]).optional(),
  limit: z.number().int().min(1).max(200).optional(),
});
export type ListWorkflowsQuery = z.infer<typeof ListWorkflowsQuerySchema>;

// ---- Wire shapes (what the bridge returns) ----
//
// These mirror the runtime types in shared/types/workflows.ts as Zod
// schemas so the @rondel/web package (which never imports daemon source)
// can derive the wire types via z.infer without drift.

const workflowStepKindSchema = z.enum(["agent", "gate", "retry"]);

const workflowInputSpecSchema = z.object({
  kind: z.enum(["artifact", "string"]),
  required: z.boolean().optional(),
  description: z.string().optional(),
});

const agentStepSchema = z.object({
  id: z.string().min(1),
  kind: z.literal("agent"),
  when: z.enum(["always", "on-retry"]).optional(),
  agent: agentName,
  task: z.string().min(1),
  inputs: z.array(z.string()).optional(),
  output: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
  role: z.string().optional(),
  workingSubdir: z.string().optional(),
});

const gateStepSchema = z.object({
  id: z.string().min(1),
  kind: z.literal("gate"),
  when: z.enum(["always", "on-retry"]).optional(),
  prompt: z.string().min(1),
  inputs: z.array(z.string()).optional(),
  timeoutMs: z.number().int().positive().optional(),
  to: z.object({
    channelType: z.string(),
    accountId: z.string(),
    chatId: z.string(),
  }).optional(),
});

/**
 * Recursive step schema. Retry steps contain other steps (including nested
 * retries). Expressed via z.lazy so the union can reference itself.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const stepSchema: z.ZodType<any> = z.lazy(() => z.discriminatedUnion("kind", [
  agentStepSchema,
  gateStepSchema,
  retryStepSchema,
]));

const retryStepSchema = z.object({
  id: z.string().min(1),
  kind: z.literal("retry"),
  when: z.enum(["always", "on-retry"]).optional(),
  body: z.array(stepSchema).min(1),
  maxAttempts: z.number().int().min(1).max(20),
  succeedsWhen: z.object({
    stepId: z.string().min(1),
    statusIs: z.literal("ok"),
  }),
});

/** Full workflow definition schema. Used by the loader at disk boundary. */
export const WorkflowDefinitionSchema = z.object({
  id: workflowId,
  version: z.number().int().min(1),
  description: z.string().optional(),
  inputs: z.record(z.string(), workflowInputSpecSchema).default({}),
  steps: z.array(stepSchema).min(1),
});
export type WorkflowDefinitionWire = z.infer<typeof WorkflowDefinitionSchema>;

const workflowOriginatorSchema = z.object({
  agent: agentName,
  channelType: z.string(),
  accountId: z.string(),
  chatId: z.string(),
});

const stepRunStateSchema = z.object({
  stepKey: stepKey,
  stepId: z.string(),
  kind: workflowStepKindSchema,
  status: z.enum(["pending", "running", "completed", "failed", "skipped"]),
  attempt: z.number().int().min(1),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  outputArtifact: z.string().nullable(),
  summary: z.string().nullable(),
  failReason: z.string().nullable(),
  subagentId: z.string().nullable(),
  gateId: z.string().nullable(),
});

export const WorkflowRunStateSchema = z.object({
  runId: workflowRunId,
  workflowId: workflowId,
  workflowVersion: z.number().int().min(1),
  status: z.enum(["pending", "running", "waiting-gate", "completed", "failed", "interrupted"]),
  startedAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().nullable(),
  originator: workflowOriginatorSchema,
  inputs: z.record(z.string(), z.string()),
  currentStepKey: z.string().nullable(),
  stepStates: z.record(z.string(), stepRunStateSchema),
  failReason: z.string().nullable(),
  parentRunId: z.string().optional(),
});
export type WorkflowRunStateWire = z.infer<typeof WorkflowRunStateSchema>;

export const GateRecordSchema = z.object({
  gateId: workflowGateId,
  runId: workflowRunId,
  stepKey: stepKey,
  status: z.enum(["pending", "resolved"]),
  prompt: z.string(),
  inputArtifacts: z.array(z.string()),
  notifiedAgent: agentName,
  notifiedChannelType: z.string(),
  notifiedChatId: z.string(),
  createdAt: z.string(),
  resolvedAt: z.string().nullable(),
  decision: z.enum(["approved", "denied"]).nullable(),
  note: z.string().nullable(),
  decidedBy: z.string().nullable(),
});
export type GateRecordWire = z.infer<typeof GateRecordSchema>;

// ---------------------------------------------------------------------------
// Validation helper
// ---------------------------------------------------------------------------

/**
 * Parse a request body against a schema.
 * Returns { success: true, data } or { success: false, error } with
 * a formatted error message suitable for HTTP 400 responses.
 */
export function validateBody<T>(schema: z.ZodType<T>, body: unknown): { success: true; data: T } | { success: false; error: string } {
  const result = schema.safeParse(body);
  if (result.success) {
    return { success: true, data: result.data };
  }

  // Format Zod issues into a human-readable string
  const issues = result.error.issues.map((issue) => {
    const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
    return `${path}${issue.message}`;
  });

  return { success: false, error: issues.join("; ") };
}
