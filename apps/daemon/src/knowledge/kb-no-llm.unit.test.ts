/**
 * Regression pin: the recall read path contains NO LLM and NO process
 * spawning (design D5; Hermes deliberately removed its LLM-summary recall
 * mode as a hallucination vector and pins the same promise with a test).
 *
 * (a) Static import-boundary check over the knowledge domain sources.
 * (b) The verbatim contract itself is exercised end-to-end by
 *     kb-service.integration.test.ts (every returned text is byte-identical
 *     to a redacted source row).
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DOMAIN_DIR = dirname(fileURLToPath(import.meta.url));

const FORBIDDEN_IMPORTS = [
  /from\s+"claude-wrap"/,
  /from\s+"\.\.\/agents\//,
  /from\s+"node:child_process"/,
  /spawn\(/,
  /execFile/,
];

describe("knowledge domain read-path purity", () => {
  it("no source file imports an LLM runner, agent process, or child_process", () => {
    const sources = readdirSync(DOMAIN_DIR).filter((f) => f.endsWith(".ts") && !f.includes(".test."));
    expect(sources.length).toBeGreaterThanOrEqual(6);
    for (const file of sources) {
      const content = readFileSync(join(DOMAIN_DIR, file), "utf-8");
      for (const pattern of FORBIDDEN_IMPORTS) {
        expect(content, `${file} must not match ${pattern}`).not.toMatch(pattern);
      }
    }
  });
});
