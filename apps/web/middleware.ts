/**
 * Loopback gate for the Rondel web UI.
 *
 * v1 is single-user, same-machine as the daemon. There is no user
 * authentication, so the safety net is: refuse any request whose Host
 * header is not `127.0.0.1` or `localhost`.
 *
 * This middleware exists to prevent a future contributor from accidentally
 * exposing the admin surface on a LAN by running `next dev -H 0.0.0.0` or
 * deploying the web package to a remote host. The gate is NOT a no-op.
 *
 * DO NOT remove this check before replacing it with a real auth system
 * (session cookies, proxy-authorized headers, OAuth, etc.). See
 * apps/web/lib/auth/require-user.ts for the single helper to swap.
 */
import { NextResponse, type NextRequest } from "next/server";

const ALLOWED_HOSTS = new Set(["127.0.0.1", "localhost"]);

export function middleware(req: NextRequest) {
  const hostHeader = req.headers.get("host") ?? "";
  // Strip port: Host header looks like "127.0.0.1:3000"
  const hostname = hostHeader.split(":")[0];

  if (!ALLOWED_HOSTS.has(hostname)) {
    return new NextResponse(
      "Rondel web UI is localhost-only. Access from 127.0.0.1 or localhost.",
      { status: 403 },
    );
  }

  return NextResponse.next();
}

// Apply to everything except Next internals and static assets.
// The /api/bridge proxy also relies on this gate.
export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};
