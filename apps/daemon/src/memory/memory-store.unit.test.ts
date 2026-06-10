import { describe, it, expect } from "vitest";
import { parseIndex, serializeIndex, roundTrips, topicPath, dailyPath } from "./memory-store.js";

describe("parseIndex", () => {
  it("parses canonical one-line-per-fact content, tolerating blank lines", () => {
    const parsed = parseIndex("- [2026-06-01] fact one\n\n- fact two\n");
    expect(parsed).toEqual({ entries: ["[2026-06-01] fact one", "fact two"] });
  });

  it("returns null for legacy prose (headings, paragraphs, continuations)", () => {
    expect(parseIndex("# Neo's Memory\n## Role\nI am Neo.")).toBeNull();
    expect(parseIndex("- entry\n  continuation line")).toBeNull();
    expect(parseIndex("just prose")).toBeNull();
  });

  it("treats empty/missing content as a canonical empty index", () => {
    expect(parseIndex("")).toEqual({ entries: [] });
    expect(parseIndex("\n\n")).toEqual({ entries: [] });
  });
});

describe("serializeIndex / roundTrips", () => {
  it("round-trips entries through serialize → parse", () => {
    const entries = ["[2026-06-01] a", "b"];
    expect(parseIndex(serializeIndex(entries))).toEqual({ entries });
    expect(serializeIndex([])).toBe("");
    expect(roundTrips(serializeIndex(entries))).toBe(true);
    expect(roundTrips("## heading")).toBe(false);
  });
});

describe("path guards", () => {
  it("rejects traversal and uppercase in topic slugs", () => {
    expect(() => topicPath("/a", "../escape")).toThrow();
    expect(() => topicPath("/a", "Upper")).toThrow();
    expect(() => topicPath("/a", "ok-slug")).not.toThrow();
  });

  it("rejects malformed dates", () => {
    expect(() => dailyPath("/a", "2026-6-1")).toThrow();
    expect(() => dailyPath("/a", "../../etc")).toThrow();
    expect(() => dailyPath("/a", "2026-06-01")).not.toThrow();
  });
});
