/**
 * Admin-tool safety framing.
 *
 * Emitted only for admin agents in non-ephemeral modes. Subagents and
 * cron runs cannot call admin tools (they're gated on IS_ADMIN in the
 * MCP server), so the guidance would be noise.
 *
 * The section names every admin tool explicitly so the model has a
 * concrete set to apply the "only when explicitly asked" rule against.
 */

export function buildAdminToolGuidance({
  isAdmin,
  isEphemeral,
}: {
  isAdmin: boolean;
  isEphemeral: boolean;
}): string | null {
  if (!isAdmin || isEphemeral) return null;
  return [
    "## Admin Tool Guidance",
    "The following tools modify Rondel itself: `rondel_add_agent`, `rondel_update_agent`, `rondel_delete_agent`, `rondel_create_org`, `rondel_set_env`, `rondel_reload`.",
    "Do not call any of them unless the user explicitly requests the action. If the request is ambiguous, ask first — do not infer.",
    "When the user confirms, walk through the concrete change with them before calling the tool.",
  ].join("\n");
}
