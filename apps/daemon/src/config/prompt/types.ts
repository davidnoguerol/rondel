/**
 * Shared types for the prompt-assembly module.
 *
 * The assembled system prompt is built from pure section functions plus
 * file-backed inputs (bootstrap files, shared CONTEXT.md). See
 * `apps/daemon/src/config/prompt/assemble.ts` for the pipeline and
 * `docs/research/context-loading-*.md` for the design rationale.
 */

import type { CronJob } from "../../shared/types/index.js";
import type { ResolvedDelivery } from "./cron-preamble.js";

/**
 * Which prompt shape to build.
 *
 * - `main` — a user-facing conversation: full framework layer + all bootstrap files.
 * - `cron` — an ephemeral one-shot spawn with a cron preamble prepended above
 *   everything. Ephemeral strips MEMORY/USER/BOOTSTRAP bootstrap files and the
 *   persistent-only framework sections (Memory, Admin Tool Guidance, CLI Quick
 *   Reference).
 * - `agent-mail` — same as `main` plus the AGENT-MAIL.md block appended below
 *   everything, for inter-agent conversations.
 *
 * There is no bare `"subagent"` mode. `rondel_spawn_subagent` callers
 * always supply their own `system_prompt` inline — reusable role prompts
 * live in skills, not in a separate filesystem convention. Subagents
 * therefore bypass `buildPrompt` entirely and receive only the caller's
 * text plus Claude CLI's defaults, mirroring how OpenClaw's
 * `buildSubagentSystemPrompt` is kept completely separate from their
 * agent builder.
 */
export type PromptMode = "main" | "cron" | "agent-mail";

/**
 * Whether this mode strips ephemeral-only pieces: MEMORY/USER/BOOTSTRAP
 * bootstrap files, plus the persistent-only framework sections
 * (Memory, Admin Tool Guidance, CLI Quick Reference).
 *
 * Kept on this file (not in assemble.ts) so adding a new mode forces
 * the author to think about ephemerality here, at the type, instead of
 * having to remember a separate predicate in a sibling file.
 */
export function isEphemeralMode(mode: PromptMode): boolean {
  return mode === "cron";
}

/**
 * Everything the assembler needs to produce the final system prompt string.
 *
 * Populate via `loadPromptInputs` (reads disk) or construct directly in tests.
 * The assembler itself is pure — no I/O once it has this struct.
 */
export interface PromptInputs {
  readonly mode: PromptMode;
  readonly agent: PromptAgentInfo;
  readonly timezone: string | null;
  readonly bootstrap: PromptBootstrapFiles;
  readonly sharedContext: PromptSharedContext;
  /**
   * Contents of `templates/framework-context/TOOLS.md`. Optional to keep
   * `buildPrompt` pure; `loadPromptInputs` populates it from disk.
   */
  readonly toolInvariants?: string;
  /** Only present when `mode === "cron"`. */
  readonly cron?: PromptCronContext;
  /** Only present when `mode === "agent-mail"`. */
  readonly agentMail?: PromptAgentMailContext;
}

/**
 * Agent-level facts injected into several framework sections (Workspace,
 * Runtime, Admin Tool Guidance). All values are validated elsewhere — the
 * assembler trusts them.
 */
export interface PromptAgentInfo {
  readonly name: string;
  readonly agentDir: string;
  readonly workingDirectory: string | null;
  readonly orgName: string | null;
  readonly model: string;
  readonly channelType: string | null;
  readonly isAdmin: boolean;
}

/**
 * Contents of the user-owned bootstrap files read from the agent's directory
 * (with USER.md resolved via the agent → org → global fallback chain).
 *
 * Each field is undefined when the file is missing or empty. The assembler
 * skips missing sections without emitting a placeholder.
 */
export interface PromptBootstrapFiles {
  readonly agent?: string;
  readonly soul?: string;
  readonly identity?: string;
  readonly user?: string;
  readonly memory?: string;
  readonly bootstrapRitual?: string;
}

/**
 * Cross-agent shared context blocks. Both optional.
 */
export interface PromptSharedContext {
  readonly global?: string;
  readonly org?: string;
}

/** Inputs specific to cron mode. */
export interface PromptCronContext {
  readonly job: CronJob;
  readonly delivery: ResolvedDelivery | null;
}

/** Inputs specific to agent-mail mode. */
export interface PromptAgentMailContext {
  /** Contents of `templates/context/AGENT-MAIL.md`. */
  readonly appendedBlock: string;
}
