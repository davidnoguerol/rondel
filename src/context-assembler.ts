import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "./logger.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Bootstrap context files loaded from the agent directory.
 * Order matters — this is the injection order into the system prompt.
 * Each file is prefixed with a `# filename` heading so the agent knows
 * which file it's reading (same pattern as OpenClaw).
 */
const BOOTSTRAP_FILES = ["AGENT.md", "SOUL.md", "IDENTITY.md", "USER.md", "MEMORY.md"] as const;

/**
 * Files stripped from subagent and cron contexts.
 * - MEMORY.md: prevents leaking accumulated knowledge into ephemeral processes
 * - USER.md: prevents leaking personal user context
 */
const EPHEMERAL_EXCLUDED_FILES = new Set(["MEMORY.md", "USER.md"]);

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
 *   global/CONTEXT.md  (Layer 1: cross-agent conventions)
 *   ---
 *   # AGENT.md          (Layer 2: operating instructions)
 *   # SOUL.md           (Layer 3: persona and boundaries)
 *   # IDENTITY.md       (Layer 4: identity card)
 *   # USER.md           (Layer 5: user profile)
 *   # MEMORY.md         (Layer 6: persistent knowledge)
 *
 * Falls back to the legacy SYSTEM.md if no new-style files exist.
 *
 * @param projectDir - FlowClaw project root
 * @param agentName - Agent directory name
 * @param log - Logger instance
 * @param options.isEphemeral - If true, strip MEMORY.md and USER.md (for subagents/cron)
 */
export async function assembleContext(
  projectDir: string,
  agentName: string,
  log: Logger,
  options?: { isEphemeral?: boolean },
): Promise<string> {
  const layers: string[] = [];

  // Layer 1: Global context
  const globalPath = join(projectDir, "global", "CONTEXT.md");
  const globalContent = await tryReadFile(globalPath);
  if (globalContent) {
    layers.push(globalContent);
    log.info(`Loaded global context (${globalContent.length} chars)`);
  } else {
    log.warn("No global/CONTEXT.md found — skipping global context layer");
  }

  // Layers 2-6: Agent bootstrap files
  const agentDir = join(projectDir, "agents", agentName);
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
        `No context files found for agent "${agentName}". ` +
        `Expected AGENT.md (or legacy SYSTEM.md) in agents/${agentName}/`,
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
  projectDir: string,
  templateName: string,
  log: Logger,
): Promise<string | undefined> {
  const layers: string[] = [];

  // Layer 1: Global context (same as agents)
  const globalPath = join(projectDir, "global", "CONTEXT.md");
  const globalContent = await tryReadFile(globalPath);
  if (globalContent) {
    layers.push(globalContent);
  }

  // Layer 2: Template system prompt
  const templatePath = join(projectDir, "templates", templateName, "SYSTEM.md");
  const templateContent = await tryReadFile(templatePath);
  if (!templateContent) {
    return undefined;
  }

  layers.push(templateContent);
  log.info(`Loaded template system prompt: ${templateName} (${templateContent.length} chars)`);

  return layers.join("\n\n---\n\n");
}
