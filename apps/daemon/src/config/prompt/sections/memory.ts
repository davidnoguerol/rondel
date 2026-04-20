/**
 * Memory protocol.
 *
 * Rondel loads MEMORY.md into the system prompt at spawn. This section
 * tells the agent what to do with it and how to update it. Only emitted
 * in persistent modes where MEMORY.md is actually loaded — `cron` runs
 * are ephemeral and strip memory, so this section is suppressed.
 */

export function buildMemory({ isEphemeral }: { isEphemeral: boolean }): string | null {
  if (isEphemeral) return null;
  return [
    "## Memory",
    "Your MEMORY.md is loaded into this prompt at spawn — review it at the top of each session. Use `rondel_memory_save` to persist anything worth carrying forward: lessons learned, user preferences, project facts that are expensive to rediscover.",
    "Use `rondel_memory_read` only when you need a mid-session refresh — a full-file replace via `rondel_memory_save` invalidates the in-prompt copy.",
    "Mental notes do not survive restarts. Files do. If in doubt, save it.",
  ].join("\n");
}
