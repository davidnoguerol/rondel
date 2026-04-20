/**
 * Reads the cross-agent shared CONTEXT.md files.
 *
 * - `global`: `<globalContextDir>/CONTEXT.md` — cross-agent conventions.
 * - `org`: `<orgDir>/shared/CONTEXT.md` — org-specific conventions (only
 *   for agents belonging to an org).
 *
 * Both optional. Missing or empty files become `undefined`.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PromptSharedContext } from "./types.js";

async function tryRead(path: string): Promise<string | undefined> {
  try {
    const content = await readFile(path, "utf-8");
    const trimmed = content.trim();
    return trimmed || undefined;
  } catch {
    return undefined;
  }
}

export interface SharedContextLoadArgs {
  readonly orgDir?: string;
  readonly globalContextDir?: string;
}

export async function loadSharedContext(
  args: SharedContextLoadArgs,
): Promise<PromptSharedContext> {
  const [global, org] = await Promise.all([
    args.globalContextDir
      ? tryRead(join(args.globalContextDir, "CONTEXT.md"))
      : Promise.resolve(undefined),
    args.orgDir ? tryRead(join(args.orgDir, "shared", "CONTEXT.md")) : Promise.resolve(undefined),
  ]);

  return { global, org };
}
