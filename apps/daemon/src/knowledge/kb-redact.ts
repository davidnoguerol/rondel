// Redaction + sanitization for the knowledge domain — ONE module applied at
// BOTH boundaries (design §4.2/§8.4): index time (every row the rebuild
// writes) and read time (every line the recall surface returns, including
// spill files). At least one live MEMORY.md contains a plaintext API key
// today — the memory collection is redacted too, not just sessions.
//
// Pure functions, no I/O.

interface RedactRule {
  readonly kind: string;
  readonly re: RegExp;
  /** When set, only this capture group is replaced (generic key=value rule). */
  readonly valueGroup?: number;
}

// Order matters: PEM first (multiline), generic key/value last.
const RULES: readonly RedactRule[] = [
  { kind: "pem", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { kind: "aws", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: "api-key", re: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  { kind: "github", re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { kind: "github", re: /\bgithub_pat_\w{20,}\b/g },
  { kind: "slack", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: "telegram", re: /\b\d{8,10}:[A-Za-z0-9_-]{30,}\b/g },
  { kind: "bearer", re: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g },
  { kind: "base64", re: /\bdata:[^;\s]+;base64,\S+/g },
  { kind: "base64", re: /\b[A-Za-z0-9+/]{200,}={0,2}\b/g },
  // Generic key/value — redact the value only, keep the key for searchability.
  { kind: "secret", re: /\b(api[\s_-]?key|secret|token|password)\b(\s*[:=]\s*)(\S{12,})/gi, valueGroup: 3 },
];

/** Replace secret-shaped content with [REDACTED:<kind>] markers. Idempotent. */
export function redactText(text: string): string {
  let out = text;
  for (const rule of RULES) {
    if (rule.valueGroup !== undefined) {
      out = out.replace(rule.re, (_m, key: string, sep: string) => `${key}${sep}[REDACTED:${rule.kind}]`);
    } else {
      out = out.replace(rule.re, `[REDACTED:${rule.kind}]`);
    }
  }
  return out;
}

/**
 * Strip the inter-agent / subagent delivery envelopes from a user entry,
 * returning the inner content. Unmatched entries pass through verbatim —
 * cron prompts are indexed as-is (they ARE the user turn of a cron run;
 * dropping them would orphan the assistant replies in recall). The null
 * return is reserved for a future entry kind that is pure machinery.
 *
 * SECURITY INVARIANT: this function decides per-entry on the entry's OWN
 * content only. It must never cause an *assistant* entry to be dropped based
 * on a preceding user entry — that pattern is a prompt-injection suppression
 * vector (a user could prefix text to hide assistant replies from recall).
 */
export function stripMachineryEnvelope(text: string): string | null {
  // Inter-agent mail wrapper (index.ts delivery + bridge send path).
  const mail = /^\[Message from [^\]]+\]\n\n([\s\S]*?)\n\n\[End of message\.[^\]]*\]$/.exec(text.trim());
  if (mail) return mail[1]!;

  // Subagent result wrapper.
  const sub = /^\[Subagent result — [^\]]+\]\n\n([\s\S]*?)\n\n\[End of subagent result\.[^\]]*\]$/.exec(text.trim());
  if (sub) return sub[1]!;

  return text;
}

/** False for content that would pollute the index (binary-ish blobs). */
export function isIndexableText(text: string): boolean {
  if (text.trim().length === 0) return false;
  // A contiguous ≥400-char base64-ish run with no whitespace = pasted blob.
  // (Whitespace-containing prose of any length stays indexable.)
  if (/[A-Za-z0-9+/=]{400,}/.test(text) && text.trim().split(/\s+/).some((tok) => tok.length >= 400)) return false;
  return true;
}
