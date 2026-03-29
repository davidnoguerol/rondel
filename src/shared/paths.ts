import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Resolve the path to templates/framework-skills/ relative to this module. */
export function resolveFrameworkSkillsDir(): string {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  return join(thisDir, "..", "..", "templates", "framework-skills");
}
