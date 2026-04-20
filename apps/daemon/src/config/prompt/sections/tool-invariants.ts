/**
 * Loads the existing `templates/framework-context/TOOLS.md` file, which
 * carries tool invariants (native Bash/Write/Edit disallowed, durable
 * scheduling via `rondel_schedule_*`, etc.).
 *
 * This replaces the former Layer 0 framework-context scanner in the
 * legacy assembler. We now load only the one file that exists, with a
 * known shape — simpler and more predictable than scanning a directory.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveFrameworkContextDir } from "../../../shared/paths.js";

export async function buildToolInvariants(): Promise<string | null> {
  const path = join(resolveFrameworkContextDir(), "TOOLS.md");
  try {
    const content = await readFile(path, "utf-8");
    const trimmed = content.trim();
    return trimmed || null;
  } catch {
    return null;
  }
}
