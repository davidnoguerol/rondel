import { describe, expect, it } from "vitest";
import { buildToolCallStyle } from "../../sections/tool-call-style.js";

describe("buildToolCallStyle", () => {
  it("starts with the Tool Call Style heading", () => {
    expect(buildToolCallStyle().startsWith("## Tool Call Style\n")).toBe(true);
  });

  it("tells the agent not to narrate routine tool calls", () => {
    expect(buildToolCallStyle()).toContain("do not narrate routine");
  });

  it("tells the agent to invoke skills when relevant", () => {
    expect(buildToolCallStyle()).toContain("invoke it before acting");
  });
});
