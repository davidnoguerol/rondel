/**
 * Re-export all approval types from the canonical location in shared/types/.
 *
 * Internal approvals module files can import from `./types.js` for brevity.
 * External consumers should import from `../shared/types/index.js`.
 */
export type {
  ApprovalStatus,
  ApprovalDecision,
  ApprovalReason,
  ApprovalRecord,
  ToolUseApprovalRecord,
  ToolUseApprovalRequest,
} from "../shared/types/approvals.js";
