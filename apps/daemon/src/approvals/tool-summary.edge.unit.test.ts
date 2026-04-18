import { describe, it, expect } from "vitest";
import { summarizeToolUse } from "./tool-summary.js";

describe("summarizeToolUse — edge cases", () => {
  it("handles undefined toolInput gracefully", () => {
    const result = summarizeToolUse("Bash", undefined);
    expect(result).toBe("Bash: ");
  });

  it("handles non-object toolInput (string)", () => {
    const result = summarizeToolUse("Bash", "raw-string");
    // Falls through to asString on input.command which is undefined
    expect(result).toBe("Bash: ");
  });

  it("handles Write with empty content", () => {
    expect(summarizeToolUse("Write", { file_path: "/tmp/a.md", content: "" })).toBe(
      "Write /tmp/a.md (0B)",
    );
  });

  it("handles Write with no content field", () => {
    const result = summarizeToolUse("Write", { file_path: "/tmp/a.md" });
    expect(result).toBe("Write /tmp/a.md (0B)");
  });

  it("handles Write with no path or file_path", () => {
    const result = summarizeToolUse("Write", { content: "hello" });
    expect(result).toBe("Write  (5B)");
  });

  it("formats Read with alternate `path` field name", () => {
    expect(summarizeToolUse("Read", { path: "alt.md" })).toBe("Read alt.md");
  });

  it("handles Grep with no pattern", () => {
    expect(summarizeToolUse("Grep", {})).toBe("Grep ");
  });

  it("handles WebFetch with no url", () => {
    expect(summarizeToolUse("WebFetch", {})).toBe("WebFetch ");
  });

  it("handles WebSearch with no query", () => {
    expect(summarizeToolUse("WebSearch", {})).toBe("WebSearch ");
  });

  it("truncates unknown tool with large input", () => {
    const bigInput = { data: "x".repeat(500) };
    const result = summarizeToolUse("CustomTool", bigInput);
    expect(result.length).toBeLessThanOrEqual(200);
    expect(result.startsWith("CustomTool: ")).toBe(true);
    expect(result.endsWith("...")).toBe(true);
  });

  it("handles null values in input fields via asString", () => {
    expect(summarizeToolUse("Bash", { command: null })).toBe("Bash: ");
  });

  it("produces exact truncation boundary at 200 chars", () => {
    // command that makes summary exactly 200 chars (no truncation)
    const prefix = "Bash: ";
    const exactFit = "x".repeat(200 - prefix.length);
    const result = summarizeToolUse("Bash", { command: exactFit });
    expect(result.length).toBe(200);
    expect(result.endsWith("...")).toBe(false);

    // One more char triggers truncation
    const overBy1 = "x".repeat(200 - prefix.length + 1);
    const result2 = summarizeToolUse("Bash", { command: overBy1 });
    expect(result2.length).toBe(200);
    expect(result2.endsWith("...")).toBe(true);
  });
});
