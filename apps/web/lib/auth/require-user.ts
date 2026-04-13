/**
 * `requireUser()` — the single session/auth helper.
 *
 * v1 is single-user, localhost-only. This helper currently re-asserts
 * the loopback gate (as a defense-in-depth on top of middleware.ts) and
 * returns a stub user identity.
 *
 * ## When we add real auth
 *
 * This is the ONE file to change. Replace the body to read a session
 * cookie / JWT / proxy-authorized header. Every Server Action and the
 * /api/bridge proxy call this function; nothing else knows the user.
 *
 * Do NOT remove the host check before replacing the body. The web UI
 * must not accept non-loopback requests in v1 under any circumstance.
 */
import "server-only";

import { headers } from "next/headers";

export interface RondelUser {
  readonly id: string;
}

const ALLOWED_HOSTS = new Set(["127.0.0.1", "localhost"]);

export async function requireUser(): Promise<RondelUser> {
  const h = await headers();
  const host = (h.get("host") ?? "").split(":")[0];
  if (!ALLOWED_HOSTS.has(host)) {
    throw new Error("Forbidden: Rondel web UI is localhost-only.");
  }
  // Stub — replace with real session read when multi-user arrives.
  return { id: "local" };
}
