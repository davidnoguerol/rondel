/**
 * Shared fetch wrapper for bridge calls.
 *
 * Responsibilities:
 *   1. One `undici.Agent` with keepAlive so multiple bridge calls from a
 *      single RSC render share a TCP connection. Without this, a page that
 *      fires four server-side fetches eats ~50ms of reconnection overhead.
 *   2. A 10-second `AbortSignal.timeout` on every call — slow bridge
 *      responses fail fast rather than hanging the render. 10s is
 *      generous (bridge calls typically return in single-digit ms).
 *   3. Classification of errors into transient (retryable) vs permanent.
 *      Matches the daemon's own convention.
 *   4. Automatic retry on `ECONNREFUSED` — when the daemon has restarted
 *      and the cached bridge URL points at a dead port. One retry with
 *      cache invalidation. If the second attempt also refuses, we surface
 *      `RondelNotRunningError`.
 *
 * Everything under `lib/bridge/client.ts` goes through `bridgeFetch`.
 * No other file in the web package should call `fetch` against the bridge
 * directly — it's how we keep error handling consistent.
 */
import "server-only";

import { Agent, setGlobalDispatcher } from "undici";

import { getBridgeUrl, invalidateBridgeUrl } from "./discovery";
import {
  BridgeError,
  RondelNotRunningError,
} from "./errors";

// Install a keepalive dispatcher globally so `fetch()` (which uses undici
// under the hood in Node) reuses connections. One shared agent is fine —
// we only ever talk to 127.0.0.1:<bridge-port>.
const keepAliveAgent = new Agent({
  keepAliveTimeout: 10_000,
  keepAliveMaxTimeout: 30_000,
});
setGlobalDispatcher(keepAliveAgent);

/** Per-call timeout in milliseconds. */
const REQUEST_TIMEOUT_MS = 10_000;

export interface BridgeFetchOptions {
  readonly method?: "GET" | "PUT" | "POST" | "PATCH" | "DELETE";
  readonly body?: unknown;
  /** Cache tags for Next's fetch cache. Used by Server Actions to
   *  revalidate surgically via `revalidateTag()`. */
  readonly tags?: readonly string[];
}

/**
 * Fetch a bridge endpoint. The `path` must start with `/`.
 * Returns the parsed JSON response (`unknown` — validate with Zod in the
 * caller).
 */
export async function bridgeFetch(
  path: string,
  opts: BridgeFetchOptions = {},
): Promise<unknown> {
  // One retry on ECONNREFUSED — handles the case where the daemon was
  // restarted and bound a new random port.
  for (let attempt = 0; attempt < 2; attempt++) {
    const url = `${getBridgeUrl()}${path}`;

    try {
      const response = await fetch(url, {
        method: opts.method ?? "GET",
        headers: opts.body
          ? { "content-type": "application/json" }
          : undefined,
        body: opts.body ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        // `cache: 'no-store'` is explicit documentation of intent —
        // Next 14 caches fetch by default, Next 15 does not. We never
        // want the bridge cached, so we say so every time.
        cache: "no-store",
        next: opts.tags ? { tags: [...opts.tags] } : undefined,
      });

      if (!response.ok) {
        // 4xx = permanent (bad request, not found), 5xx = transient
        throw new BridgeError(
          `Bridge returned ${response.status} for ${opts.method ?? "GET"} ${path}`,
          {
            status: response.status,
            transient: response.status >= 500,
          },
        );
      }

      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("application/json")) {
        throw new BridgeError(
          `Bridge returned non-JSON content-type for ${path}: ${contentType}`,
          { status: response.status, transient: false },
        );
      }

      return (await response.json()) as unknown;
    } catch (err) {
      // Detect connection refused — means the cached URL is dead.
      // We invalidate and retry once. If the second attempt also fails,
      // the `readLock()` inside `getBridgeUrl()` will raise
      // `RondelNotRunningError` itself (if the daemon really is gone)
      // or we rethrow here if it's a different class of failure.
      if (attempt === 0 && isConnectionRefused(err)) {
        invalidateBridgeUrl();
        continue;
      }

      // `RondelNotRunningError` bubbles up unchanged. So does BridgeError.
      if (err instanceof RondelNotRunningError || err instanceof BridgeError) {
        throw err;
      }

      // AbortError, network error, DNS failure — classify as transient.
      const message = err instanceof Error ? err.message : String(err);
      throw new BridgeError(
        `Bridge fetch failed for ${path}: ${message}`,
        { status: 0, transient: true },
      );
    }
  }

  // Unreachable — loop either returns or throws.
  throw new BridgeError("Bridge fetch exhausted retries", {
    status: 0,
    transient: true,
  });
}

/**
 * Heuristic for detecting ECONNREFUSED. Node wraps it several ways
 * depending on the fetch runtime (undici vs. node-fetch vs. native).
 * We check multiple surfaces.
 */
function isConnectionRefused(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const anyErr = err as {
    code?: string;
    cause?: { code?: string };
    message?: string;
  };
  if (anyErr.code === "ECONNREFUSED") return true;
  if (anyErr.cause?.code === "ECONNREFUSED") return true;
  if (typeof anyErr.message === "string" && anyErr.message.includes("ECONNREFUSED")) {
    return true;
  }
  return false;
}
