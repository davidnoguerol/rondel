/**
 * Reads the user-owned bootstrap files from an agent's directory.
 *
 * Returns a `PromptBootstrapFiles` struct with one field per bootstrap
 * file. Missing files become `undefined`; empty files (after trim)
 * collapse to `undefined` too — the assembler treats missing and empty
 * identically.
 *
 * USER.md has a fallback chain: agent's own → `<orgDir>/shared/USER.md`
 * → `<globalContextDir>/USER.md`. First hit wins. This preserves the
 * behaviour from the legacy assembler (`context-assembler.ts:199-209`).
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { maskThreats } from "../../shared/safety/index.js";
import type { Logger } from "../../shared/logger.js";
import type { PromptBootstrapFiles } from "./types.js";

async function tryRead(path: string): Promise<string | undefined> {
  try {
    const content = await readFile(path, "utf-8");
    const trimmed = content.trim();
    return trimmed || undefined;
  } catch {
    return undefined;
  }
}

export interface BootstrapLoadArgs {
  readonly agentDir: string;
  readonly orgDir?: string;
  readonly globalContextDir?: string;
  readonly log: Logger;
}

/**
 * Load the six bootstrap files. The assembler decides which to inject
 * based on mode — this function is mode-agnostic and always reads all
 * six. That's a tradeoff: a tiny amount of extra disk IO in exchange
 * for a smaller, simpler API.
 */
export async function loadBootstrapFiles(
  args: BootstrapLoadArgs,
): Promise<PromptBootstrapFiles> {
  const { agentDir, orgDir, globalContextDir, log } = args;

  const [agent, soul, identity, rawMemory, bootstrapRitual] = await Promise.all([
    tryRead(join(agentDir, "AGENT.md")),
    tryRead(join(agentDir, "SOUL.md")),
    tryRead(join(agentDir, "IDENTITY.md")),
    tryRead(join(agentDir, "MEMORY.md")),
    tryRead(join(agentDir, "BOOTSTRAP.md")),
  ]);

  // §8.1: memory is a prompt-injection persistence vector — flagged lines are
  // masked with a VISIBLE [BLOCKED: …] placeholder at injection time (the
  // file keeps the original so the user can inspect and remove it).
  const memory = rawMemory === undefined ? undefined : maskMemoryThreats(rawMemory, log);

  // USER.md fallback chain: agent → org/shared → global
  let user = await tryRead(join(agentDir, "USER.md"));
  if (!user && orgDir) {
    user = await tryRead(join(orgDir, "shared", "USER.md"));
    if (user) log.info("USER.md resolved from org shared context");
  }
  if (!user && globalContextDir) {
    user = await tryRead(join(globalContextDir, "USER.md"));
    if (user) log.info("USER.md resolved from global context");
  }

  return { agent, soul, identity, user, memory, bootstrapRitual };
}

/** Visible-masking wrapper for the spawn-prompt MEMORY.md injection. */
function maskMemoryThreats(content: string, log: { warn(msg: string): void }): string | undefined {
  const { masked, flaggedCount } = maskThreats(content);
  if (flaggedCount > 0) log.warn(`MEMORY.md injection: masked ${flaggedCount} threat-flagged line(s)`);
  const trimmed = masked.trim();
  return trimmed.length > 0 ? masked : undefined;
}
