import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { flowclawPaths } from "./config.js";
import type { Logger } from "../shared/logger.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Bootstrap context files loaded from the agent directory.
 * Order matters — this is the injection order into the system prompt.
 * Each file is prefixed with a `# filename` heading so the agent knows
 * which file it's reading (same pattern as OpenClaw).
 */
const BOOTSTRAP_FILES = ["AGENT.md", "SOUL.md", "IDENTITY.md", "USER.md", "MEMORY.md", "BOOTSTRAP.md"] as const;

/**
 * Files stripped from subagent and cron contexts.
 * - MEMORY.md: prevents leaking accumulated knowledge into ephemeral processes
 * - USER.md: prevents leaking personal user context
 * - BOOTSTRAP.md: first-run ritual only applies to main sessions
 */
const EPHEMERAL_EXCLUDED_FILES = new Set(["MEMORY.md", "USER.md", "BOOTSTRAP.md"]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Try to read a file. Returns its trimmed content or undefined if missing. */
async function tryReadFile(path: string): Promise<string | undefined> {
  try {
    const content = await readFile(path, "utf-8");
    return content.trim() || undefined; // treat empty files as missing
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Assemble the effective system prompt for an agent.
 *
 * Loads context files from the agent directory in a structured, layered
 * approach inspired by OpenClaw's bootstrap system:
 *
 *   global/CONTEXT.md  (Layer 1: cross-agent conventions)  — from workspaces
 *   ---
 *   # AGENT.md          (Layer 2: operating instructions)
 *   # SOUL.md           (Layer 3: persona and boundaries)
 *   # IDENTITY.md       (Layer 4: identity card)
 *   # USER.md           (Layer 5: user profile)
 *   # MEMORY.md         (Layer 6: persistent knowledge)
 *   # BOOTSTRAP.md      (Layer 7: first-run ritual — deleted after completion)
 *
 * Falls back to the legacy SYSTEM.md if no new-style files exist.
 *
 * @param agentDir - Absolute path to the agent's directory
 * @param log - Logger instance
 * @param options.isEphemeral - If true, strip MEMORY.md, USER.md, BOOTSTRAP.md (for subagents/cron)
 * @param options.globalContextDir - Directory containing CONTEXT.md (defaults to workspaces dir parent)
 */
export async function assembleContext(
  agentDir: string,
  log: Logger,
  options?: { isEphemeral?: boolean; globalContextDir?: string },
): Promise<string> {
  const layers: string[] = [];

  // Layer 1: Global context — look for CONTEXT.md in the workspaces root
  // The global context file can be at workspaces/global/CONTEXT.md or passed explicitly
  if (options?.globalContextDir) {
    const globalContent = await tryReadFile(join(options.globalContextDir, "CONTEXT.md"));
    if (globalContent) {
      layers.push(globalContent);
      log.info(`Loaded global context (${globalContent.length} chars)`);
    }
  }

  // Layers 2-7: Agent bootstrap files
  const isEphemeral = options?.isEphemeral ?? false;
  let loadedBootstrapFiles = 0;

  for (const filename of BOOTSTRAP_FILES) {
    if (isEphemeral && EPHEMERAL_EXCLUDED_FILES.has(filename)) continue;

    const content = await tryReadFile(join(agentDir, filename));
    if (content) {
      layers.push(`# ${filename}\n\n${content}`);
      loadedBootstrapFiles++;
      log.info(`Loaded ${filename} (${content.length} chars)`);
    }
  }

  // Fallback: if no bootstrap files found, try legacy SYSTEM.md
  if (loadedBootstrapFiles === 0) {
    const systemPath = join(agentDir, "SYSTEM.md");
    const systemContent = await tryReadFile(systemPath);
    if (systemContent) {
      layers.push(systemContent);
      log.info(`Loaded legacy SYSTEM.md (${systemContent.length} chars)`);
    } else {
      throw new Error(
        `No context files found for agent in ${agentDir}. ` +
        `Expected AGENT.md (or legacy SYSTEM.md).`,
      );
    }
  }

  const assembled = layers.join("\n\n---\n\n");
  log.info(`Assembled context: ${assembled.length} chars total (${loadedBootstrapFiles} bootstrap files)`);
  return assembled;
}

/**
 * Assemble the system prompt for a subagent template.
 * Global context + templates/{templateName}/SYSTEM.md.
 * Returns undefined if the template's SYSTEM.md doesn't exist.
 */
export async function assembleTemplateContext(
  flowclawHome: string,
  templateName: string,
  log: Logger,
): Promise<string | undefined> {
  const paths = flowclawPaths(flowclawHome);
  const layers: string[] = [];

  // Layer 1: Global context (same as agents) — try workspaces/global/CONTEXT.md
  const globalPath = join(paths.workspaces, "global", "CONTEXT.md");
  const globalContent = await tryReadFile(globalPath);
  if (globalContent) {
    layers.push(globalContent);
  }

  // Layer 2: Template system prompt
  const templatePath = join(paths.templates, templateName, "SYSTEM.md");
  const templateContent = await tryReadFile(templatePath);
  if (!templateContent) {
    return undefined;
  }

  layers.push(templateContent);
  log.info(`Loaded template system prompt: ${templateName} (${templateContent.length} chars)`);

  return layers.join("\n\n---\n\n");
}
