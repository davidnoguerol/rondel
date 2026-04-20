/**
 * Prompt assembly pipeline.
 *
 * `buildPrompt` is a pure function: given a fully-populated `PromptInputs`
 * it returns the exact string to pass as `--system-prompt`. No I/O, no
 * logging, no hidden state — making it trivially unit-testable.
 *
 * `loadPromptInputs` is the I/O side: reads bootstrap files, shared
 * CONTEXT.md, tool invariants, and the agent-mail block from disk, then
 * calls `buildPrompt` with the populated struct.
 *
 * Separator between every top-level block is `\n\n`. The legacy
 * `\n\n---\n\n` horizontal-rule separator is removed — it was visual
 * clutter that also contributed to the double-H1 issue (bootstrap files
 * already start with their own `# ...` heading; wrapping them in another
 * `# FILENAME` heading produced two H1s in a row). Bootstrap files are
 * now injected as their trimmed content only.
 */

import type { Logger } from "../../shared/logger.js";
import type { AgentConfig, CronJob } from "../../shared/types/index.js";
import { loadAgentMailBlock } from "./agent-mail.js";
import { loadBootstrapFiles } from "./bootstrap.js";
import { buildCronPreamble, type ResolvedDelivery } from "./cron-preamble.js";
import { buildAdminToolGuidance } from "./sections/admin-tool-guidance.js";
import { buildCliQuickReference } from "./sections/cli-quick-reference.js";
import { buildCurrentDateTime } from "./sections/current-date-time.js";
import { buildExecutionBias } from "./sections/execution-bias.js";
import { buildIdentity } from "./sections/identity.js";
import { buildMemory } from "./sections/memory.js";
import { buildRuntime } from "./sections/runtime.js";
import { buildSafety } from "./sections/safety.js";
import { buildToolCallStyle } from "./sections/tool-call-style.js";
import { buildToolInvariants } from "./sections/tool-invariants.js";
import { buildWorkspace } from "./sections/workspace.js";
import { loadSharedContext } from "./shared-context.js";
import { isEphemeralMode, type PromptInputs, type PromptMode } from "./types.js";

/**
 * Build the final system-prompt string from fully-populated inputs.
 *
 * Sections that return `null` or empty string are dropped silently.
 * Blocks are joined with `\n\n` — a single blank line — nothing else.
 *
 * Block order (main mode, maximal form):
 *   Cron preamble (cron mode only)
 *   Identity
 *   Safety
 *   Tool Call Style
 *   Memory (persistent modes only)
 *   Execution Bias
 *   Tool Invariants (from framework-context/TOOLS.md)
 *   Admin Tool Guidance (admin + persistent only)
 *   CLI Quick Reference (persistent only)
 *   Current Date & Time (if timezone provided)
 *   Workspace
 *   Runtime
 *   Global CONTEXT.md (if present)
 *   Org shared CONTEXT.md (if present)
 *   AGENT.md body
 *   SOUL.md body
 *   IDENTITY.md body
 *   USER.md body (persistent only)
 *   MEMORY.md body (persistent only)
 *   BOOTSTRAP.md body (persistent only)
 *   Agent-mail append (agent-mail mode only)
 */
export function buildPrompt(inputs: PromptInputs): string {
  const ephemeral = isEphemeralMode(inputs.mode);
  const blocks: string[] = [];

  // Cron preamble goes ABOVE everything else.
  if (inputs.mode === "cron" && inputs.cron) {
    blocks.push(buildCronPreamble(inputs.cron.job, inputs.cron.delivery));
  }

  // Framework layer — fixed order, always emitted (modulo conditional skips).
  blocks.push(buildIdentity());
  blocks.push(buildSafety());
  blocks.push(buildToolCallStyle());

  const memory = buildMemory({ isEphemeral: ephemeral });
  if (memory) blocks.push(memory);

  blocks.push(buildExecutionBias());

  if (inputs.toolInvariants) blocks.push(inputs.toolInvariants);

  const admin = buildAdminToolGuidance({
    isAdmin: inputs.agent.isAdmin,
    isEphemeral: ephemeral,
  });
  if (admin) blocks.push(admin);

  const cli = buildCliQuickReference({ isEphemeral: ephemeral });
  if (cli) blocks.push(cli);

  const dateTime = buildCurrentDateTime({ timezone: inputs.timezone });
  if (dateTime) blocks.push(dateTime);

  blocks.push(
    buildWorkspace({
      agentDir: inputs.agent.agentDir,
      workingDirectory: inputs.agent.workingDirectory,
      isEphemeral: ephemeral,
    }),
  );

  blocks.push(
    buildRuntime({
      agentName: inputs.agent.name,
      orgName: inputs.agent.orgName,
      model: inputs.agent.model,
      channelType: inputs.agent.channelType,
      workingDirectory: inputs.agent.workingDirectory ?? inputs.agent.agentDir,
    }),
  );

  // Shared context (both ephemeral and persistent see these).
  if (inputs.sharedContext.global) blocks.push(inputs.sharedContext.global);
  if (inputs.sharedContext.org) blocks.push(inputs.sharedContext.org);

  // User-owned bootstrap files — emitted as raw content (no synthetic
  // heading prefix) because each file already opens with its own `# ...`
  // heading.
  const b = inputs.bootstrap;
  if (b.agent) blocks.push(b.agent);
  if (b.soul) blocks.push(b.soul);
  if (b.identity) blocks.push(b.identity);
  if (!ephemeral) {
    if (b.user) blocks.push(b.user);
    if (b.memory) blocks.push(b.memory);
    if (b.bootstrapRitual) blocks.push(b.bootstrapRitual);
  }

  // Agent-mail append goes BELOW everything else.
  if (inputs.mode === "agent-mail" && inputs.agentMail) {
    blocks.push(inputs.agentMail.appendedBlock);
  }

  return blocks.filter((x) => x.length > 0).join("\n\n");
}

// ---------------------------------------------------------------------------
// I/O entry point
// ---------------------------------------------------------------------------

export interface LoadPromptInputsArgs {
  readonly mode: PromptMode;
  readonly agentDir: string;
  readonly agentConfig: AgentConfig;
  readonly orgName?: string;
  readonly orgDir?: string;
  readonly globalContextDir?: string;
  readonly timezone?: string;
  readonly channelType?: string;
  readonly cronJob?: CronJob;
  readonly cronDelivery?: ResolvedDelivery | null;
  readonly log: Logger;
}

/**
 * Everything read from disk that is mode-independent. Shared across
 * `loadPromptInputs` and `loadMainAndAgentMailPrompts` so an agent-manager
 * spawn doesn't pay double disk I/O to produce two prompts.
 */
interface SharedLoadedInputs {
  readonly bootstrap: Awaited<ReturnType<typeof loadBootstrapFiles>>;
  readonly sharedContext: Awaited<ReturnType<typeof loadSharedContext>>;
  readonly toolInvariants: string | null;
}

async function loadSharedInputs(args: {
  agentDir: string;
  orgDir?: string;
  globalContextDir?: string;
  log: Logger;
}): Promise<SharedLoadedInputs> {
  const [bootstrap, sharedContext, toolInvariants] = await Promise.all([
    loadBootstrapFiles({
      agentDir: args.agentDir,
      orgDir: args.orgDir,
      globalContextDir: args.globalContextDir,
      log: args.log,
    }),
    loadSharedContext({
      orgDir: args.orgDir,
      globalContextDir: args.globalContextDir,
    }),
    buildToolInvariants(),
  ]);
  return { bootstrap, sharedContext, toolInvariants };
}

function buildInputsFromShared(
  args: Omit<LoadPromptInputsArgs, "log">,
  shared: SharedLoadedInputs,
  agentMailBlock: string | null,
): PromptInputs {
  return {
    mode: args.mode,
    agent: {
      name: args.agentConfig.agentName,
      agentDir: args.agentDir,
      workingDirectory: args.agentConfig.workingDirectory,
      orgName: args.orgName ?? null,
      model: args.agentConfig.model,
      channelType: args.channelType ?? null,
      isAdmin: args.agentConfig.admin === true,
    },
    timezone: args.timezone ?? null,
    bootstrap: shared.bootstrap,
    sharedContext: shared.sharedContext,
    toolInvariants: shared.toolInvariants ?? undefined,
    cron:
      args.mode === "cron" && args.cronJob
        ? { job: args.cronJob, delivery: args.cronDelivery ?? null }
        : undefined,
    agentMail:
      args.mode === "agent-mail" && agentMailBlock
        ? { appendedBlock: agentMailBlock }
        : undefined,
  };
}

/**
 * Read everything from disk and return the assembled system-prompt string.
 *
 * Thin wrapper: concurrently reads bootstrap files, shared CONTEXT.md,
 * tool invariants, and the agent-mail block, constructs a `PromptInputs`,
 * and calls `buildPrompt`.
 */
export async function loadPromptInputs(args: LoadPromptInputsArgs): Promise<string> {
  const [shared, agentMailBlock] = await Promise.all([
    loadSharedInputs({
      agentDir: args.agentDir,
      orgDir: args.orgDir,
      globalContextDir: args.globalContextDir,
      log: args.log,
    }),
    args.mode === "agent-mail" ? loadAgentMailBlock() : Promise.resolve(null),
  ]);
  const inputs = buildInputsFromShared(args, shared, agentMailBlock);
  return buildPrompt(inputs);
}

/**
 * Load the inputs once and produce both the main and agent-mail prompts.
 *
 * Used by the agent-manager at initialize and registerAgent time so we
 * don't pay double disk I/O (bootstrap x6 + shared-context x2 + tool
 * invariants x1) per agent just to cache two prompts. The two prompts
 * differ only in the trailing agent-mail block.
 */
export async function loadMainAndAgentMailPrompts(
  args: Omit<LoadPromptInputsArgs, "mode" | "cronJob" | "cronDelivery">,
): Promise<{ systemPrompt: string; agentMailPrompt: string }> {
  const [shared, agentMailBlock] = await Promise.all([
    loadSharedInputs({
      agentDir: args.agentDir,
      orgDir: args.orgDir,
      globalContextDir: args.globalContextDir,
      log: args.log,
    }),
    loadAgentMailBlock(),
  ]);
  const mainInputs = buildInputsFromShared({ ...args, mode: "main" }, shared, null);
  const mailInputs = buildInputsFromShared(
    { ...args, mode: "agent-mail" },
    shared,
    agentMailBlock,
  );
  return {
    systemPrompt: buildPrompt(mainInputs),
    agentMailPrompt: buildPrompt(mailInputs),
  };
}
