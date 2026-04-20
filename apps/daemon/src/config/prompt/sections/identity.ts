/**
 * Framework identity line — the first thing every agent reads.
 *
 * Framework-owned: users cannot remove this by editing bootstrap files.
 * Kept deliberately terse. Rondel is identified as the framework the
 * agent runs inside; the rest of identity (name, vibe) comes from
 * IDENTITY.md below.
 */

export function buildIdentity(): string {
  return "You are a personal assistant running inside Rondel.";
}
