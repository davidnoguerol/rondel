// Environment hygiene + CLI version gate for spawned Claude CLI processes.
//
// Why this exists (both verified against the official changelog, June 2026):
//
// 1. CLI v2.1.170 fixed a bug where "sessions launched from a shell that
//    inherited Claude Code environment variables failed to save transcripts"
//    (and didn't appear in --resume). A daemon started from inside a Claude
//    Code session (a common dev loop) inherits CLAUDE*-prefixed vars and
//    silently loses the transcript substrate everything here builds on.
//    We scrub INHERITED CLAUDE* vars from the daemon's own process.env at
//    startup, before any spawn. Deliberate per-spawn vars (auto-memory
//    disable, compaction tunables) are set explicitly afterwards via
//    claude-wrap's SessionOptions.env, which is additive.
//
//    CLAUDE_CODE_OAUTH_TOKEN is preserved — it IS the subscription token for
//    daemon use (claude-wrap's scrub list preserves it for the same reason).
//    CLAUDE_CONFIG_DIR is preserved too: it relocates the CLI's whole state
//    dir (including projects/ transcripts), which the operator set on
//    purpose; scrubbing it would silently split CLI state across two homes.
//
// 2. The substrate depends on version-gated CLI behavior: PostCompact
//    (v2.1.76), auto-memory + its disable env (v2.1.59), statusLine context
//    fields (v2.1.132), the env-inheritance transcript fix (v2.1.170). Below
//    the minimum we degrade LOUDLY (error log) — agents still run, but the
//    operator is told the memory substrate is compromised.

import { execFile } from "node:child_process";
import type { Logger } from "../shared/logger.js";

export const MIN_CLI_VERSION = "2.1.170";

const PRESERVED = new Set(["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR"]);

/**
 * Remove inherited CLAUDE*-prefixed vars from an env object (default:
 * process.env). Returns the names removed, for logging.
 */
export function scrubInheritedClaudeEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const removed: string[] = [];
  for (const key of Object.keys(env)) {
    if (!key.startsWith("CLAUDE")) continue;
    if (PRESERVED.has(key)) continue;
    delete env[key];
    removed.push(key);
  }
  return removed;
}

/**
 * Rondel's intentional per-spawn CLI vars, passed via claude-wrap's
 * `SessionOptions.env` (additive over the scrubbed daemon env):
 * - CLAUDE_CODE_DISABLE_AUTO_MEMORY: the CLI's native auto-memory (default-on
 *   since v2.1.59) would compete in-context with Rondel's curated memory and
 *   write to a cwd-shared dir. Disabled per design D3 (content harvested
 *   first — see transcripts/auto-memory-harvest.ts).
 */
export function claudeSpawnEnv(): Record<string, string> {
  return { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" };
}

/** Parse "x.y.z" out of `claude --version` output. */
export function parseCliVersion(output: string): string | undefined {
  return /(\d+\.\d+\.\d+)/.exec(output)?.[1];
}

/** Numeric semver comparison: negative if a < b. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Check the installed CLI version against MIN_CLI_VERSION and log loudly on
 * mismatch. Non-blocking and never throws — a missing CLI surfaces at first
 * spawn with a clearer error anyway.
 */
export function checkCliVersion(log: Logger, minVersion: string = MIN_CLI_VERSION): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile("claude", ["--version"], { timeout: 10_000 }, (err, stdout) => {
      if (err) {
        log.warn(`CLI version check failed (${err.message}) — cannot verify >=${minVersion}`);
        resolve(undefined);
        return;
      }
      const version = parseCliVersion(stdout);
      if (!version) {
        log.warn(`CLI version unparseable from "${stdout.trim().slice(0, 80)}" — cannot verify >=${minVersion}`);
        resolve(undefined);
        return;
      }
      if (compareVersions(version, minVersion) < 0) {
        log.error(
          `Claude CLI ${version} is below the supported minimum ${minVersion}. ` +
            `Transcript capture, compaction summaries, and auto-memory control may silently misbehave — upgrade the CLI.`,
        );
      } else {
        log.info(`Claude CLI ${version} (>= ${minVersion})`);
      }
      resolve(version);
    });
  });
}
