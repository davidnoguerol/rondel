/**
 * Bash command classification.
 *
 * Called inline by the first-class `rondel_bash` MCP tool to decide
 * whether a command runs immediately or escalates to a human via the
 * HITL approval service. Pure function — no runtime imports.
 */

import type { ClassificationResult } from "./types.js";

/**
 * Destructive command patterns that require approval. Matched on a
 * lowercased command string, split into segments by `;`, `|`, `&`.
 * Each segment is tested independently so `ls && rm -rf /` escalates
 * on the second half.
 *
 * Not a full shell parser — a determined attacker can obfuscate past
 * these. The hook is a safety net, not a sandbox.
 *
 * Implementation notes:
 *  - Input is lowercased before matching, so flag characters must be
 *    lowercase (`-r`, not `-R`).
 *  - A flag-group token covers short combos (`-rfv`, `-r`) and the
 *    long-form `--recursive` / `--force` / `--no-preserve-root` flags.
 *  - The "target starts with /" alternation covers `/`, `/*`, `/etc`,
 *    `/home/...`, etc., but NOT `./local-dir`.
 */
const RM_FLAG_TOKEN = "(?:-[rfv]+|--recursive|--force|--no-preserve-root)";
const RM_TARGET_SLASH = "\\/(?:$|[\\s*\\/.a-z0-9_~-])";

const DANGEROUS_BASH_PATTERNS: readonly RegExp[] = [
  // rm targeting root: `rm -rf /`, `rm -rf /*`, `rm -rf /etc`,
  // `rm --recursive --force /`, `rm --no-preserve-root -rf /`.
  new RegExp(`\\brm\\s+(?:${RM_FLAG_TOKEN}\\s+)+${RM_TARGET_SLASH}`),
  // rm targeting home (~)
  new RegExp(`\\brm\\s+(?:${RM_FLAG_TOKEN}\\s+)+~(?:\\s|\\/|$)`),
  // rm targeting $HOME (post-lowercasing: `$home`)
  new RegExp(`\\brm\\s+(?:${RM_FLAG_TOKEN}\\s+)+\\$home\\b`),

  /\bdd\b/,
  /\bmkfs(\.\w+)?\b/,
  /\bshred\b/,

  // Recursive chown / chmod with any absolute-path target. Matches
  // `chown -R root /etc`, `chmod -R 755 /etc`, `chown --recursive a b /`,
  // but NOT local-path variants like `chmod -R 755 ./dist`.
  //
  // `(?:^|\s)` is used instead of `\b` before the flag because `-` is
  // not a word character — `\b-r` doesn't match after whitespace.
  /\bchown\b[^\n]*?(?:^|\s)(?:-[a-z]*r[a-z]*|--recursive)\b[^\n]*?\s\/(?:$|\S)/,
  /\bchmod\b[^\n]*?(?:^|\s)(?:-[a-z]*r[a-z]*|--recursive)\b[^\n]*?\s\/(?:$|\S)/,

  // Raw disk write (e.g. `echo x > /dev/sda`).
  />\s*\/dev\/sd[a-z]/,
];

/**
 * Patterns evaluated against the FULL normalized command string before
 * segment splitting. Segment splitters (`;|&`) break up commands whose
 * dangerous signature spans segments — most notably `curl | sh` and the
 * classic fork bomb. Keeping these pre-split gives them a chance to
 * match intact.
 */
const FULL_COMMAND_DANGEROUS_PATTERNS: readonly RegExp[] = [
  // curl|sh / wget|sh — match across the pipe boundary. `[^;]*` so we
  // don't jump past a semicolon-separated unrelated command.
  /\b(?:curl|wget)\b[^;]*\|\s*(?:sh|bash|zsh)\b/,
  // Classic fork bomb: `:(){ :|:& };:`
  /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;?\s*:/,
];

/**
 * System paths that escalate when used as the target of a redirection
 * (`>`, `>>`, `tee`). Writing to /tmp/foo is fine; writing to /etc/foo
 * is not.
 */
const SYSTEM_WRITE_PREFIXES: readonly string[] = [
  "/etc",
  "/usr",
  "/bin",
  "/sbin",
  "/boot",
  "/System",
  "/Library",
];

export function classifyBash(command: string): ClassificationResult {
  const normalized = command.toLowerCase();

  // Full-command patterns run first — these detect signatures that span
  // segment boundaries (pipe-to-shell, fork bomb).
  for (const pattern of FULL_COMMAND_DANGEROUS_PATTERNS) {
    if (pattern.test(normalized)) {
      return { classification: "escalate", reason: "dangerous_bash" };
    }
  }

  const segments = normalized
    .split(/[;|&]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  for (const segment of segments) {
    for (const pattern of DANGEROUS_BASH_PATTERNS) {
      if (pattern.test(segment)) {
        return { classification: "escalate", reason: "dangerous_bash" };
      }
    }
    const redirectMatch = segment.match(/(?:>|>>|\|\s*tee(?:\s+-\w+)*)\s+(\S+)/);
    if (redirectMatch) {
      const target = redirectMatch[1];
      if (SYSTEM_WRITE_PREFIXES.some((p) => target.startsWith(p))) {
        return { classification: "escalate", reason: "bash_system_write" };
      }
    }
  }

  return { classification: "allow" };
}
