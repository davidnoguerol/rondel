/**
 * Bridge proxy allowlists + the matcher.
 *
 * Lives in a sibling module rather than inside `route.ts` because Next's
 * App Router conventions reserve route files for HTTP-method exports
 * (GET, POST, …). Pulling these out lets `route.test.ts` import + assert
 * them directly without spinning up a Next runtime.
 *
 * =============================================================================
 * EDITING RULES — these allowlists are the ONLY thing keeping the daemon's
 * admin surface off the browser-facing wire. Treat changes as security work.
 * =============================================================================
 *
 * - **Never use blocklists.** A new admin endpoint added to the daemon
 *   would silently become exposed.
 * - **Each entry is a path or a RegExp** — RegExps must be anchored
 *   (`^…$`) so a path-traversal-style prefix can't sneak in.
 * - **A change to either GET list or the SSE list belongs in the same
 *   commit as the route's matching test update** — the test asserts
 *   the exact lists.
 */

/**
 * Short-lived (request-response) GET paths the UI is allowed to call via
 * the proxy. Keep this list small. Prefer server-side rendering over
 * adding a new client fetch endpoint.
 */
export const GET_ALLOWLIST: readonly (string | RegExp)[] = [
  "/version",
  "/agents",
  "/ledger/query",
  /^\/conversations\/[^/]+$/,
  /^\/conversations\/[^/]+\/[^/]+\/[^/]+\/history$/,
  /^\/memory\/[^/]+$/,
];

/**
 * Long-lived (SSE) paths the UI is allowed to call via the proxy.
 * These get DIFFERENT treatment than `GET_ALLOWLIST`:
 *   - no `AbortSignal.timeout` (would kill the stream)
 *   - the client's abort signal IS forwarded upstream so client
 *     disconnect propagates to the daemon (otherwise the daemon
 *     keeps writing to a dead socket until heartbeat fails)
 *
 * Stay vigilant about new entries here — every SSE path is a
 * persistent connection, and adding the wrong path here would
 * leak admin events to client components.
 */
export const SSE_ALLOWLIST: readonly (string | RegExp)[] = [
  // Multiplexed dashboard-wide event stream. Carries approvals,
  // agents-state, tasks, ledger, schedules, heartbeats in a single
  // connection. See apps/web/lib/streams/multiplex-provider.tsx.
  "/events/tail",
  // Per-conversation chat tail stays separate — different lifecycle
  // (per entity, bandwidth-heavy during token streaming).
  /^\/conversations\/[^/]+\/[^/]+\/[^/]+\/tail$/,
];

/**
 * POST paths the UI is allowed to call via the proxy. Kept as a tight,
 * single-entry allowlist — every future addition needs an explicit decision
 * because mutations on the bridge have larger blast radius than reads.
 *
 * The web chat send endpoint is here because the chat UI needs to deliver
 * messages from a Client Component (live typing, optimistic updates). A
 * Server Action would add a round-trip and block the typing loop.
 */
export const POST_ALLOWLIST: readonly (string | RegExp)[] = [
  "/web/messages/send",
];

export function matchesAllowlist(
  pathname: string,
  list: readonly (string | RegExp)[],
): boolean {
  return list.some((pattern) =>
    typeof pattern === "string"
      ? pattern === pathname
      : pattern.test(pathname),
  );
}
