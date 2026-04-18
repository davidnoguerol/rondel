/**
 * Zod schemas for bridge admin endpoint validation.
 *
 * Validates request bodies at the HTTP boundary before they reach
 * AdminApi business logic. Replaces manual property checks with
 * structured validation that produces clear error messages.
 */

import { z } from "zod";
import { isAbsolute } from "node:path";
import { Cron } from "croner";

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
 *   5 — HITL approvals (Tier 1): POST /approvals/tool-use, GET
 *       /approvals/:id, GET /approvals, POST /approvals/:id/resolve.
 *       New ledger kinds approval_request/approval_decision.
 *   6 — HITL approvals (Tier 2 — AskUserQuestion proxy): POST
 *       /approvals/ask-user-question. ApprovalRecord gained a `kind`
 *       discriminator (tool_use | question).
 *   7 — Tier 2 (AskUserQuestion proxy) removed. Approval records no
 *       longer have a kind discriminator; only tool_use exists. The
 *       /approvals/ask-user-question endpoint is gone.
 *   8 — ApprovalReason enum: removed `unsupported_tty_tool` (dead —
 *       the corresponding classifier branch was for tools that are
 *       already in FRAMEWORK_DISALLOWED_TOOLS and never reach the
 *       hook). Added `potential_secret_in_content` (Phase 3 prep for
 *       the filesystem tool suite).
 *   9 — tool_call ledger event, POST /ledger/tool-call endpoint
 *       (bridge → hook → LedgerWriter), first-class rondel_bash tool
 *       (MCP).
 *  10 — Filesystem tool suite: ReadFileStateStore + FileHistoryStore;
 *       endpoints POST /filesystem/read-state/{agent},
 *       GET /filesystem/read-state/{agent}?sessionId=X&path=Y,
 *       POST /filesystem/history/{agent}/backup,
 *       GET /filesystem/history/{agent},
 *       GET /filesystem/history/{agent}/{backupId};
 *       MCP tools rondel_read_file, rondel_write_file (reimplemented
 *       inside apps/daemon/src/tools/), rondel_edit_file, rondel_multi_edit_file.
 *       Inline rondel_write_file in mcp-server.ts removed.
 *       ApprovalReason enum gained `write_without_read`.
 *  11 — Native Bash/Write/Edit/MultiEdit added to FRAMEWORK_DISALLOWED_TOOLS.
 *       PreToolUse hook reduced to transitional deny-and-explain
 *       redirector (no classification, no bridge calls). All file and
 *       shell operations now route through the rondel_* MCP tools —
 *       safety classifier and approval routing live per-tool in
 *       apps/daemon/src/tools/, not in the hook.
 *  12 — Transitional PreToolUse hook removed. state/agent-runtime/ no
 *       longer created. Added GET /approvals/tail (SSE), POST
 *       /prompts/ask-user, GET /prompts/ask-user/:id. New rondel_ask_user
 *       MCP tool. AgentConfig.permissionMode removed.
 *  13 — Runtime scheduling: GET /schedules, POST /schedules, GET
 *       /schedules/:id, PATCH /schedules/:id, DELETE /schedules/:id,
 *       POST /schedules/:id/run. New rondel_schedule_{create,list,
 *       update,delete,run} MCP tools. CronSchedule extended with
 *       `at` + `cron` kinds (was `every` only). CronDelivery.announce
 *       gained optional channelType / accountId. CronJob gained
 *       optional deleteAfterRun / source / owner / createdAtMs.
 *       CronCreate / CronDelete / CronList added to
 *       FRAMEWORK_DISALLOWED_TOOLS. New ledger kinds
 *       schedule_created / schedule_updated / schedule_deleted.
 */
export const BRIDGE_API_VERSION = 13 as const;

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
// Conversation lifecycle schemas
// ---------------------------------------------------------------------------

/**
 * POST /agent/schedule-skill-reload — scheduled by `rondel_reload_skills` when
 * an agent authors or edits a skill at runtime. The bridge sets a flag that
 * the Router consumes on the next idle transition; the restart happens
 * between turns so the calling turn itself isn't killed mid-flight.
 */
export const ScheduleSkillReloadSchema = z.object({
  agent_name: agentName,
  channel_type: z.string().min(1),
  chat_id: z.string().min(1),
});
export type ScheduleSkillReloadInput = z.infer<typeof ScheduleSkillReloadSchema>;

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
// Approval schemas (HITL)
// ---------------------------------------------------------------------------

/**
 * Reasons the PreToolUse hook escalates a tool-use call to a human.
 *
 * Must stay in sync with `EscalationReason` in
 * `apps/daemon/src/shared/safety/types.ts` — the safety module is the
 * canonical source; this enum only exists to validate incoming HTTP
 * bodies at the bridge boundary.
 */
export const ApprovalReasonSchema = z.enum([
  "dangerous_bash",
  "write_outside_safezone",
  "bash_system_write",
  "potential_secret_in_content",
  "write_without_read",
  "unknown_tool",
  "agent_initiated",
]);
export type ApprovalReasonInput = z.infer<typeof ApprovalReasonSchema>;

/** POST /approvals/tool-use — body posted by the hook script. */
export const ToolUseApprovalCreateSchema = z.object({
  agentName: agentName,
  channelType: z.string().min(1).optional(),
  chatId: z.string().min(1).optional(),
  toolName: z.string().min(1),
  toolInput: z.unknown().optional(),
  reason: ApprovalReasonSchema,
});
export type ToolUseApprovalCreateInput = z.infer<typeof ToolUseApprovalCreateSchema>;

/** POST /approvals/:id/resolve — body posted by the web UI. */
export const ApprovalResolveSchema = z.object({
  decision: z.enum(["allow", "deny"]),
  resolvedBy: z.string().min(1).optional(),
});
export type ApprovalResolveInput = z.infer<typeof ApprovalResolveSchema>;

/**
 * Full approval record — response shape for GET /approvals/:id.
 *
 * Only one record shape exists: the Tier 1 tool-use safety net.
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
  decision: z.enum(["allow", "deny"]).optional(),
  resolvedBy: z.string().optional(),
});

/**
 * Kept for API-consumer clarity — after the Tier 2 removal there is only
 * one record shape, so this is a direct alias of `ToolUseApprovalRecordSchema`.
 */
export const ApprovalRecordSchema = ToolUseApprovalRecordSchema;
export type ApprovalRecordResponse = z.infer<typeof ApprovalRecordSchema>;

/** Response shape for GET /approvals (list) */
export const ApprovalListResponseSchema = z.object({
  pending: z.array(ApprovalRecordSchema),
  resolved: z.array(ApprovalRecordSchema),
});
export type ApprovalListResponse = z.infer<typeof ApprovalListResponseSchema>;

// ---------------------------------------------------------------------------
// First-class tool events (rondel_bash, Phase 3 filesystem suite)
// ---------------------------------------------------------------------------

/**
 * POST /ledger/tool-call — body posted by MCP tools in the per-agent
 * MCP server process when a first-class Rondel tool finishes execution.
 *
 * The bridge validates, emits the `tool:call` hook event, and
 * LedgerWriter appends a `tool_call` ledger event. Fire-and-forget
 * from the tool's perspective — a failing ledger POST never causes
 * the tool itself to fail.
 */
export const ToolCallEventSchema = z.object({
  agentName: agentName,
  channelType: z.string().min(1),
  chatId: z.string().min(1),
  toolName: z.string().min(1),
  toolInput: z.unknown(),
  summary: z.string(),
  outcome: z.enum(["success", "error"]),
  durationMs: z.number().int().nonnegative(),
  exitCode: z.number().int().optional(),
  error: z.string().optional(),
});
export type ToolCallEventInput = z.infer<typeof ToolCallEventSchema>;

// ---------------------------------------------------------------------------
// Filesystem tool suite (Phase 3)
// ---------------------------------------------------------------------------

const absolutePath = z
  .string()
  .min(1, "Path must not be empty")
  .refine((p) => isAbsolute(p), "Must be an absolute path");

/**
 * POST /filesystem/read-state/{agent} — called by rondel_read_file after a
 * successful read so subsequent writes/edits can check staleness.
 */
export const RecordReadSchema = z.object({
  sessionId: z.string().min(1),
  path: absolutePath,
  contentHash: z.string().regex(/^[a-f0-9]{64}$/, "Expected sha256 hex digest"),
});
export type RecordReadInput = z.infer<typeof RecordReadSchema>;

/**
 * POST /filesystem/history/{agent}/backup — called by rondel_write_file /
 * rondel_edit_file / rondel_multi_edit_file before overwriting an existing
 * file. The bridge writes the pre-image via FileHistoryStore.backup and
 * returns the backup id.
 */
export const BackupCreateSchema = z.object({
  originalPath: absolutePath,
  content: z.string(),
});
export type BackupCreateInput = z.infer<typeof BackupCreateSchema>;

/**
 * Input schemas for the four first-class filesystem MCP tools.
 * Exported so the MCP tool implementations and any future bridge-side
 * pre-validation share one source of truth.
 */
export const ReadFileInputSchema = z.object({
  path: absolutePath,
  max_bytes: z.number().int().min(1).max(10_485_760).optional(),
});
export type ReadFileInput = z.infer<typeof ReadFileInputSchema>;

export const WriteFileInputSchema = z.object({
  path: absolutePath,
  content: z.string(),
});
export type WriteFileInput = z.infer<typeof WriteFileInputSchema>;

export const EditFileInputSchema = z.object({
  path: absolutePath,
  old_string: z.string().min(1, "old_string must be non-empty"),
  new_string: z.string(),
  replace_all: z.boolean().optional(),
});
export type EditFileInput = z.infer<typeof EditFileInputSchema>;

export const MultiEditFileInputSchema = z.object({
  path: absolutePath,
  edits: z
    .array(
      z.object({
        old_string: z.string().min(1),
        new_string: z.string(),
        replace_all: z.boolean().optional(),
      }),
    )
    .min(1, "At least one edit is required"),
});
export type MultiEditFileInput = z.infer<typeof MultiEditFileInputSchema>;

// ---------------------------------------------------------------------------
// Ask-user prompts (rondel_ask_user)
// ---------------------------------------------------------------------------

/**
 * One option in an ask-user prompt. `description` is optional prose the
 * UI may render as a tooltip or subtitle — button labels still come from
 * `label` (truncated by the adapter if needed).
 */
export const AskUserOptionSchema = z.object({
  label: z.string().min(1, "option.label must be non-empty").max(200),
  description: z.string().max(500).optional(),
});
export type AskUserOption = z.infer<typeof AskUserOptionSchema>;

const ASK_USER_DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const ASK_USER_MIN_TIMEOUT_MS = 5_000;
const ASK_USER_MAX_TIMEOUT_MS = 30 * 60 * 1000;

/** POST /prompts/ask-user — body posted by the rondel_ask_user MCP tool. */
export const AskUserCreateSchema = z.object({
  agentName: agentName,
  channelType: z.string().min(1),
  chatId: z.string().min(1),
  prompt: z.string().min(1).max(4000),
  options: z.array(AskUserOptionSchema).min(1).max(8),
  timeout_ms: z
    .number()
    .int()
    .min(ASK_USER_MIN_TIMEOUT_MS)
    .max(ASK_USER_MAX_TIMEOUT_MS)
    .optional(),
});
export type AskUserCreateInput = z.infer<typeof AskUserCreateSchema>;

export const ASK_USER_DEFAULTS = {
  defaultTimeoutMs: ASK_USER_DEFAULT_TIMEOUT_MS,
  minTimeoutMs: ASK_USER_MIN_TIMEOUT_MS,
  maxTimeoutMs: ASK_USER_MAX_TIMEOUT_MS,
} as const;

/**
 * GET /prompts/ask-user/:id response. Either pending or resolved; when
 * resolved, `selected_index` + `selected_label` identify the chosen
 * option. `status: "timeout"` is reported when the prompt expired
 * without any human interaction.
 */
export const AskUserResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("pending"),
  }),
  z.object({
    status: z.literal("resolved"),
    selected_index: z.number().int().min(0),
    selected_label: z.string(),
    resolvedBy: z.string().optional(),
  }),
  z.object({
    status: z.literal("timeout"),
  }),
]);
export type AskUserResult = z.infer<typeof AskUserResultSchema>;

// ---------------------------------------------------------------------------
// Runtime schedule schemas (durable crons created by agents via rondel_schedule_*)
// ---------------------------------------------------------------------------

const scheduleId = z.string().regex(
  /^sched_\d+_[a-f0-9]+$/,
  "Expected schedule id format (sched_<epoch>_<hex>)",
);

const intervalPattern = z.string().regex(
  /^\d+[dhms](?:\d+[dhms])*$/,
  'Expected interval like "30s", "5m", "1h", "2h30m"',
);

/** Strict ISO 8601 check — Zod's .datetime() rejects local timestamps which is what we want. */
const isoTimestamp = z.string().refine(
  (v) => !Number.isNaN(Date.parse(v)),
  "Expected ISO 8601 timestamp (e.g., 2026-04-19T08:00:00Z)",
);

/** `at` accepts either ISO 8601 or a relative offset like "20m". */
const atValue = z
  .string()
  .min(1)
  .refine(
    (v) => /^\d+[dhms](?:\d+[dhms])*$/.test(v) || !Number.isNaN(Date.parse(v)),
    'Expected ISO 8601 timestamp or a relative offset like "20m"',
  );

/**
 * Full discriminated union for schedule kinds. Cron expressions and
 * timezones are validated by actually constructing a croner instance —
 * it throws synchronously on malformed expressions and unknown IANA
 * zones, so a passing parse here means the scheduler can run it.
 */
export const ScheduleKindSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("every"),
    interval: intervalPattern,
  }),
  z.object({
    kind: z.literal("at"),
    at: atValue,
  }),
  z
    .object({
      kind: z.literal("cron"),
      expression: z.string().min(1),
      timezone: z.string().optional(),
    })
    .refine(
      ({ expression, timezone }) => {
        try {
          new Cron(expression, { timezone, paused: true });
          return true;
        } catch {
          return false;
        }
      },
      {
        message:
          'Invalid cron expression or timezone (expected a standard 5-field cron, e.g., "0 8 * * *", optional IANA timezone like "America/Sao_Paulo")',
      },
    ),
]);
export type ScheduleKindInput = z.infer<typeof ScheduleKindSchema>;

const deliverySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("none") }),
  z.object({
    mode: z.literal("announce"),
    chatId: z.string().min(1),
    channelType: z.string().min(1).optional(),
    accountId: z.string().min(1).optional(),
  }),
]);

const sessionTargetSchema = z.union([
  z.literal("isolated"),
  z.string().regex(/^session:[A-Za-z0-9_-]+$/, 'Expected "isolated" or "session:<name>"'),
]);

/** POST /schedules — create a new runtime schedule. */
export const ScheduleCreateSchema = z.object({
  name: z.string().min(1, "name must be non-empty").max(200),
  schedule: ScheduleKindSchema,
  prompt: z.string().min(1, "prompt must be non-empty"),
  delivery: deliverySchema.optional(),
  sessionTarget: sessionTargetSchema.optional(),
  model: z.string().min(1).optional(),
  timeoutMs: z.number().int().positive().max(2 * 60 * 60 * 1000).optional(),
  deleteAfterRun: z.boolean().optional(),
  enabled: z.boolean().optional(),
  /** Optional target agent. Admin-only. */
  targetAgent: agentName.optional(),
});
export type ScheduleCreateInput = z.infer<typeof ScheduleCreateSchema>;

/** PATCH /schedules/:id — update an existing runtime schedule. */
export const ScheduleUpdateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  schedule: ScheduleKindSchema.optional(),
  prompt: z.string().min(1).optional(),
  delivery: deliverySchema.optional(),
  sessionTarget: sessionTargetSchema.optional(),
  model: z.string().min(1).nullable().optional(),
  timeoutMs: z.number().int().positive().max(2 * 60 * 60 * 1000).optional(),
  deleteAfterRun: z.boolean().optional(),
  enabled: z.boolean().optional(),
});
export type ScheduleUpdateInput = z.infer<typeof ScheduleUpdateSchema>;

export { scheduleId as ScheduleIdSchema, isoTimestamp as IsoTimestampSchema };

/**
 * Caller identity + chat context forwarded from the MCP server on every
 * schedule call. Populated from the per-conversation env vars
 * (RONDEL_PARENT_AGENT etc) so the bridge can enforce self-vs-admin and
 * default delivery without trusting body-supplied identity.
 */
export const ScheduleCallerSchema = z.object({
  agentName: agentName,
  isAdmin: z.boolean().optional(),
  channelType: z.string().min(1).optional(),
  accountId: z.string().min(1).optional(),
  chatId: z.string().min(1).optional(),
});
export type ScheduleCallerInput = z.infer<typeof ScheduleCallerSchema>;

/** POST /schedules body (union of caller + create input). */
export const ScheduleCreateRequestSchema = z.object({
  caller: ScheduleCallerSchema,
  input: ScheduleCreateSchema,
});
export type ScheduleCreateRequest = z.infer<typeof ScheduleCreateRequestSchema>;

/** PATCH /schedules/:id body. */
export const ScheduleUpdateRequestSchema = z.object({
  caller: ScheduleCallerSchema,
  patch: ScheduleUpdateSchema,
});
export type ScheduleUpdateRequest = z.infer<typeof ScheduleUpdateRequestSchema>;

/** DELETE /schedules/:id and POST /schedules/:id/run body. */
export const ScheduleMutationRequestSchema = z.object({
  caller: ScheduleCallerSchema,
});
export type ScheduleMutationRequest = z.infer<typeof ScheduleMutationRequestSchema>;

/** Query params for GET /schedules. */
export const ScheduleListQuerySchema = z.object({
  callerAgent: agentName,
  isAdmin: z.boolean().optional(),
  callerChannelType: z.string().min(1).optional(),
  callerAccountId: z.string().min(1).optional(),
  callerChatId: z.string().min(1).optional(),
  targetAgent: agentName.optional(),
  includeDisabled: z.boolean().optional(),
});
export type ScheduleListQuery = z.infer<typeof ScheduleListQuerySchema>;

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
