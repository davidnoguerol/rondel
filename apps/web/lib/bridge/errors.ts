/**
 * Error types for the bridge client seam.
 *
 * =============================================================================
 * CRITICAL — READ BEFORE ADDING A NEW ERROR CLASS
 * =============================================================================
 *
 * React Server Components serialize thrown errors across the RSC boundary.
 * Only `message`, `digest`, and `name` survive the trip to `error.tsx`.
 * Custom properties like `transient`, `status`, or `cause` DO NOT reach the
 * client error boundary.
 *
 * This means: in error.tsx we MUST branch on `error.name`, never on
 * `instanceof` or custom props. Every error class in this file sets `name`
 * to a stable, unique string. Do the same for any new class you add here.
 *
 * If you need a custom property to flow to the client, encode it into the
 * `message` (machine-parseable prefix, e.g. "[v=2] Mismatch") or, better,
 * into the error `name` as a distinct class. That is the boundary contract.
 * =============================================================================
 */

/**
 * Generic bridge failure — HTTP 4xx/5xx or parse error from a bridge call.
 *
 * `transient` classification lives here for code that catches the error
 * in server-side code (e.g. automatic retry logic in `fetcher.ts`). It is
 * NOT available on the client side of a Server Component boundary.
 */
export class BridgeError extends Error {
  readonly status: number;
  readonly transient: boolean;

  constructor(message: string, opts: { status: number; transient: boolean }) {
    super(message);
    this.name = "BridgeError";
    this.status = opts.status;
    this.transient = opts.transient;
  }
}

/**
 * The daemon is not reachable — either the lock file is missing, the lock
 * points at a stale PID, or the bridge URL refuses connections and a
 * re-read still did not recover.
 *
 * The client error boundary should render a friendly "Rondel is not running"
 * page and suggest running `rondel start`.
 */
export class RondelNotRunningError extends Error {
  constructor(detail?: string) {
    const base = "Rondel is not running. Start it with `rondel start`.";
    super(detail ? `${base} (${detail})` : base);
    this.name = "RondelNotRunningError";
  }
}

/**
 * The daemon's bridge API version is lower than the web client expects.
 * Thrown by the first bridge call per request (see `client.ts` version
 * handshake). The web client is too new for this daemon.
 */
export class BridgeVersionMismatchError extends Error {
  constructor(expected: number, actual: number) {
    super(
      `Bridge API version mismatch: web expects ${expected}, daemon provides ${actual}. Upgrade the Rondel daemon.`,
    );
    this.name = "BridgeVersionMismatchError";
  }
}

/**
 * Response body from the daemon failed Zod validation. This almost always
 * means the daemon and web package are out of sync — same symptom as a
 * version mismatch, but more granular. Logged server-side with the
 * underlying Zod issues for diagnosis.
 */
export class BridgeSchemaError extends Error {
  constructor(endpoint: string, issues: string) {
    super(`Bridge response schema mismatch at ${endpoint}: ${issues}`);
    this.name = "BridgeSchemaError";
  }
}
