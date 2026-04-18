/**
 * Approvals module barrel.
 *
 * See ./approval-service.ts for the main entry point. First-class Rondel
 * tools under apps/daemon/src/tools/ call the service over HTTP via
 * POST /approvals/tool-use; there is no external PreToolUse hook anymore.
 */

export type {
  ApprovalDecision,
  ApprovalReason,
  ApprovalRecord,
  ApprovalStatus,
  ToolUseApprovalRecord,
  ToolUseApprovalRequest,
} from "./types.js";

export { ApprovalService, type ApprovalServiceDeps, type ResolveAccountId } from "./approval-service.js";
export type { ApprovalPaths } from "./approval-store.js";
export { summarizeToolUse } from "./tool-summary.js";
