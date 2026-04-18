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
      "CronCreate",
      "CronDelete",
      "CronList",
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

  it("blocks native CronCreate (session-only, 7-day TTL — replaced by rondel_schedule_create)", () => {
    expect(FRAMEWORK_DISALLOWED_TOOLS).toContain("CronCreate");
  });

  it("blocks native CronDelete (session-only — replaced by rondel_schedule_delete)", () => {
    expect(FRAMEWORK_DISALLOWED_TOOLS).toContain("CronDelete");
  });

  it("blocks native CronList (session-only — replaced by rondel_schedule_list)", () => {
    expect(FRAMEWORK_DISALLOWED_TOOLS).toContain("CronList");
  });

  it("does NOT block ScheduleWakeup (still useful for short in-turn waits)", () => {
    expect(FRAMEWORK_DISALLOWED_TOOLS).not.toContain("ScheduleWakeup");
  });
});
