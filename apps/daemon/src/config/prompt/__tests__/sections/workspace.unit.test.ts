import { describe, expect, it } from "vitest";
import { buildWorkspace } from "../../sections/workspace.js";

describe("buildWorkspace (persistent)", () => {
  it("includes agent dir, working dir, skills path, and memory guidance", () => {
    const text = buildWorkspace({
      agentDir: "/home/dave/.rondel/workspaces/global/agents/kai",
      workingDirectory: null,
      isEphemeral: false,
    });
    expect(text).toContain("## Workspace");
    expect(text).toContain("/home/dave/.rondel/workspaces/global/agents/kai");
    expect(text).toContain(".claude/skills/<your-chosen-slug>/SKILL.md");
    expect(text).toContain("rondel_memory_save");
  });

  it("tells the agent not to use the literal placeholder slug", () => {
    const text = buildWorkspace({
      agentDir: "/tmp/kai",
      workingDirectory: null,
      isEphemeral: false,
    });
    expect(text).toContain("do not use the literal text");
  });

  it("uses workingDirectory when provided, falling back to agentDir", () => {
    const withWorkdir = buildWorkspace({
      agentDir: "/tmp/kai",
      workingDirectory: "/code/myproject",
      isEphemeral: false,
    });
    expect(withWorkdir).toContain("working directory for tool calls (bash, file reads/writes) is: /code/myproject");

    const noWorkdir = buildWorkspace({
      agentDir: "/tmp/kai",
      workingDirectory: null,
      isEphemeral: false,
    });
    expect(noWorkdir).toContain("working directory for tool calls (bash, file reads/writes) is: /tmp/kai");
  });
});

describe("buildWorkspace (ephemeral)", () => {
  it("omits skills path and memory guidance, adds ephemeral notice", () => {
    const text = buildWorkspace({
      agentDir: "/tmp/kai",
      workingDirectory: null,
      isEphemeral: true,
    });
    expect(text).toContain("/tmp/kai");
    expect(text).not.toContain(".claude/skills/");
    expect(text).not.toContain("rondel_memory_save");
    expect(text).toContain("ephemeral process");
  });
});
