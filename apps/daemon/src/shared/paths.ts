import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function templatesDir(): string {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  return join(thisDir, "..", "..", "templates");
}

/** Resolve the path to templates/framework-skills/ relative to this module. */
export function resolveFrameworkSkillsDir(): string {
  return join(templatesDir(), "framework-skills");
}

/**
 * Resolve the path to templates/framework-context/ — framework-owned
 * system-prompt fragments that are prepended to every agent's context
 * at spawn time. These are NOT user-editable and carry protocol-level
 * invariants (tool surface, disallowed natives, etc.). See
 * `apps/daemon/src/config/prompt/sections/tool-invariants.ts`.
 */
export function resolveFrameworkContextDir(): string {
  return join(templatesDir(), "framework-context");
}
