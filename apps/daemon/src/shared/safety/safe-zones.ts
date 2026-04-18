/**
 * Safe-zone path classification for Write/Edit/MultiEdit.
 *
 * Pure path math — only `node:path` built-ins. No process.env reads, no
 * filesystem access. Caller supplies the safe-zone context explicitly so
 * the same classifier works inside the daemon and inside the hook bundle.
 */

import { isAbsolute, resolve, sep } from "node:path";

export interface SafeZoneContext {
  /** Absolute path to the agent's own workspace. Undefined for e.g. subagents. */
  readonly agentDir?: string;
  /** Absolute path to `$HOME/.rondel/workspaces`. */
  readonly rondelHome: string;
}

/**
 * Is `path` inside any safe zone?
 *
 * Safe zones:
 *  - under `ctx.agentDir` (if set)
 *  - under `ctx.rondelHome`
 *  - exactly `/tmp`, or under `/tmp/`
 *
 * Relative paths are resolved against `process.cwd()` before the check —
 * callers are expected to pass absolute paths whenever possible.
 *
 * We compare string paths without symlink resolution: a symlinked `/tmp`
 * on macOS (→ `/private/tmp`) is still matched via its literal prefix.
 * This is a safety net, not a sandbox. `..` segments are normalised via
 * `resolve`, so `/tmp/../etc/foo` is correctly flagged as unsafe.
 */
export function isPathInSafeZone(path: string, ctx: SafeZoneContext): boolean {
  const abs = isAbsolute(path) ? resolve(path) : resolve(process.cwd(), path);

  if (ctx.agentDir && isUnder(abs, ctx.agentDir)) return true;
  if (isUnder(abs, ctx.rondelHome)) return true;
  if (abs === "/tmp" || abs.startsWith("/tmp" + sep)) return true;

  return false;
}

function isUnder(path: string, parent: string): boolean {
  const p = resolve(parent);
  if (path === p) return true;
  return path.startsWith(p + sep);
}
