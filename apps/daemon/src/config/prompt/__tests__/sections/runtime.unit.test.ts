import { describe, expect, it } from "vitest";
import { buildRuntime } from "../../sections/runtime.js";

describe("buildRuntime", () => {
  it("renders a one-line summary with pipe-separated fields", () => {
    const text = buildRuntime({
      agentName: "kai",
      orgName: "acme",
      model: "sonnet",
      channelType: "telegram",
      workingDirectory: "/code/myproject",
    });
    expect(text).toBe(
      "## Runtime\nagent=kai | org=acme | model=sonnet | channel=telegram | working_dir=/code/myproject",
    );
  });

  it("substitutes org=global when the agent is not in an org", () => {
    const text = buildRuntime({
      agentName: "kai",
      orgName: null,
      model: "sonnet",
      channelType: "telegram",
      workingDirectory: "/tmp/kai",
    });
    expect(text).toContain("org=global");
  });

  it("omits the channel field when not set", () => {
    const text = buildRuntime({
      agentName: "kai",
      orgName: null,
      model: "sonnet",
      channelType: null,
      workingDirectory: "/tmp/kai",
    });
    expect(text).not.toContain("channel=");
    expect(text).toContain("agent=kai");
    expect(text).toContain("model=sonnet");
  });
});
