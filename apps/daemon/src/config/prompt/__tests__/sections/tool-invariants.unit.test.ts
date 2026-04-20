import { describe, expect, it } from "vitest";
import { buildToolInvariants } from "../../sections/tool-invariants.js";

// This section reads templates/framework-context/TOOLS.md from disk —
// technically an integration test, but it's a single deterministic file
// read with no fixtures, so it fits the unit-test shape. Keeping it here
// keeps the section's test colocated with its implementation.
describe("buildToolInvariants", () => {
  it("loads the shipped TOOLS.md and preserves its invariant clauses", async () => {
    const text = await buildToolInvariants();
    expect(text).not.toBeNull();
    expect(text).toContain("## Tool invariants");
    expect(text).toContain("are disallowed");
    expect(text).toContain("rondel_schedule_");
  });

  it("trims trailing whitespace so the assembler's \\n\\n joiner produces exactly one blank line", async () => {
    const text = await buildToolInvariants();
    expect(text).not.toBeNull();
    expect(text!.endsWith("\n")).toBe(false);
  });
});
