import { readFileSync } from "node:fs";

/**
 * Load a .env file into process.env.
 *
 * Simple KEY=VALUE parser — no multiline, no interpolation, no external deps.
 * Environment variables already set take precedence (won't overwrite).
 * Silently skips if the file doesn't exist.
 */
export function loadEnvFile(envPath: string): void {
  let content: string;
  try {
    content = readFileSync(envPath, "utf-8");
  } catch {
    return; // File doesn't exist — nothing to load
  }

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;

    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();

    // Don't overwrite existing env vars — explicit environment takes precedence
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}
