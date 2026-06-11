import { describe, it, expect } from "vitest";
import { mangleCwd, deriveCliTranscriptPath, deriveCliProjectDir } from "./cli-transcript-path.js";

describe("mangleCwd", () => {
  it.each([
    ["/Users/david/.rondel", "-Users-david--rondel"],
    ["/Users/david/Code/foundergrowth-lab", "-Users-david-Code-foundergrowth-lab"],
    ["/Users/david/Code/flint-app/.claude-worktrees/initiative-workflow", "-Users-david-Code-flint-app--claude-worktrees-initiative-workflow"],
    ["/tmp/with_underscore", "-tmp-with-underscore"],
    ["/tmp/with space", "-tmp-with-space"],
  ] as const)("mangles %s → %s (verified against real ~/.claude/projects names)", (cwd, expected) => {
    expect(mangleCwd(cwd)).toBe(expected);
  });
});

describe("deriveCliTranscriptPath", () => {
  it("joins home, projects, mangled cwd, and the session filename", () => {
    expect(deriveCliTranscriptPath("/Users/david/.rondel", "abc-123", "/home/x")).toBe(
      "/home/x/.claude/projects/-Users-david--rondel/abc-123.jsonl",
    );
  });

  it("honors CLAUDE_CONFIG_DIR over the home-derived default (env-hygiene preserves it)", () => {
    const prior = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = "/srv/claude-home";
    try {
      expect(deriveCliTranscriptPath("/Users/david/.rondel", "abc-123", "/home/x")).toBe(
        "/srv/claude-home/projects/-Users-david--rondel/abc-123.jsonl",
      );
      expect(deriveCliProjectDir("/Users/david/.rondel", "/home/x")).toBe("/srv/claude-home/projects/-Users-david--rondel");
    } finally {
      if (prior === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prior;
    }
  });
});

describe("deriveCliProjectDir", () => {
  it("derives the project dir without a filename", () => {
    expect(deriveCliProjectDir("/Users/david/.rondel", "/home/x")).toBe("/home/x/.claude/projects/-Users-david--rondel");
  });
});
