/**
 * Tool-use classification types.
 *
 * Pure type definitions — no runtime imports. Kept dependency-free so the
 * module can be bundled into the PreToolUse hook's `.mjs` script without
 * pulling in any framework state.
 */

export type Classification = "allow" | "escalate" | "deny";

/**
 * Why the PreToolUse hook escalates a tool-use call to a human.
 *
 *  - `dangerous_bash`             — destructive shell pattern (rm -rf /, dd, mkfs, curl|sh, …)
 *  - `write_outside_safezone`     — Write/Edit/MultiEdit targeting a path outside safe zones
 *  - `bash_system_write`          — shell redirection into /etc, /usr, /bin, /sbin, /System, /Library
 *  - `potential_secret_in_content`— content contains what looks like a leaked credential
 *  - `write_without_read`         — rondel_write_file overwriting an existing file that was
 *                                    never read in the current session, or whose on-disk
 *                                    content has drifted since the recorded read hash
 *  - `unknown_tool`               — hook saw a tool name it didn't recognise
 *  - `agent_initiated`            — reserved for agent-initiated (Tier 3) approvals
 *  - `external_action`            — task board: completing a task with `externalAction: true`
 *                                    routes through approvals before the status transition
 */
export type EscalationReason =
  | "dangerous_bash"
  | "write_outside_safezone"
  | "bash_system_write"
  | "potential_secret_in_content"
  | "write_without_read"
  | "unknown_tool"
  | "agent_initiated"
  | "external_action";

export interface ClassificationResult {
  readonly classification: Classification;
  readonly reason?: EscalationReason;
  readonly details?: string;
}
