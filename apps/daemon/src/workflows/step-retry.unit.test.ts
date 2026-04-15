import { describe, it, expect } from "vitest";
import {
  shouldRunInAttempt,
  buildRetryStepKey,
  evaluateSucceedsWhen,
  validateRetryTarget,
} from "./step-retry.js";
import type { AgentStep, RetryStep, StepRunState } from "../shared/types/index.js";

const agent = (id: string, when?: "always" | "on-retry"): AgentStep => ({
  id,
  kind: "agent",
  agent: "dev",
  task: "do stuff",
  ...(when ? { when } : {}),
});

const makeStepState = (
  stepKey: string,
  status: StepRunState["status"],
  attempt = 1,
): StepRunState => ({
  stepKey,
  stepId: stepKey.split("/").pop()!,
  kind: "agent",
  status,
  attempt,
  startedAt: null,
  completedAt: null,
  outputArtifact: null,
  summary: null,
  failReason: null,
  subagentId: null,
  gateId: null,
});

describe("shouldRunInAttempt", () => {
  it("runs 'always' steps on attempt 1", () => {
    expect(shouldRunInAttempt(agent("a", "always"), 1)).toBe(true);
  });

  it("runs 'always' steps on attempt 3", () => {
    expect(shouldRunInAttempt(agent("a", "always"), 3)).toBe(true);
  });

  it("defaults to 'always' when `when` is omitted", () => {
    expect(shouldRunInAttempt(agent("a"), 1)).toBe(true);
    expect(shouldRunInAttempt(agent("a"), 5)).toBe(true);
  });

  it("skips 'on-retry' steps on attempt 1", () => {
    expect(shouldRunInAttempt(agent("a", "on-retry"), 1)).toBe(false);
  });

  it("runs 'on-retry' steps on attempt 2", () => {
    expect(shouldRunInAttempt(agent("a", "on-retry"), 2)).toBe(true);
  });

  it("runs 'on-retry' steps on attempt 10", () => {
    expect(shouldRunInAttempt(agent("a", "on-retry"), 10)).toBe(true);
  });
});

describe("buildRetryStepKey", () => {
  it("formats the path with a literal 'attempt:N' segment", () => {
    expect(buildRetryStepKey("dev-qa-loop", 2, "qa")).toBe("dev-qa-loop/attempt:2/qa");
  });

  it("supports attempt 1", () => {
    expect(buildRetryStepKey("loop", 1, "a")).toBe("loop/attempt:1/a");
  });

  it("preserves hyphens/underscores in step ids", () => {
    expect(buildRetryStepKey("outer-block", 3, "inner_step")).toBe(
      "outer-block/attempt:3/inner_step",
    );
  });
});

describe("evaluateSucceedsWhen", () => {
  const retry: RetryStep = {
    id: "dev-qa-loop",
    kind: "retry",
    maxAttempts: 5,
    body: [agent("dev"), agent("qa")],
    succeedsWhen: { stepId: "qa", statusIs: "ok" },
  };

  it("returns null when the target step has no recorded state", () => {
    expect(evaluateSucceedsWhen(retry, 1, {})).toBe(null);
  });

  it("returns true when target step is completed", () => {
    const states = {
      "dev-qa-loop/attempt:1/qa": makeStepState("dev-qa-loop/attempt:1/qa", "completed"),
    };
    expect(evaluateSucceedsWhen(retry, 1, states)).toBe(true);
  });

  it("returns false when target step failed", () => {
    const states = {
      "dev-qa-loop/attempt:1/qa": makeStepState("dev-qa-loop/attempt:1/qa", "failed"),
    };
    expect(evaluateSucceedsWhen(retry, 1, states)).toBe(false);
  });

  it("returns false when target step was skipped", () => {
    const states = {
      "dev-qa-loop/attempt:1/qa": makeStepState("dev-qa-loop/attempt:1/qa", "skipped"),
    };
    expect(evaluateSucceedsWhen(retry, 1, states)).toBe(false);
  });

  it("returns null when target step is still running", () => {
    const states = {
      "dev-qa-loop/attempt:1/qa": makeStepState("dev-qa-loop/attempt:1/qa", "running"),
    };
    expect(evaluateSucceedsWhen(retry, 1, states)).toBe(null);
  });

  it("evaluates a later attempt independently from earlier attempts", () => {
    const states = {
      "dev-qa-loop/attempt:1/qa": makeStepState("dev-qa-loop/attempt:1/qa", "failed"),
      "dev-qa-loop/attempt:2/qa": makeStepState("dev-qa-loop/attempt:2/qa", "completed", 2),
    };
    expect(evaluateSucceedsWhen(retry, 1, states)).toBe(false);
    expect(evaluateSucceedsWhen(retry, 2, states)).toBe(true);
  });
});

describe("validateRetryTarget", () => {
  it("accepts a retry whose succeedsWhen.stepId exists in body", () => {
    const retry: RetryStep = {
      id: "loop",
      kind: "retry",
      maxAttempts: 3,
      body: [agent("dev"), agent("qa")],
      succeedsWhen: { stepId: "qa", statusIs: "ok" },
    };
    expect(() => validateRetryTarget(retry)).not.toThrow();
  });

  it("rejects a retry whose succeedsWhen.stepId is missing from body", () => {
    const retry: RetryStep = {
      id: "loop",
      kind: "retry",
      maxAttempts: 3,
      body: [agent("dev")],
      succeedsWhen: { stepId: "nope", statusIs: "ok" },
    };
    expect(() => validateRetryTarget(retry)).toThrow(/does not reference/);
  });
});
