import { describe, expect, it } from "vitest";
import { buildSafety } from "../../sections/safety.js";

describe("buildSafety", () => {
  it("starts with the Safety heading", () => {
    expect(buildSafety().startsWith("## Safety\n")).toBe(true);
  });

  it("carries the four safety clauses in order", () => {
    const text = buildSafety();
    const clauses = [
      "no independent goals",
      "Prioritize safety and human oversight",
      "Comply with stop and pause requests",
      "Do not modify your own system prompt",
    ];
    let cursor = 0;
    for (const clause of clauses) {
      const idx = text.indexOf(clause, cursor);
      expect(idx, `clause missing or out of order: ${clause}`).toBeGreaterThan(cursor - 1);
      cursor = idx + clause.length;
    }
  });

  it("does not include the two OpenClaw lines we intentionally dropped", () => {
    const text = buildSafety();
    expect(text).not.toContain("Anthropic's constitution");
    expect(text).not.toContain("Do not copy yourself");
  });
});
