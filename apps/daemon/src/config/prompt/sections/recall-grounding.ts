/**
 * Loads `templates/framework-context/KNOWLEDGE.md` — the memory-recall
 * grounding contract + KB discipline (design §4.4). Framework space: it
 * changes which tools the agent calls (rondel_kb_query before answering
 * about the past; "say you checked" anti-hallucination clause), so it must
 * never live in user-editable files.
 *
 * Emitted unconditionally in every mode (same treatment as TOOLS.md) —
 * cron/heartbeat turns query the KB too.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveFrameworkContextDir } from "../../../shared/paths.js";

export async function buildRecallGrounding(): Promise<string | null> {
  const path = join(resolveFrameworkContextDir(), "KNOWLEDGE.md");
  try {
    const content = await readFile(path, "utf-8");
    const trimmed = content.trim();
    return trimmed || null;
  } catch {
    return null;
  }
}
