import { describe, it, expect } from "vitest";
import {
  AddAgentSchema,
  UpdateAgentSchema,
  AddOrgSchema,
  SetEnvSchema,
  SendMessageSchema,
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
