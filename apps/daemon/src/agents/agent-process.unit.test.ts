import { describe, it, expect } from "vitest";
import { FRAMEWORK_DISALLOWED_TOOLS } from "./agent-process.js";

describe("FRAMEWORK_DISALLOWED_TOOLS", () => {
  it("contains exactly the framework-owned disallowed tool names", () => {
    const expected = [
      "Agent",
      "ExitPlanMode",
      "AskUserQuestion",
      "Bash",
      "Write",
      "Edit",
      "MultiEdit",
    ];
    expect(new Set(FRAMEWORK_DISALLOWED_TOOLS)).toEqual(new Set(expected));
    expect(FRAMEWORK_DISALLOWED_TOOLS.length).toBe(expected.length);
  });

  it("blocks the built-in subagent tool (superseded by rondel_spawn_subagent)", () => {
    expect(FRAMEWORK_DISALLOWED_TOOLS).toContain("Agent");
  });

  it("blocks ExitPlanMode (TTY-only, no headless surface)", () => {
    expect(FRAMEWORK_DISALLOWED_TOOLS).toContain("ExitPlanMode");
  });

  it("blocks AskUserQuestion (TTY-only, agents ask in plain text instead)", () => {
    expect(FRAMEWORK_DISALLOWED_TOOLS).toContain("AskUserQuestion");
  });

  it("blocks native Bash (replaced by rondel_bash)", () => {
    expect(FRAMEWORK_DISALLOWED_TOOLS).toContain("Bash");
  });

  it("blocks native Write (replaced by rondel_write_file)", () => {
    expect(FRAMEWORK_DISALLOWED_TOOLS).toContain("Write");
  });

  it("blocks native Edit (replaced by rondel_edit_file)", () => {
    expect(FRAMEWORK_DISALLOWED_TOOLS).toContain("Edit");
  });

  it("blocks native MultiEdit (replaced by rondel_multi_edit_file)", () => {
    expect(FRAMEWORK_DISALLOWED_TOOLS).toContain("MultiEdit");
  });
});
