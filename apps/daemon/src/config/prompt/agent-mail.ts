/**
 * Loads the framework-owned `AGENT-MAIL.md` block that gets appended to
 * an agent's prompt when a conversation is agent-mail (inter-agent
 * messaging).
 *
 * The template is shipped with the daemon — a missing or empty file
 * means the install is broken. Throws loudly so startup fails with a
 * clear error instead of silently degrading to the main prompt. This
 * matches CLAUDE.md's "fail loudly at boundaries" rule for framework
 * invariants.
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function resolveAgentMailTemplatePath(): string {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  return join(thisDir, "..", "..", "..", "templates", "context", "AGENT-MAIL.md");
}

export async function loadAgentMailBlock(): Promise<string> {
  const path = resolveAgentMailTemplatePath();
  let content: string;
  try {
    content = await readFile(path, "utf-8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `AGENT-MAIL.md not found at ${path} (${message}). This file ships with the ` +
        `daemon — a missing copy means the install is broken. Reinstall or restore ` +
        `apps/daemon/templates/context/AGENT-MAIL.md.`,
    );
  }
  const trimmed = content.trim();
  if (!trimmed) {
    throw new Error(
      `AGENT-MAIL.md at ${path} is empty. This file ships with the daemon — an ` +
        `empty copy means the install is broken. Reinstall or restore ` +
        `apps/daemon/templates/context/AGENT-MAIL.md.`,
    );
  }
  return trimmed;
}
