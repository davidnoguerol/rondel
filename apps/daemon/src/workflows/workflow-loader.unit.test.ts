import { describe, it, expect } from "vitest";
import { parseWorkflowDefinition, WorkflowLoadError } from "./workflow-loader.js";

const minimalValid = {
  id: "demo",
  version: 1,
  inputs: {},
  steps: [
    {
      id: "only",
      kind: "agent",
      agent: "writer",
      task: "do it",
    },
  ],
};

describe("parseWorkflowDefinition", () => {
  it("accepts a minimal valid definition", () => {
    const def = parseWorkflowDefinition(JSON.stringify(minimalValid));
    expect(def.id).toBe("demo");
    expect(def.steps).toHaveLength(1);
    expect(def.steps[0]!.kind).toBe("agent");
  });

  it("accepts a definition with inputs, gates, and retry blocks", () => {
    const def = parseWorkflowDefinition(JSON.stringify({
      id: "full",
      version: 1,
      description: "Full scenario shape",
      inputs: {
        prd: { kind: "artifact", required: true },
      },
      steps: [
        {
          id: "architecture",
          kind: "agent",
          agent: "architect",
          task: "plan it",
          inputs: ["prd"],
          output: "dev-plan.md",
        },
        {
          id: "approve-plan",
          kind: "gate",
          prompt: "review it",
        },
        {
          id: "dev-qa-loop",
          kind: "retry",
          maxAttempts: 5,
          succeedsWhen: { stepId: "qa", statusIs: "ok" },
          body: [
            {
              id: "remediation",
              kind: "agent",
              when: "on-retry",
              agent: "architect",
              task: "fix",
            },
            { id: "dev", kind: "agent", agent: "dev", task: "build" },
            { id: "qa", kind: "agent", agent: "qa", task: "test" },
          ],
        },
      ],
    }));
    expect(def.steps).toHaveLength(3);
    const retry = def.steps[2]!;
    expect(retry.kind).toBe("retry");
    if (retry.kind === "retry") {
      expect(retry.body).toHaveLength(3);
      expect(retry.body[0]!.when).toBe("on-retry");
    }
  });

  it("throws WorkflowLoadError on invalid JSON", () => {
    expect(() => parseWorkflowDefinition("{not json"))
      .toThrow(WorkflowLoadError);
  });

  it("throws WorkflowLoadError when id is missing", () => {
    const bad = { ...minimalValid, id: undefined };
    expect(() => parseWorkflowDefinition(JSON.stringify(bad)))
      .toThrow(/Invalid workflow definition/);
  });

  it("throws WorkflowLoadError for an unknown step kind", () => {
    expect(() => parseWorkflowDefinition(JSON.stringify({
      ...minimalValid,
      steps: [{ id: "x", kind: "bogus", agent: "a", task: "t" }],
    }))).toThrow(/Invalid workflow definition/);
  });

  it("throws when id format is invalid", () => {
    expect(() => parseWorkflowDefinition(JSON.stringify({
      ...minimalValid,
      id: "--starts-with-hyphen",
    }))).toThrow(/Invalid workflow definition/);
  });

  it("throws when version is missing", () => {
    const bad: Record<string, unknown> = { ...minimalValid };
    delete bad.version;
    expect(() => parseWorkflowDefinition(JSON.stringify(bad)))
      .toThrow(/Invalid workflow definition/);
  });

  it("throws on an empty steps array", () => {
    expect(() => parseWorkflowDefinition(JSON.stringify({
      ...minimalValid,
      steps: [],
    }))).toThrow(/Invalid workflow definition/);
  });

  it("throws on duplicate step ids (top level)", () => {
    expect(() => parseWorkflowDefinition(JSON.stringify({
      ...minimalValid,
      steps: [
        { id: "dup", kind: "agent", agent: "a", task: "t" },
        { id: "dup", kind: "agent", agent: "b", task: "u" },
      ],
    }))).toThrow(/Duplicate step id "dup"/);
  });

  it("throws on duplicate step ids across nested retry bodies", () => {
    expect(() => parseWorkflowDefinition(JSON.stringify({
      ...minimalValid,
      steps: [
        { id: "dev", kind: "agent", agent: "dev", task: "build" },
        {
          id: "loop",
          kind: "retry",
          maxAttempts: 2,
          succeedsWhen: { stepId: "dev", statusIs: "ok" },
          body: [
            { id: "dev", kind: "agent", agent: "dev", task: "build again" },
          ],
        },
      ],
    }))).toThrow(/Duplicate step id "dev"/);
  });

  it("throws when retry.succeedsWhen.stepId does not match any inner step", () => {
    expect(() => parseWorkflowDefinition(JSON.stringify({
      ...minimalValid,
      steps: [
        {
          id: "loop",
          kind: "retry",
          maxAttempts: 2,
          succeedsWhen: { stepId: "missing", statusIs: "ok" },
          body: [{ id: "dev", kind: "agent", agent: "dev", task: "build" }],
        },
      ],
    }))).toThrow(/does not reference/);
  });

  it("includes the source label in the error message", () => {
    try {
      parseWorkflowDefinition("{bad", "/tmp/demo.json");
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(WorkflowLoadError);
      expect((err as WorkflowLoadError).sourcePath).toBe("/tmp/demo.json");
      expect((err as Error).message).toContain("/tmp/demo.json");
    }
  });
});
