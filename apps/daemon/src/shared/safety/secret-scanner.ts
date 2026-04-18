/**
 * Heuristic scanner for leaked credentials in arbitrary content.
 *
 * Pure function — no runtime imports. Used (from Phase 3 onwards) by the
 * filesystem tool suite to refuse writes/edits whose content looks like
 * a leaked secret.
 *
 * Intentionally conservative: false positives escalate to a human, false
 * negatives quietly proceed. We optimize for readability of the pattern
 * table, not for catching every possible token format.
 */

export interface SecretMatch {
  readonly pattern: string;
  readonly index: number;
  readonly length: number;
}

interface NamedPattern {
  readonly name: string;
  readonly regex: RegExp;
}

const PATTERNS: readonly NamedPattern[] = [
  { name: "aws_access_key_id", regex: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "aws_secret_key_assign", regex: /aws_secret_access_key\s*=\s*[^\s]+/gi },
  { name: "github_token", regex: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { name: "openai_key", regex: /\bsk-[A-Za-z0-9]{48,}\b/g },
  { name: "telegram_bot_token", regex: /\b\d{9,10}:[A-Za-z0-9_-]{35}\b/g },
  { name: "private_key_header", regex: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |)PRIVATE KEY-----/g },
];

export function scanForSecrets(content: string): readonly SecretMatch[] {
  if (!content) return [];

  const matches: SecretMatch[] = [];
  for (const { name, regex } of PATTERNS) {
    // Fresh RegExp state per call — callers share one global PATTERNS list.
    const re = new RegExp(regex.source, regex.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      matches.push({ pattern: name, index: m.index, length: m[0].length });
      // Guard against zero-length matches looping forever.
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  }
  return matches;
}
