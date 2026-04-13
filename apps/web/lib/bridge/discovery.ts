/**
 * Bridge URL discovery — reads the Rondel instance lock file and resolves
 * the HTTP URL of the running daemon's internal bridge.
 *
 * ## What this module does
 *
 * The Rondel daemon writes an instance lock at `$RONDEL_HOME/state/rondel.lock`
 * on startup. The lock contains:
 *
 *     { pid: number, startedAt: number, bridgeUrl: string, logPath: string }
 *
 * The bridge listens on `127.0.0.1` with a random OS-assigned port. To talk
 * to the bridge we must read this file, verify the daemon is still alive,
 * and return the URL.
 *
 * ## Stale-PID detection
 *
 * The lock file can exist with a dead PID (kill -9, crash without cleanup,
 * reboot without shutdown hook). `existsSync` alone is not enough — we use
 * `process.kill(pid, 0)` as a liveness check, which throws ESRCH if the PID
 * does not belong to a running process. This matches the daemon's own
 * `readInstanceLock()` helper; we re-implement rather than import so that
 * the web package has zero runtime dependency on daemon code.
 *
 * ## Caching
 *
 * We cache the resolved URL for 5 seconds at module scope to avoid reading
 * the file on every bridge call within an RSC render. The cache is
 * invalidated by `invalidateBridgeUrl()` — which callers do on `ECONNREFUSED`
 * so that a daemon restart (which assigns a new random port) is recovered
 * in one retry instead of 5s of dead calls.
 */
import "server-only";

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import { RondelNotRunningError } from "./errors";

interface LockData {
  readonly pid: number;
  readonly startedAt: number;
  readonly bridgeUrl: string;
  readonly logPath: string;
}

interface CachedResolution {
  readonly lock: LockData;
  readonly expiresAt: number;
}

/**
 * Module-scope cache. Next dev mode re-imports modules on code change, so
 * the cache also resets automatically after edits.
 */
let cached: CachedResolution | null = null;

/** 5 seconds — long enough to absorb a burst of calls, short enough to pick
 *  up a daemon restart without manual action. */
const TTL_MS = 5_000;

function resolveRondelHome(): string {
  return process.env.RONDEL_HOME ?? join(homedir(), ".rondel");
}

function lockPath(): string {
  return join(resolveRondelHome(), "state", "rondel.lock");
}

/**
 * Parse and liveness-check the lock file. Returns null on any failure so
 * the caller can raise `RondelNotRunningError` with a consistent message.
 */
function readLock(): LockData | null {
  let raw: string;
  try {
    raw = readFileSync(lockPath(), "utf-8");
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) return null;
  const data = parsed as Partial<LockData>;
  if (
    typeof data.pid !== "number" ||
    typeof data.startedAt !== "number" ||
    typeof data.bridgeUrl !== "string" ||
    typeof data.logPath !== "string" ||
    data.bridgeUrl.length === 0
  ) {
    return null;
  }

  // Liveness check — signal 0 returns successfully if the PID is alive
  // and owned by a process the current user can signal. Throws ESRCH
  // if the PID does not belong to any running process. EPERM means the
  // process exists but we cannot signal it — we treat that as alive too.
  try {
    process.kill(data.pid, 0);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM") {
      // Process exists, different user — treat as alive
      return data as LockData;
    }
    // ESRCH or anything else — stale lock
    return null;
  }

  return data as LockData;
}

/**
 * Get the bridge URL, using the TTL cache when possible.
 * Throws `RondelNotRunningError` if the daemon is not running.
 */
export function getBridgeUrl(): string {
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return cached.lock.bridgeUrl;
  }

  const lock = readLock();
  if (!lock) {
    cached = null;
    throw new RondelNotRunningError();
  }

  cached = { lock, expiresAt: now + TTL_MS };
  return lock.bridgeUrl;
}

/**
 * Clear the cache. Call this when a bridge request fails with
 * ECONNREFUSED — the daemon may have restarted with a new port, and we
 * want the next `getBridgeUrl()` to re-read the lock immediately instead
 * of serving the stale cached URL for up to TTL_MS.
 */
export function invalidateBridgeUrl(): void {
  cached = null;
}
