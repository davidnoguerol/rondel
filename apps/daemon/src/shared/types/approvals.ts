/**
 * HITL (Human-In-The-Loop) approval types.
 *
 * Rondel agents run headless and their Claude CLI processes have nowhere
 * to surface a tool-use permission prompt. The approval module bridges
 * that gap: a PreToolUse hook asks the service for a decision, the
 * service routes the request to the active conversation (Telegram
 * inline buttons + web UI), and returns allow/deny.
 *
 * Only one record shape exists — the Tier 1 safety net. The hook
 * escalates a dangerous tool call (destructive Bash, writes outside
 * safe zones) to a human. Decision is allow/deny. Most tool calls
 * never get here — the hook auto-allows 99% of them locally.
 *
 * Pure types — no runtime imports.
 */

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

export type ApprovalStatus = "pending" | "resolved";

export type ApprovalDecision = "allow" | "deny";

/**
 * Why the hook escalated a tool-use call to a human.
 *
 * Re-exported from the canonical source in `../safety/` so the hook
 * bundle and the daemon share exactly one string union. See
 * `shared/safety/types.ts` for the full set and what each value means.
 */
export type { EscalationReason as ApprovalReason } from "../safety/index.js";

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

import type { EscalationReason } from "../safety/index.js";

export interface ToolUseApprovalRecord {
  readonly requestId: string;
  readonly status: ApprovalStatus;
  readonly agentName: string;
  readonly channelType?: string;
  readonly chatId?: string;
  readonly toolName: string;
  readonly toolInput: unknown;
  readonly summary: string;
  readonly reason: EscalationReason;
  readonly createdAt: string;
  readonly resolvedAt?: string;
  readonly resolvedBy?: string;
  readonly decision?: ApprovalDecision;
}

export type ApprovalRecord = ToolUseApprovalRecord;

// ---------------------------------------------------------------------------
// Create-request shape (in-memory; bridge uses the zod-validated variant)
// ---------------------------------------------------------------------------

/**
 * Parameters passed from the hook script (via the bridge) into
 * `ApprovalService.requestToolUse()`. The hook never constructs an
 * `ApprovalRecord` directly — the service assigns the id, timestamps,
 * and status.
 */
export interface ToolUseApprovalRequest {
  readonly agentName: string;
  readonly channelType?: string;
  readonly chatId?: string;
  readonly toolName: string;
  readonly toolInput?: unknown;
  readonly reason: EscalationReason;
}
