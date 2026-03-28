import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "./logger.js";

/**
 * Assemble the effective system prompt for an agent by concatenating
 * global context + agent-specific system prompt.
 *
 * Phase 0: Two layers only (global + agent). Org layer comes later.
 */
export async function assembleContext(
  projectDir: string,
  agentName: string,
  log: Logger,
): Promise<string> {
  const layers: string[] = [];

  // Layer 1: Global context
  const globalPath = join(projectDir, "global", "CONTEXT.md");
  try {
    const globalContext = await readFile(globalPath, "utf-8");
    layers.push(globalContext.trim());
    log.info(`Loaded global context (${globalContext.length} chars)`);
  } catch {
    log.warn("No global/CONTEXT.md found — skipping global context layer");
  }

  // Layer 2: Agent system prompt
  const agentPath = join(projectDir, "agents", agentName, "SYSTEM.md");
  try {
    const agentPrompt = await readFile(agentPath, "utf-8");
    layers.push(agentPrompt.trim());
    log.info(`Loaded agent system prompt (${agentPrompt.length} chars)`);
  } catch {
    throw new Error(`Missing required file: agents/${agentName}/SYSTEM.md`);
  }

  const assembled = layers.join("\n\n---\n\n");
  log.info(`Assembled context: ${assembled.length} chars total`);
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
  try {
    const globalContext = await readFile(globalPath, "utf-8");
    layers.push(globalContext.trim());
  } catch {
    // No global context — fine
  }

  // Layer 2: Template system prompt
  const templatePath = join(projectDir, "templates", templateName, "SYSTEM.md");
  try {
    const templatePrompt = await readFile(templatePath, "utf-8");
    layers.push(templatePrompt.trim());
    log.info(`Loaded template system prompt: ${templateName} (${templatePrompt.length} chars)`);
  } catch {
    return undefined;
  }

  return layers.join("\n\n---\n\n");
}
