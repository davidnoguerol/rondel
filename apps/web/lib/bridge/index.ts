/**
 * Client-safe public surface of the bridge module.
 *
 * =============================================================================
 * IMPORTANT — KEEP THIS BARREL CLIENT-SAFE
 * =============================================================================
 *
 * This barrel must NEVER re-export anything from a file that contains
 * `import "server-only"` at the top, even transitively. Server-only files
 * are: `client.ts`, `discovery.ts`, `fetcher.ts`. If a Client Component
 * imports from `@/lib/bridge`, the bundler will follow every export here.
 * One non-client-safe re-export and the entire client bundle errors out
 * with "You're importing a component that needs server-only".
 *
 * Files that ARE safe to re-export from here:
 *   - `errors.ts`  — pure Error subclasses, no runtime dependencies
 *   - `schemas.ts` — Zod schemas + inferred types, no Node-only deps
 *
 * Server Components and the route handler import the typed client
 * DIRECTLY from `@/lib/bridge/client` — that's the load-bearing
 * "use the right entrypoint" rule.
 */

export {
  BridgeError,
  BridgeSchemaError,
  BridgeVersionMismatchError,
  RondelNotRunningError,
} from "./errors";

export type {
  AgentState,
  AgentStateEntry,
  AgentStateFrame,
  AgentSummary,
  ApprovalDecision,
  ApprovalListResponse,
  ApprovalReason,
  ApprovalRecord,
  ApprovalStreamFrame,
  ConversationSummary,
  ConversationsResponse,
  ConversationHistoryResponse,
  ConversationTurn,
  ConversationStreamFrame,
  ConversationStreamFrameData,
  LedgerEvent,
  LedgerEventKind,
  LedgerQueryResponse,
  LedgerStreamFrame,
  ListAgentsResponse,
  MemoryResponse,
  ScheduleCreateInput,
  ScheduleDelivery,
  ScheduleKind,
  ScheduleListResponse,
  ScheduleSessionTarget,
  ScheduleSource,
  ScheduleStatus,
  ScheduleStreamFrame,
  ScheduleSummary,
  ScheduleUpdateInput,
  TaskAuditEntry,
  TaskAuditEvent,
  TaskListResponse,
  TaskOutput,
  TaskPriority,
  TaskReadResponse,
  TaskRecord,
  TaskStatus,
  TaskStreamFrame,
  ToolUseApprovalRecord,
  VersionResponse,
  WebSendResponse,
} from "./schemas";

// Schema VALUES for stream consumers — Client Components need the
// Zod parsers inside React hooks. These are pure runtime values from
// schemas.ts (no server-only marker), so re-exporting them from this
// barrel is safe.
export {
  AgentStateFrameSchema,
  ApprovalStreamFrameSchema,
  ConversationStreamFrameSchema,
  LedgerStreamFrameSchema,
  ScheduleCreateInputSchema,
  ScheduleDeliverySchema,
  ScheduleKindSchema,
  ScheduleSessionTargetSchema,
  ScheduleStreamFrameSchema,
  ScheduleSummarySchema,
  ScheduleUpdateInputSchema,
  TaskStreamFrameSchema,
  WEB_MAIN_CHAT_ID,
} from "./schemas";
