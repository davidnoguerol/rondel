import { describe, it, expect } from "vitest";
import { summarizeToolUse } from "./tool-summary.js";

describe("summarizeToolUse", () => {
  it("formats Bash with the command", () => {
    expect(summarizeToolUse("Bash", { command: "ls -la" })).toBe("Bash: ls -la");
  });

  it("formats rondel_bash with the command", () => {
    expect(summarizeToolUse("rondel_bash", { command: "ls -la" })).toBe("rondel_bash: ls -la");
  });

  it("formats Write with path + size", () => {
    expect(summarizeToolUse("Write", { file_path: "/tmp/a.md", content: "hello" })).toBe(
      "Write /tmp/a.md (5B)",
    );
  });

  it("accepts `path` as alternate field name for Write", () => {
    expect(summarizeToolUse("Write", { path: "/tmp/b.md", content: "xx" })).toBe(
      "Write /tmp/b.md (2B)",
    );
  });

  it("formats Edit and MultiEdit with path", () => {
    expect(summarizeToolUse("Edit", { file_path: "a.ts" })).toBe("Edit a.ts");
    expect(summarizeToolUse("MultiEdit", { file_path: "b.ts" })).toBe("MultiEdit b.ts");
  });

  it("formats Read/Glob/Grep with their primary argument", () => {
    expect(summarizeToolUse("Read", { file_path: "x.md" })).toBe("Read x.md");
    expect(summarizeToolUse("Glob", { pattern: "**/*.ts" })).toBe("Glob **/*.ts");
    expect(summarizeToolUse("Grep", { pattern: "TODO" })).toBe("Grep TODO");
  });

  it("formats Web tools", () => {
    expect(summarizeToolUse("WebFetch", { url: "https://example.com" })).toBe(
      "WebFetch https://example.com",
    );
    expect(summarizeToolUse("WebSearch", { query: "rondel hitl" })).toBe(
      "WebSearch rondel hitl",
    );
  });

  it("formats rondel_ask_user with the prompt", () => {
    expect(summarizeToolUse("rondel_ask_user", { prompt: "Pick a color" })).toBe(
      "ask_user: Pick a color",
    );
  });

  it("truncates long rondel_ask_user prompts", () => {
    const longPrompt = "decide ".repeat(50);
    const result = summarizeToolUse("rondel_ask_user", { prompt: longPrompt });
    expect(result.length).toBeLessThanOrEqual(200);
    expect(result.startsWith("ask_user: ")).toBe(true);
  });

  it("falls back to JSON stringify for unknown tools", () => {
    const result = summarizeToolUse("Unknown", { foo: "bar" });
    expect(result).toContain("Unknown");
    expect(result).toContain("foo");
  });

  it("truncates long summaries with an ellipsis", () => {
    const longCommand = "echo " + "x".repeat(500);
    const result = summarizeToolUse("Bash", { command: longCommand });
    expect(result.length).toBeLessThanOrEqual(200);
    expect(result.endsWith("...")).toBe(true);
  });

  it("handles missing fields without throwing", () => {
    expect(() => summarizeToolUse("Bash", {})).not.toThrow();
    expect(() => summarizeToolUse("Write", {})).not.toThrow();
    expect(() => summarizeToolUse("Bash", null)).not.toThrow();
  });
});
