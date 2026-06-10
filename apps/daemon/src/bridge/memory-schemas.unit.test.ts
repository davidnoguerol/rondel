import { describe, it, expect } from "vitest";
import { MemoryAppendInputSchema, MemoryReplaceInputSchema, MemoryRemoveInputSchema } from "./schemas.js";

describe("MemoryAppendInputSchema", () => {
  it("accepts index/daily/topic targets and rejects malformed ones", () => {
    expect(MemoryAppendInputSchema.safeParse({ entry: "fact" }).success).toBe(true);
    expect(MemoryAppendInputSchema.safeParse({ entry: "fact", target: "daily" }).success).toBe(true);
    expect(MemoryAppendInputSchema.safeParse({ entry: "fact", target: "topic:flint-pricing" }).success).toBe(true);
    expect(MemoryAppendInputSchema.safeParse({ entry: "fact", target: "topic:../escape" }).success).toBe(false);
    expect(MemoryAppendInputSchema.safeParse({ entry: "fact", target: "topic:Upper" }).success).toBe(false);
    expect(MemoryAppendInputSchema.safeParse({ entry: "" }).success).toBe(false);
    expect(MemoryAppendInputSchema.safeParse({ entry: "x".repeat(501) }).success).toBe(false);
  });
});

describe("MemoryReplace/RemoveInputSchema", () => {
  it("requires a match of at least 3 chars", () => {
    expect(MemoryReplaceInputSchema.safeParse({ match: "ab", entry: "x" }).success).toBe(false);
    expect(MemoryReplaceInputSchema.safeParse({ match: "abc", entry: "x" }).success).toBe(true);
    expect(MemoryRemoveInputSchema.safeParse({ match: "abc" }).success).toBe(true);
  });
});
