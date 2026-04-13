/**
 * Browser-facing proxy to the Rondel bridge.
 *
 * =============================================================================
 * RULES (keep this file small and obviously-correct)
 * =============================================================================
 *
 * 1. GET-ONLY allowlist — not a method blocklist. Blocklists age badly;
 *    the moment someone adds a new admin GET to the daemon in six months,
 *    a blocklist would silently expose it. The allowlist below is the
 *    exact set of paths client components are allowed to call.
 *
 * 2. Loopback + Origin check on every request. Middleware already rejects
 *    non-loopback Host, but we re-assert here as defense in depth and
 *    add an Origin match to close DNS rebinding attacks (a real class
 *    for localhost services).
 *
 * 3. Mutations NEVER flow through this proxy. Server Actions (same-origin
 *    POST with Next's automatic CSRF/action-ID hashing) handle writes.
 *    Admin endpoints and env-read are blocked even as GETs: the admin
 *    surface is never a client concern, and env may contain bot tokens.
 *
 * 4. No business logic. Every new endpoint the UI consumes should:
 *    (a) be added to the allowlist below if clients need to refetch it,
 *    (b) have a method on `lib/bridge/client.ts` for server-side reads,
 *    (c) never reinvent validation, auth, or retry here.
 */
import { NextResponse, type NextRequest } from "next/server";

import { getBridgeUrl } from "@/lib/bridge/discovery";
import { invalidateBridgeUrl } from "@/lib/bridge/discovery";
import { RondelNotRunningError } from "@/lib/bridge";
import { requireUser } from "@/lib/auth/require-user";

/**
 * Exact-match and regex-prefixed paths the UI is allowed to GET via the
 * proxy. Keep this list small. Prefer server-side rendering over adding
 * a new client fetch endpoint.
 */
const GET_ALLOWLIST: readonly (string | RegExp)[] = [
  "/version",
  "/agents",
  "/ledger/query",
  /^\/conversations\/[^/]+$/,
  /^\/memory\/[^/]+$/,
];

function isPathAllowed(pathname: string): boolean {
  return GET_ALLOWLIST.some((pattern) =>
    typeof pattern === "string"
      ? pattern === pathname
      : pattern.test(pathname),
  );
}

/**
 * Check whether a request is allowed past the gate:
 *   - Host is loopback (middleware already enforces but we re-check).
 *   - Origin, if present, matches the request's own host (no cross-site).
 */
function checkOriginAndHost(req: NextRequest): { ok: true } | { ok: false; reason: string } {
  const hostHeader = req.headers.get("host") ?? "";
  const hostname = hostHeader.split(":")[0];
  if (hostname !== "127.0.0.1" && hostname !== "localhost") {
    return { ok: false, reason: "non-loopback host" };
  }

  // Origin is absent for server-to-server curl, present for browser fetches.
  // If absent, the loopback middleware gate is our only protection and we
  // accept. If present, it must match.
  const origin = req.headers.get("origin");
  if (origin) {
    try {
      const originUrl = new URL(origin);
      if (originUrl.host !== hostHeader) {
        return { ok: false, reason: "origin mismatch" };
      }
    } catch {
      return { ok: false, reason: "malformed origin" };
    }
  }

  return { ok: true };
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
): Promise<NextResponse> {
  // Loopback + user check — throws if something is wrong, no info leak.
  await requireUser();

  const origin = checkOriginAndHost(req);
  if (!origin.ok) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  const { path } = await params;
  const bridgePath = `/${path.join("/")}`;

  if (!isPathAllowed(bridgePath)) {
    // Not on the allowlist — pretend it doesn't exist. Don't leak
    // whether the path exists on the daemon.
    return new NextResponse("Not found", { status: 404 });
  }

  let bridgeUrl: string;
  try {
    bridgeUrl = getBridgeUrl();
  } catch (err) {
    if (err instanceof RondelNotRunningError) {
      return NextResponse.json(
        { error: "Rondel is not running" },
        { status: 503 },
      );
    }
    throw err;
  }

  // Preserve query string verbatim.
  const search = req.nextUrl.search;
  const target = `${bridgeUrl}${bridgePath}${search}`;

  // Forward the request. Cache bypassed — we're proxying live state.
  try {
    const upstream = await fetch(target, {
      method: "GET",
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });

    // Stream the response body directly. We preserve content-type but
    // strip any hop-by-hop headers that might sneak in.
    const contentType =
      upstream.headers.get("content-type") ?? "application/json";
    return new NextResponse(upstream.body, {
      status: upstream.status,
      headers: { "content-type": contentType },
    });
  } catch (err) {
    // Connection refused → daemon may have restarted → invalidate cache
    // so the next call re-reads the lock.
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ECONNREFUSED") {
      invalidateBridgeUrl();
      return NextResponse.json(
        { error: "Bridge unavailable (daemon may have restarted)" },
        { status: 503 },
      );
    }
    return NextResponse.json(
      { error: "Bridge proxy failure" },
      { status: 502 },
    );
  }
}

/** All non-GET methods are 405 — mutations go through Server Actions. */
export async function POST() {
  return new NextResponse("Method not allowed", { status: 405 });
}
export async function PUT() {
  return new NextResponse("Method not allowed", { status: 405 });
}
export async function PATCH() {
  return new NextResponse("Method not allowed", { status: 405 });
}
export async function DELETE() {
  return new NextResponse("Method not allowed", { status: 405 });
}
