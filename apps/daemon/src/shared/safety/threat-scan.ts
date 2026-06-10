// Memory threat scanning (design §8.1) — prompt-injection persistence defense.
//
// Memory files are injected into every future spawn prompt, which makes them
// a PERSISTENCE vector: untrusted text (Telegram, mail) that tricks an agent
// into memorizing an instruction gets replayed forever. Mitigation, following
// Hermes: scan at write time (warn, never block the write) AND at injection
// time (mask the flagged line with a visible [BLOCKED: …] placeholder). The
// raw entry stays in the file so the user can inspect and remove it —
// silently dropping poisoned entries would hide the attack.
//
// Lives in shared/safety so config/prompt (injection masking), memory/
// (write warnings + resume block) and knowledge/ can share one
// implementation. Pure functions, no I/O.

import { scanForSecrets } from "./secret-scanner.js";

export interface ThreatMatch {
  readonly pattern: string;
  /** 1-based line number in the scanned content. */
  readonly line: number;
}

// v1 pattern table — minimal, seeded per design §8.1; extend over time.
const PATTERNS: ReadonlyArray<{ readonly name: string; readonly regex: RegExp }> = [
  { name: "instruction_override", regex: /\bignore (all |any )?(previous|prior|above) (instructions|context|rules)\b/i },
  { name: "system_prompt_override", regex: /\bdisregard (the )?(system prompt|your instructions)\b/i },
  { name: "user_concealment", regex: /\bdo not (tell|inform|alert|mention( this)? to) (the )?user\b/i },
  { name: "role_tag_smuggling", regex: /<\/?(system|assistant|developer)>/i },
  { name: "quote_frame_escape", regex: /\b(BEGIN|END)_QUOTED_NOTES\b/ },
  { name: "md_image_exfil", regex: /!\[[^\]]*\]\(https?:\/\/[^)]*[?&][^)]+\)/i },
  { name: "base64_blob", regex: /[A-Za-z0-9+/]{200,}={0,2}/ },
];

/** Scan content line-by-line for injection patterns + secrets. */
export function scanMemoryThreats(content: string): readonly ThreatMatch[] {
  const matches: ThreatMatch[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    for (const { name, regex } of PATTERNS) {
      if (regex.test(line)) {
        matches.push({ pattern: name, line: i + 1 });
        break; // one flag per line is enough
      }
    }
  }
  // Secrets are threats too — a live MEMORY.md carried a plaintext API key.
  // SecretMatch carries a char offset; convert to a 1-based line number.
  for (const secret of scanForSecrets(content)) {
    const line = content.slice(0, secret.index).split("\n").length;
    if (!matches.some((m) => m.line === line)) {
      matches.push({ pattern: "secret", line });
    }
  }
  return matches;
}

/**
 * Replace each flagged LINE with a visible placeholder. Line count is
 * preserved so the user can locate the original in the file.
 */
export function maskThreats(content: string): { masked: string; flaggedCount: number } {
  const matches = scanMemoryThreats(content);
  if (matches.length === 0) return { masked: content, flaggedCount: 0 };
  const flagged = new Map(matches.map((m) => [m.line, m.pattern]));
  const lines = content.split("\n");
  const masked = lines
    .map((line, i) => {
      const pattern = flagged.get(i + 1);
      return pattern === undefined ? line : `[BLOCKED: suspected ${pattern} — inspect the memory file to remove]`;
    })
    .join("\n");
  return { masked, flaggedCount: matches.length };
}
