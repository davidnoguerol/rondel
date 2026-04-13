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

const AgentStateSchema = z.enum([
  "starting",
  "idle",
  "busy",
  "crashed",
  "halted",
  "stopped",
]);

const ConversationSummarySchema = z.object({
  chatId: z.string(),
  state: AgentStateSchema,
  sessionId: z.string().nullable(),
});

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
]);

export const LedgerEventSchema = z.object({
  ts: z.string(),
  agent: z.string(),
  kind: LedgerEventKindSchema,
  chatId: z.string().optional(),
  summary: z.string(),
  detail: z.unknown().optional(),
});
export type LedgerEvent = z.infer<typeof LedgerEventSchema>;

export const LedgerQueryResponseSchema = z.object({
  events: z.array(LedgerEventSchema),
});
export type LedgerQueryResponse = z.infer<typeof LedgerQueryResponseSchema>;
