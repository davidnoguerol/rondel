/**
 * Memory protocol.
 *
 * Rondel loads MEMORY.md (the bounded index) into the system prompt at
 * spawn. This section describes the memory structure and the write-policy
 * contract (design §5.1/§5.3). Only emitted in persistent modes where
 * MEMORY.md is actually loaded — `cron` runs are ephemeral and strip
 * memory, so this section is suppressed (the heartbeat skill carries the
 * blind-append discipline for those turns).
 */

export function buildMemory({ isEphemeral }: { isEphemeral: boolean }): string | null {
  if (isEphemeral) return null;
  return [
    "## Memory",
    "Your MEMORY.md is a bounded index — one line per durable fact — loaded into this prompt at spawn. Details that don't fit one line go in topic files at memory/topics/<slug>.md (read them on demand; descriptive names are the retrieval). Daily notes live at memory/YYYY-MM-DD.md and are written for you at session end; they are not in this prompt.",
    "Write with `rondel_memory_append` (one fact), `rondel_memory_replace` / `rondel_memory_remove` (edit by unique substring). Appends are safe without reading first. If the index is full, the error returns every entry — merge or evict, then retry. Mid-session writes hit disk immediately but this prompt copy is frozen until your next session; use `rondel_memory_read` for a refresh.",
    "Write policy:",
    "- Declarative facts, not instructions to yourself. \"User prefers terse updates\" ✓; \"Always be terse\" ✗ — imperatives get re-read as directives later and hijack behavior.",
    "- The 7-day rule: if it will be stale in a week it does not belong in memory — it's in the transcript; search for it instead.",
    "- Date every entry (appends are auto-dated — keep it that way).",
    "- Never record negative capability claims (\"X tool is broken\") — they harden into refusals long after the problem is fixed.",
    "- Prefer supersession over silent mutation: append \"superseded by X on DATE\" rather than destructively rewriting history.",
    "Mental notes do not survive restarts. Files do. If in doubt, append it.",
  ].join("\n");
}
