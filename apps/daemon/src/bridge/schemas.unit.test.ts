import { describe, it, expect } from "vitest";
import {
  AddAgentSchema,
  UpdateAgentSchema,
  AddOrgSchema,
  SetEnvSchema,
  SendMessageSchema,
  WorkflowStartRequestSchema,
  StepCompleteRequestSchema,
  ResolveGateRequestSchema,
  ListWorkflowsQuerySchema,
  WorkflowDefinitionSchema,
  validateBody,
} from "./schemas.js";
import { makeSendMessageBody } from "../../tests/helpers/fixtures.js";

describe("AddAgentSchema", () => {
  const valid = {
    agent_name: "kai",
    bot_token: "123456:ABCdef",
  };

  it("accepts a minimal valid body", () => {
    expect(AddAgentSchema.safeParse(valid).success).toBe(true);
  });

  it("accepts optional model, location, working_directory", () => {
    const result = AddAgentSchema.safeParse({
      ...valid,
      model: "claude-opus-4-6",
      location: "/tmp/x",
      working_directory: "/tmp/y",
    });
    expect(result.success).toBe(true);
  });

  it("rejects agent_name starting with a hyphen", () => {
    const result = AddAgentSchema.safeParse({ ...valid, agent_name: "-foo" });
    expect(result.success).toBe(false);
  });

  it("rejects bot_token without a colon", () => {
    const result = AddAgentSchema.safeParse({ ...valid, bot_token: "abcdef" });
    expect(result.success).toBe(false);
  });

  it("rejects missing agent_name", () => {
    const result = AddAgentSchema.safeParse({ bot_token: valid.bot_token });
    expect(result.success).toBe(false);
  });
});

describe("UpdateAgentSchema", () => {
  it("accepts an empty object (all fields optional)", () => {
    expect(UpdateAgentSchema.safeParse({}).success).toBe(true);
  });

  it("accepts workingDirectory: null", () => {
    expect(
      UpdateAgentSchema.safeParse({ workingDirectory: null }).success,
    ).toBe(true);
  });

  it("rejects non-boolean enabled", () => {
    expect(UpdateAgentSchema.safeParse({ enabled: "yes" }).success).toBe(false);
  });
});

describe("AddOrgSchema", () => {
  it("accepts a valid org name", () => {
    expect(AddOrgSchema.safeParse({ org_name: "acme" }).success).toBe(true);
  });

  it("rejects an org name with a space", () => {
    expect(AddOrgSchema.safeParse({ org_name: "1 team" }).success).toBe(false);
  });
});

describe("SetEnvSchema", () => {
  it("accepts a valid uppercase key and empty value", () => {
    expect(SetEnvSchema.safeParse({ key: "BOT_TOKEN", value: "" }).success).toBe(
      true,
    );
  });

  it("rejects a lowercase key", () => {
    expect(SetEnvSchema.safeParse({ key: "bot_token", value: "x" }).success).toBe(
      false,
    );
  });

  it("rejects a key starting with a digit", () => {
    expect(SetEnvSchema.safeParse({ key: "1BOT", value: "x" }).success).toBe(
      false,
    );
  });
});

describe("SendMessageSchema", () => {
  it("accepts a valid inter-agent message body", () => {
    expect(SendMessageSchema.safeParse(makeSendMessageBody()).success).toBe(
      true,
    );
  });

  it("rejects an empty content string", () => {
    expect(
      SendMessageSchema.safeParse(makeSendMessageBody({ content: "" })).success,
    ).toBe(false);
  });

  it("rejects an empty reply_to_chat_id", () => {
    expect(
      SendMessageSchema.safeParse(
        makeSendMessageBody({ reply_to_chat_id: "" }),
      ).success,
    ).toBe(false);
  });

  it("rejects a from agentName that violates the regex", () => {
    expect(
      SendMessageSchema.safeParse(makeSendMessageBody({ from: "-bad" })).success,
    ).toBe(false);
  });
});

describe("agentName regex (via AddAgentSchema)", () => {
  const cases: ReadonlyArray<[string, boolean]> = [
    ["a", true],
    ["A1_b-c", true],
    ["kai", true],
    ["-foo", false],
    ["foo bar", false],
    ["", false],
  ];
  for (const [name, ok] of cases) {
    it(`${ok ? "accepts" : "rejects"} ${JSON.stringify(name)}`, () => {
      const result = AddAgentSchema.safeParse({
        agent_name: name,
        bot_token: "1:x",
      });
      expect(result.success).toBe(ok);
    });
  }
});

describe("botToken regex (via AddAgentSchema)", () => {
  const cases: ReadonlyArray<[string, boolean]> = [
    ["123:abc", true],
    ["9999999999:abcDEF_-.", true],
    ["123:a", true],
    ["abc:123", false],
    ["123abc", false],
    ["123:", false],
  ];
  for (const [token, ok] of cases) {
    it(`${ok ? "accepts" : "rejects"} ${JSON.stringify(token)}`, () => {
      const result = AddAgentSchema.safeParse({
        agent_name: "kai",
        bot_token: token,
      });
      expect(result.success).toBe(ok);
    });
  }
});

describe("envKey regex (via SetEnvSchema)", () => {
  const cases: ReadonlyArray<[string, boolean]> = [
    ["BOT_TOKEN", true],
    ["_PRIVATE", true],
    ["X1", true],
    ["bot_token", false],
    ["1BOT", false],
    ["BOT-TOKEN", false],
  ];
  for (const [key, ok] of cases) {
    it(`${ok ? "accepts" : "rejects"} ${JSON.stringify(key)}`, () => {
      const result = SetEnvSchema.safeParse({ key, value: "x" });
      expect(result.success).toBe(ok);
    });
  }
});

describe("validateBody", () => {
  it("returns success with parsed data on valid input", () => {
    const result = validateBody(AddAgentSchema, {
      agent_name: "kai",
      bot_token: "1:x",
    });
    expect(result).toEqual({
      success: true,
      data: { agent_name: "kai", bot_token: "1:x" },
    });
  });

  it("returns a path-prefixed error message on invalid input", () => {
    const result = validateBody(AddAgentSchema, {
      agent_name: "-bad",
      bot_token: "1:x",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      // Must be prefixed with "agent_name: " at the start, not merely contain
      // the word somewhere in the body (which zod's default message does).
      expect(result.error).toMatch(/^agent_name: /);
    }
  });

  it("joins multiple issues with the literal '; ' separator", () => {
    const result = validateBody(AddAgentSchema, {
      agent_name: "-bad",
      bot_token: "nope",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      // Lock the exact separator, not just "contains a semicolon".
      expect(result.error).toContain("; ");
      const segments = result.error.split("; ");
      expect(segments.length).toBeGreaterThanOrEqual(2);
      expect(segments.some((s) => s.startsWith("agent_name: "))).toBe(true);
      expect(segments.some((s) => s.startsWith("bot_token: "))).toBe(true);
    }
  });

  it("returns success:false (not throw) on non-object input", () => {
    // Defensive coverage for validateBody's error shape when given bad types.
    expect(validateBody(AddAgentSchema, null).success).toBe(false);
    expect(validateBody(AddAgentSchema, []).success).toBe(false);
    expect(validateBody(AddAgentSchema, "string").success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Workflow engine schemas (Layer 4 v0)
// ---------------------------------------------------------------------------

describe("WorkflowStartRequestSchema", () => {
  const valid = {
    workflow_id: "full-feature-dev",
    inputs: { prd: "/tmp/prd.md" },
    originator_agent: "pm",
    originator_channel_type: "telegram",
    originator_account_id: "pm-bot",
    originator_chat_id: "12345",
  };

  it("accepts a fully populated valid body", () => {
    expect(WorkflowStartRequestSchema.safeParse(valid).success).toBe(true);
  });

  it("defaults inputs to an empty object when omitted", () => {
    const { inputs: _inputs, ...rest } = valid;
    const result = WorkflowStartRequestSchema.safeParse(rest);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.inputs).toEqual({});
  });

  it("rejects a workflow_id with a space", () => {
    expect(
      WorkflowStartRequestSchema.safeParse({ ...valid, workflow_id: "bad id" }).success,
    ).toBe(false);
  });

  it("rejects a workflow_id starting with a hyphen", () => {
    expect(
      WorkflowStartRequestSchema.safeParse({ ...valid, workflow_id: "-bad" }).success,
    ).toBe(false);
  });

  it("rejects a missing originator_agent", () => {
    const { originator_agent: _a, ...rest } = valid;
    expect(WorkflowStartRequestSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects an empty originator_chat_id", () => {
    expect(
      WorkflowStartRequestSchema.safeParse({ ...valid, originator_chat_id: "" }).success,
    ).toBe(false);
  });

  it("rejects a relative input path", () => {
    const result = WorkflowStartRequestSchema.safeParse({
      ...valid,
      inputs: { prd: "relative/prd.md" },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.message.includes("absolute"))).toBe(true);
    }
  });

  it("rejects an empty input path", () => {
    expect(
      WorkflowStartRequestSchema.safeParse({
        ...valid,
        inputs: { prd: "" },
      }).success,
    ).toBe(false);
  });

  it("accepts multiple absolute input paths", () => {
    expect(
      WorkflowStartRequestSchema.safeParse({
        ...valid,
        inputs: { prd: "/tmp/prd.md", spec: "/var/data/spec.md" },
      }).success,
    ).toBe(true);
  });
});

describe("StepCompleteRequestSchema", () => {
  const valid = {
    run_id: "run_1700000000000_abc123",
    step_key: "architecture",
    status: "ok" as const,
    summary: "all good",
  };

  it("accepts a minimal ok completion", () => {
    expect(StepCompleteRequestSchema.safeParse(valid).success).toBe(true);
  });

  it("accepts a fail completion with artifact and fail_reason", () => {
    expect(
      StepCompleteRequestSchema.safeParse({
        ...valid,
        status: "fail",
        artifact: "dev-plan.md",
        fail_reason: "compile error",
      }).success,
    ).toBe(true);
  });

  it.each([
    ["missing run_ prefix", "1700000000000_abc123"],
    ["too-short random suffix", "run_1700000000000_abc"],
    ["uppercase in random suffix", "run_1700000000000_ABCDEF"],
    ["non-digit ms section", "run_abc_abcdef"],
  ] as const)("rejects run_id: %s", (_label, runId) => {
    expect(
      StepCompleteRequestSchema.safeParse({ ...valid, run_id: runId }).success,
    ).toBe(false);
  });

  it("rejects an empty summary", () => {
    expect(
      StepCompleteRequestSchema.safeParse({ ...valid, summary: "" }).success,
    ).toBe(false);
  });

  it("rejects a summary longer than 500 characters", () => {
    expect(
      StepCompleteRequestSchema.safeParse({ ...valid, summary: "x".repeat(501) }).success,
    ).toBe(false);
  });

  it("rejects status values other than ok/fail", () => {
    expect(
      StepCompleteRequestSchema.safeParse({ ...valid, status: "maybe" }).success,
    ).toBe(false);
  });

  it("rejects an empty step_key", () => {
    expect(
      StepCompleteRequestSchema.safeParse({ ...valid, step_key: "" }).success,
    ).toBe(false);
  });
});

describe("ResolveGateRequestSchema", () => {
  const valid = {
    run_id: "run_1700000000000_abc123",
    decision: "approved" as const,
    decided_by: "telegram:pm-bot",
  };

  it("accepts a minimal approved decision", () => {
    expect(ResolveGateRequestSchema.safeParse(valid).success).toBe(true);
  });

  it("accepts a denied decision with a note", () => {
    expect(
      ResolveGateRequestSchema.safeParse({
        ...valid,
        decision: "denied",
        note: "missing tests",
      }).success,
    ).toBe(true);
  });

  it("rejects decision values other than approved/denied", () => {
    expect(
      ResolveGateRequestSchema.safeParse({ ...valid, decision: "maybe" }).success,
    ).toBe(false);
  });

  it("rejects an empty decided_by", () => {
    expect(
      ResolveGateRequestSchema.safeParse({ ...valid, decided_by: "" }).success,
    ).toBe(false);
  });

  it("rejects a note longer than 1000 characters", () => {
    expect(
      ResolveGateRequestSchema.safeParse({ ...valid, note: "x".repeat(1001) }).success,
    ).toBe(false);
  });
});

describe("ListWorkflowsQuerySchema", () => {
  it("accepts an empty query", () => {
    expect(ListWorkflowsQuerySchema.safeParse({}).success).toBe(true);
  });

  it.each([
    ["pending", true],
    ["running", true],
    ["waiting-gate", true],
    ["completed", true],
    ["failed", true],
    ["interrupted", true],
    ["all", true],
    ["nonsense", false],
  ] as const)("status=%s accepted=%s", (status, ok) => {
    expect(ListWorkflowsQuerySchema.safeParse({ status }).success).toBe(ok);
  });

  it("rejects a non-integer limit", () => {
    expect(ListWorkflowsQuerySchema.safeParse({ limit: 1.5 }).success).toBe(false);
  });

  it("rejects a limit below the minimum", () => {
    expect(ListWorkflowsQuerySchema.safeParse({ limit: 0 }).success).toBe(false);
  });

  it("rejects a limit above the maximum", () => {
    expect(ListWorkflowsQuerySchema.safeParse({ limit: 201 }).success).toBe(false);
  });
});

describe("WorkflowDefinitionSchema", () => {
  const minimal = {
    id: "demo",
    version: 1,
    inputs: {},
    steps: [{ id: "only", kind: "agent", agent: "writer", task: "do it" }],
  };

  it("accepts a minimal single-step workflow", () => {
    expect(WorkflowDefinitionSchema.safeParse(minimal).success).toBe(true);
  });

  it("defaults inputs to an empty object when omitted", () => {
    const { inputs: _i, ...rest } = minimal;
    const result = WorkflowDefinitionSchema.safeParse(rest);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.inputs).toEqual({});
  });

  it("rejects an empty steps array", () => {
    expect(
      WorkflowDefinitionSchema.safeParse({ ...minimal, steps: [] }).success,
    ).toBe(false);
  });

  it("rejects an unknown step kind", () => {
    expect(
      WorkflowDefinitionSchema.safeParse({
        ...minimal,
        steps: [{ id: "x", kind: "mystery", agent: "writer", task: "t" }],
      }).success,
    ).toBe(false);
  });

  it("accepts a retry step containing an agent step", () => {
    expect(
      WorkflowDefinitionSchema.safeParse({
        ...minimal,
        steps: [
          {
            id: "loop",
            kind: "retry",
            maxAttempts: 3,
            succeedsWhen: { stepId: "qa", statusIs: "ok" },
            body: [
              { id: "dev", kind: "agent", agent: "dev", task: "implement" },
              { id: "qa", kind: "agent", agent: "qa", task: "review" },
            ],
          },
        ],
      }).success,
    ).toBe(true);
  });

  it("accepts a nested retry inside a retry", () => {
    expect(
      WorkflowDefinitionSchema.safeParse({
        ...minimal,
        steps: [
          {
            id: "outer",
            kind: "retry",
            maxAttempts: 2,
            succeedsWhen: { stepId: "inner-qa", statusIs: "ok" },
            body: [
              {
                id: "inner",
                kind: "retry",
                maxAttempts: 3,
                succeedsWhen: { stepId: "inner-qa", statusIs: "ok" },
                body: [
                  { id: "inner-dev", kind: "agent", agent: "dev", task: "t" },
                  { id: "inner-qa", kind: "agent", agent: "qa", task: "t" },
                ],
              },
            ],
          },
        ],
      }).success,
    ).toBe(true);
  });

  it("rejects a retry step with an empty body", () => {
    expect(
      WorkflowDefinitionSchema.safeParse({
        ...minimal,
        steps: [
          {
            id: "loop",
            kind: "retry",
            maxAttempts: 3,
            succeedsWhen: { stepId: "x", statusIs: "ok" },
            body: [],
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects a retry step with maxAttempts below 1", () => {
    expect(
      WorkflowDefinitionSchema.safeParse({
        ...minimal,
        steps: [
          {
            id: "loop",
            kind: "retry",
            maxAttempts: 0,
            succeedsWhen: { stepId: "x", statusIs: "ok" },
            body: [{ id: "x", kind: "agent", agent: "a", task: "t" }],
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects succeedsWhen.statusIs values other than ok", () => {
    expect(
      WorkflowDefinitionSchema.safeParse({
        ...minimal,
        steps: [
          {
            id: "loop",
            kind: "retry",
            maxAttempts: 3,
            succeedsWhen: { stepId: "x", statusIs: "fail" },
            body: [{ id: "x", kind: "agent", agent: "a", task: "t" }],
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects a version of zero", () => {
    expect(
      WorkflowDefinitionSchema.safeParse({ ...minimal, version: 0 }).success,
    ).toBe(false);
  });

  it("rejects an agent step with an empty task", () => {
    expect(
      WorkflowDefinitionSchema.safeParse({
        ...minimal,
        steps: [{ id: "only", kind: "agent", agent: "writer", task: "" }],
      }).success,
    ).toBe(false);
  });

  it("rejects a gate step with an empty prompt", () => {
    expect(
      WorkflowDefinitionSchema.safeParse({
        ...minimal,
        steps: [{ id: "g", kind: "gate", prompt: "" }],
      }).success,
    ).toBe(false);
  });
});
