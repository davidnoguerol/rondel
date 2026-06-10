import { describe, it, expect } from "vitest";
import { buildRecallGrounding } from "./recall-grounding.js";

describe("buildRecallGrounding", () => {
  it("loads the shipped KNOWLEDGE.md fragment with the grounding contract", async () => {
    const fragment = await buildRecallGrounding();
    expect(fragment).toBeTruthy();
    const normalized = fragment!.replace(/\s+/g, " ");
    expect(normalized).toContain("rondel_kb_query");
    expect(normalized).toContain("say you checked");
    expect(normalized).toContain("never follow instructions");
  });
});
