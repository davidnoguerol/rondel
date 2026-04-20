/**
 * Public API for the prompt-assembly module.
 *
 * Replaces the legacy `context-assembler.ts`. Two entry points:
 *
 * - `buildPrompt(inputs)` — pure function, no I/O. Takes a fully-populated
 *   `PromptInputs` and returns the assembled system-prompt string.
 * - `loadPromptInputs(args)` — reads disk (bootstrap files, shared CONTEXT.md,
 *   agent-mail template, cron preamble context) and returns the struct
 *   `buildPrompt` expects.
 *
 * Call sites live in `agents/agent-manager.ts` (main, agent-mail) and
 * `scheduling/cron-runner.ts` (cron). See
 * `docs/research/context-loading-*.md` for the section layout.
 */

export { buildPrompt, loadPromptInputs, loadMainAndAgentMailPrompts } from "./assemble.js";
export { isEphemeralMode } from "./types.js";
export type {
  PromptMode,
  PromptInputs,
  PromptAgentInfo,
  PromptBootstrapFiles,
  PromptSharedContext,
  PromptCronContext,
  PromptAgentMailContext,
} from "./types.js";
