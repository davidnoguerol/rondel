import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { rondelPaths } from "./config.js";
import { resolveFrameworkContextDir } from "../shared/paths.js";
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

/**
 * Load every `.md` file under `templates/framework-context/` and return them
 * as a single concatenated block. These are framework-owned system-prompt
 * fragments that carry protocol-level invariants (the Rondel tool surface,
 * disallowed native tools, etc.). They are NOT user-editable — they live in
 * the framework's `templates/` directory and ship with the daemon.
 *
 * Load order is alphabetical for determinism.
 *
 * If the directory doesn't exist or is empty, returns undefined and the
 * assembler proceeds without a framework layer (useful for tests that stub
 * out the daemon's templates).
 */
async function loadFrameworkContext(log: Logger): Promise<string | undefined> {
  const dir = resolveFrameworkContextDir();
  let entries: string[];
  try {
    entries = (await readdir(dir)).filter((f) => f.endsWith(".md")).sort();
  } catch {
    return undefined;
  }
  if (entries.length === 0) return undefined;

  const blocks: string[] = [];
  for (const name of entries) {
    const content = await tryReadFile(join(dir, name));
    if (content) blocks.push(content);
  }
  if (blocks.length === 0) return undefined;

  const joined = blocks.join("\n\n---\n\n");
  log.info(`Loaded framework context (${entries.length} file(s), ${joined.length} chars)`);
  return joined;
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
 *   Layer 0 (framework-owned, uneditable):
 *     templates/framework-context/*.md — protocol invariants: Rondel
 *     tool surface, disallowed natives. Every agent gets this prepended.
 *   ---
 *   Layer 1: global/CONTEXT.md (cross-agent conventions — user-owned)
 *   ---
 *   Layer 1.5: {org}/shared/CONTEXT.md (org conventions — user-owned, if org)
 *   ---
 *   Layer 2+: per-agent files (user-owned):
 *     # AGENT.md            operating instructions
 *     # SOUL.md             persona and boundaries
 *     # IDENTITY.md         identity card
 *     # USER.md             user profile (with fallback chain)
 *     # MEMORY.md           persistent knowledge
 *     # BOOTSTRAP.md        first-run ritual — deleted after completion
 *
 * Framework vs user layers: Layer 0 is shipped by the daemon and must
 * not be duplicated into user-editable files. Behavior-critical rules
 * (what tools exist, what's disallowed, safety invariants) live in
 * Layer 0 so that a user editing their AGENT.md can never break the
 * system. Everything below is personality, preferences, memory.
 *
 * Falls back to the legacy SYSTEM.md if no new-style files exist.
 *
 * USER.md fallback chain: agent's own → {org}/shared/USER.md → global/USER.md
 *
 * @param agentDir - Absolute path to the agent's directory
 * @param log - Logger instance
 * @param options.isEphemeral - If true, strip MEMORY.md, USER.md, BOOTSTRAP.md (for subagents/cron)
 * @param options.globalContextDir - Directory containing global CONTEXT.md and fallback USER.md
 * @param options.orgDir - Absolute path to the agent's org directory (undefined for global agents)
 */
export async function assembleContext(
  agentDir: string,
  log: Logger,
  options?: { isEphemeral?: boolean; globalContextDir?: string; orgDir?: string },
): Promise<string> {
  const layers: string[] = [];

  // Layer 0: Framework context — shipped with the daemon, not user-editable.
  // Carries protocol invariants (tool surface, disallowed natives). Applies
  // to ephemeral processes (subagents, cron) too — they need to know which
  // tools to call just as much as top-level agents.
  const frameworkContent = await loadFrameworkContext(log);
  if (frameworkContent) {
    layers.push(frameworkContent);
  }

  // Layer 1: Global context — look for CONTEXT.md in the workspaces root
  if (options?.globalContextDir) {
    const globalContent = await tryReadFile(join(options.globalContextDir, "CONTEXT.md"));
    if (globalContent) {
      layers.push(globalContent);
      log.info(`Loaded global context (${globalContent.length} chars)`);
    }
  }

  // Layer 1.5: Org-specific shared context (only for agents belonging to an org)
  if (options?.orgDir) {
    const orgContent = await tryReadFile(join(options.orgDir, "shared", "CONTEXT.md"));
    if (orgContent) {
      layers.push(orgContent);
      log.info(`Loaded org context (${orgContent.length} chars)`);
    }
  }

  // Layers 2-7: Agent bootstrap files
  const isEphemeral = options?.isEphemeral ?? false;
  let loadedBootstrapFiles = 0;

  for (const filename of BOOTSTRAP_FILES) {
    if (isEphemeral && EPHEMERAL_EXCLUDED_FILES.has(filename)) continue;

    let content: string | undefined;

    if (filename === "USER.md") {
      // USER.md fallback chain: agent → org/shared → global
      content = await tryReadFile(join(agentDir, filename));
      if (!content && options?.orgDir) {
        content = await tryReadFile(join(options.orgDir, "shared", "USER.md"));
        if (content) log.info("USER.md resolved from org shared context");
      }
      if (!content && options?.globalContextDir) {
        content = await tryReadFile(join(options.globalContextDir, "USER.md"));
        if (content) log.info("USER.md resolved from global context");
      }
    } else {
      content = await tryReadFile(join(agentDir, filename));
    }

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
  rondelHome: string,
  templateName: string,
  log: Logger,
): Promise<string | undefined> {
  const paths = rondelPaths(rondelHome);
  const layers: string[] = [];

  // Layer 0: Framework context — same as top-level agents. Subagents
  // call the same MCP tool surface and must not be given native-tool
  // guidance either.
  const frameworkContent = await loadFrameworkContext(log);
  if (frameworkContent) {
    layers.push(frameworkContent);
  }

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
