// Derive the Claude CLI's own transcript path for a session.
//
// The CLI persists full-fidelity session JSONLs at:
//   ~/.claude/projects/<mangled cwd>/<sessionId>.jsonl
// where the cwd mangling replaces every non-alphanumeric character with "-"
// (verified empirically: /Users/david/.rondel → -Users-david--rondel).
//
// Forward-compute ONLY. Never reverse-mangle a projects dir name back to a
// cwd — the mangling is lossy ("-" vs "/" vs "."). Prefer the transcriptPath
// claude-wrap ≥0.1.2 reports from the SessionStart hook; this derivation is
// the fallback for sessions recorded before that (and a belt-and-braces
// check). Pinned against CLI v2.1.x behavior — re-verify on CLI upgrades.

import { join } from "node:path";
import { homedir } from "node:os";

/** Mangle a cwd the way the Claude CLI names its projects directories. */
export function mangleCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

/** CLI state dir: CLAUDE_CONFIG_DIR relocates it wholesale (env-hygiene
 *  preserves that var for exactly this reason); default ~/.claude. */
function cliConfigDir(home: string): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(home, ".claude");
}

/** Absolute path of the CLI's transcript JSONL for (cwd, sessionId). */
export function deriveCliTranscriptPath(cwd: string, sessionId: string, home: string = homedir()): string {
  return join(cliConfigDir(home), "projects", mangleCwd(cwd), `${sessionId}.jsonl`);
}

/** Absolute path of the CLI's projects dir for a cwd (auto-memory harvest). */
export function deriveCliProjectDir(cwd: string, home: string = homedir()): string {
  return join(cliConfigDir(home), "projects", mangleCwd(cwd));
}
