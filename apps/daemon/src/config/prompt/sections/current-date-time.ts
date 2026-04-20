/**
 * Current Date & Time grounding.
 *
 * Per user decision during the revamp audit: for always-on agents, a
 * timestamp baked into the spawn-time prompt goes stale quickly and
 * risks the agent assuming a wrong date. Instead we emit only the
 * timezone and point the agent at `rondel_system_status`, which
 * returns a fresh `currentTimeIso` on every call.
 *
 * Suppressed when timezone is not configured.
 */

export function buildCurrentDateTime({ timezone }: { timezone: string | null }): string | null {
  if (!timezone) return null;
  return [
    "## Current Date & Time",
    `Time zone: ${timezone}`,
    "If you need the current date or time, call `rondel_system_status` and read the `currentTimeIso` field.",
  ].join("\n");
}
