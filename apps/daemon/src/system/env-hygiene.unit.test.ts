import { describe, it, expect } from "vitest";
import { scrubInheritedClaudeEnv, claudeSpawnEnv, parseCliVersion, compareVersions } from "./env-hygiene.js";

describe("scrubInheritedClaudeEnv", () => {
  it("removes CLAUDE-prefixed vars and returns their names", () => {
    const env: NodeJS.ProcessEnv = {
      CLAUDECODE: "1",
      CLAUDE_CODE_ENTRYPOINT: "cli",
      CLAUDE_CODE_SESSION_ID: "abc",
      PATH: "/usr/bin",
    };
    const removed = scrubInheritedClaudeEnv(env);
    expect(removed.sort()).toEqual(["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ID"]);
    expect(env.PATH).toBe("/usr/bin");
    expect("CLAUDECODE" in env).toBe(false);
  });

  it("preserves CLAUDE_CODE_OAUTH_TOKEN (the subscription token)", () => {
    const env: NodeJS.ProcessEnv = { CLAUDE_CODE_OAUTH_TOKEN: "tok", CLAUDECODE: "1" };
    scrubInheritedClaudeEnv(env);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("tok");
    expect("CLAUDECODE" in env).toBe(false);
  });

  it("preserves CLAUDE_CONFIG_DIR (operator-relocated CLI state dir)", () => {
    const env: NodeJS.ProcessEnv = { CLAUDE_CONFIG_DIR: "/srv/claude-home", CLAUDECODE: "1" };
    scrubInheritedClaudeEnv(env);
    expect(env.CLAUDE_CONFIG_DIR).toBe("/srv/claude-home");
    expect("CLAUDECODE" in env).toBe(false);
  });

  it("returns an empty list when nothing matches", () => {
    const env: NodeJS.ProcessEnv = { HOME: "/home/x" };
    expect(scrubInheritedClaudeEnv(env)).toEqual([]);
  });
});

describe("claudeSpawnEnv", () => {
  it("disables the CLI's native auto-memory", () => {
    expect(claudeSpawnEnv().CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe("1");
  });
});

describe("parseCliVersion", () => {
  it.each([
    ["2.1.172 (Claude Code)", "2.1.172"],
    ["1.0.0", "1.0.0"],
    ["claude v2.2.10\n", "2.2.10"],
  ] as const)("parses %j → %s", (raw, expected) => {
    expect(parseCliVersion(raw)).toBe(expected);
  });

  it("returns undefined for garbage", () => {
    expect(parseCliVersion("not a version")).toBeUndefined();
  });
});

describe("compareVersions", () => {
  it.each([
    ["2.1.169", "2.1.170", -1],
    ["2.1.170", "2.1.170", 0],
    ["2.1.172", "2.1.170", 1],
    ["2.2.0", "2.1.170", 1],
    ["3.0.0", "2.99.99", 1],
  ] as const)("compare(%s, %s) sign is %d", (a, b, sign) => {
    expect(Math.sign(compareVersions(a, b))).toBe(sign);
  });
});
