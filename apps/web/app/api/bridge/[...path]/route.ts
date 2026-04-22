/**
 * Browser-facing proxy to the Rondel bridge.
 *
 * =============================================================================
 * RULES (keep this file small and obviously-correct)
 * =============================================================================
 *
 * 1. Two GET allowlists, no blocklists.
 *    `GET_ALLOWLIST` is the request-response surface — short-lived calls
 *    that get a 10-second timeout and return JSON.
 *    `SSE_ALLOWLIST` is the streaming surface — long-lived SSE responses
 *    where the timeout MUST be removed and the client's abort signal
 *    forwarded upstream so disconnect propagates to the daemon.
 *    Allowlists, never blocklists: the moment someone adds a new admin
 *    GET to the daemon, a blocklist would silently expose it.
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
 *    (a) be added to the appropriate allowlist below if clients need to
 *        refetch it,
 *    (b) have a method on `lib/bridge/client.ts` for server-side reads,
 *    (c) never reinvent validation, auth, or retry here.
 */
import { NextResponse, type NextRequest } from "next/server";

import { getBridgeUrl } from "@/lib/bridge/discovery";
import { invalidateBridgeUrl } from "@/lib/bridge/discovery";
import { RondelNotRunningError } from "@/lib/bridge";
import { requireUser } from "@/lib/auth/require-user";

// Allowlists + matcher live in a sibling module so they can be exported
// for unit tests without violating Next's "route handler files export
// only HTTP method functions" convention. See ./allowlist.ts.
import {
  GET_ALLOWLIST,
  POST_ALLOWLIST,
  SSE_ALLOWLIST,
  matchesAllowlist,
} from "./allowlist";

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

  // Decide which surface this request belongs to. SSE paths get
  // long-lived treatment; everything else goes through the standard
  // request-response path with a short timeout. A path on neither
  // list returns 404 — we don't leak which paths exist on the daemon.
  const isStream = matchesAllowlist(bridgePath, SSE_ALLOWLIST);
  const isShortLived = matchesAllowlist(bridgePath, GET_ALLOWLIST);
  if (!isStream && !isShortLived) {
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

  // Build the fetch options based on whether this is a stream or a
  // short-lived request. The two differences are critical:
  //
  //   1. Short-lived: AbortSignal.timeout(10_000) — fail fast on a
  //      hung daemon.
  //   2. Streaming:   forward req.signal — when the browser closes the
  //      EventSource, the abort propagates upstream and the daemon's
  //      `req.on("close")` fires its cleanup. Without this, the daemon
  //      keeps writing to a dead socket until the heartbeat fails.
  //
  // Both cases stream the response body via `new NextResponse(upstream.body, ...)`,
  // which passes the ReadableStream through without buffering.
  const fetchSignal = isStream
    ? req.signal
    : AbortSignal.timeout(10_000);

  try {
    const upstream = await fetch(target, {
      method: "GET",
      cache: "no-store",
      signal: fetchSignal,
    });

    const contentType =
      upstream.headers.get("content-type") ?? "application/json";
    return new NextResponse(upstream.body, {
      status: upstream.status,
      headers: { "content-type": contentType },
    });
  } catch (err) {
    // Client-initiated abort on a stream is normal, not an error.
    // (Browser tab closed, navigation away, etc.)
    if (isStream && req.signal.aborted) {
      return new NextResponse(null, { status: 499 });
    }

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

/**
 * Tightly-scoped POST proxy.
 *
 * Only `POST_ALLOWLIST` paths are forwarded — everything else is 405. The
 * body is streamed verbatim to the bridge (`AbortSignal.timeout(10_000)`),
 * and the JSON response is returned unmodified. Loopback + origin checks
 * run first, same as GET.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
): Promise<NextResponse> {
  await requireUser();

  const origin = checkOriginAndHost(req);
  if (!origin.ok) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  const { path } = await params;
  const bridgePath = `/${path.join("/")}`;

  if (!matchesAllowlist(bridgePath, POST_ALLOWLIST)) {
    return new NextResponse("Method not allowed", { status: 405 });
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

  const target = `${bridgeUrl}${bridgePath}${req.nextUrl.search}`;
  const body = await req.text();

  try {
    const upstream = await fetch(target, {
      method: "POST",
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
      headers: { "content-type": "application/json" },
      body,
    });

    const contentType =
      upstream.headers.get("content-type") ?? "application/json";
    return new NextResponse(upstream.body, {
      status: upstream.status,
      headers: { "content-type": contentType },
    });
  } catch (err) {
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

export async function PUT() {
  return new NextResponse("Method not allowed", { status: 405 });
}
export async function PATCH() {
  return new NextResponse("Method not allowed", { status: 405 });
}
export async function DELETE() {
  return new NextResponse("Method not allowed", { status: 405 });
}
