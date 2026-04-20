import { describe, expect, it } from "vitest";
import { buildExecutionBias } from "../../sections/execution-bias.js";

describe("buildExecutionBias", () => {
  it("starts with the Execution Bias heading", () => {
    expect(buildExecutionBias().startsWith("## Execution Bias\n")).toBe(true);
  });

  it("instructs the agent to act in the same turn", () => {
    expect(buildExecutionBias()).toContain("start doing it in the same turn");
  });

  it("flags commentary-only turns as incomplete", () => {
    expect(buildExecutionBias()).toContain("Commentary-only turns are incomplete");
  });
});
