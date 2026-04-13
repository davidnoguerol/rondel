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
 */
export const BRIDGE_API_VERSION = 3 as const;

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
