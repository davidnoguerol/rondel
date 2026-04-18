import { describe, it, expect } from "vitest";
import {
  ToolUseApprovalCreateSchema,
  ApprovalResolveSchema,
  ApprovalRecordSchema,
  ApprovalListResponseSchema,
  ApprovalReasonSchema,
  validateBody,
} from "./schemas.js";

// ---------------------------------------------------------------------------
// ApprovalReasonSchema
// ---------------------------------------------------------------------------

describe("ApprovalReasonSchema", () => {
  const validReasons = [
    "dangerous_bash",
    "write_outside_safezone",
    "bash_system_write",
    "potential_secret_in_content",
    "unknown_tool",
    "agent_initiated",
  ];

  for (const reason of validReasons) {
    it(`accepts "${reason}"`, () => {
      expect(ApprovalReasonSchema.safeParse(reason).success).toBe(true);
    });
  }

  it("rejects dropped `unsupported_tty_tool` reason", () => {
    expect(ApprovalReasonSchema.safeParse("unsupported_tty_tool").success).toBe(false);
  });

  it("rejects unknown reason strings", () => {
    expect(ApprovalReasonSchema.safeParse("random_reason").success).toBe(false);
  });

  it("rejects empty string", () => {
    expect(ApprovalReasonSchema.safeParse("").success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ToolUseApprovalCreateSchema
// ---------------------------------------------------------------------------

describe("ToolUseApprovalCreateSchema", () => {
  const valid = {
    agentName: "bot1",
    toolName: "Bash",
    toolInput: { command: "rm -rf /" },
    reason: "dangerous_bash",
  };

  it("accepts a minimal valid body (no channel info)", () => {
    expect(ToolUseApprovalCreateSchema.safeParse(valid).success).toBe(true);
  });

  it("accepts with channelType and chatId", () => {
    const result = ToolUseApprovalCreateSchema.safeParse({
      ...valid,
      channelType: "telegram",
      chatId: "123",
    });
    expect(result.success).toBe(true);
  });

  it("accepts with undefined toolInput", () => {
    const { toolInput: _, ...rest } = valid;
    expect(ToolUseApprovalCreateSchema.safeParse(rest).success).toBe(true);
  });

  it("rejects missing agentName", () => {
    const { agentName: _, ...rest } = valid;
    expect(ToolUseApprovalCreateSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects invalid agentName (starts with hyphen)", () => {
    expect(
      ToolUseApprovalCreateSchema.safeParse({ ...valid, agentName: "-bad" }).success,
    ).toBe(false);
  });

  it("rejects missing toolName", () => {
    const { toolName: _, ...rest } = valid;
    expect(ToolUseApprovalCreateSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects empty toolName", () => {
    expect(
      ToolUseApprovalCreateSchema.safeParse({ ...valid, toolName: "" }).success,
    ).toBe(false);
  });

  it("rejects missing reason", () => {
    const { reason: _, ...rest } = valid;
    expect(ToolUseApprovalCreateSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects invalid reason value", () => {
    expect(
      ToolUseApprovalCreateSchema.safeParse({ ...valid, reason: "not_a_reason" }).success,
    ).toBe(false);
  });

  it("rejects empty channelType when present", () => {
    expect(
      ToolUseApprovalCreateSchema.safeParse({ ...valid, channelType: "" }).success,
    ).toBe(false);
  });

  it("rejects empty chatId when present", () => {
    expect(
      ToolUseApprovalCreateSchema.safeParse({ ...valid, chatId: "" }).success,
    ).toBe(false);
  });

  it("produces path-prefixed error via validateBody", () => {
    const result = validateBody(ToolUseApprovalCreateSchema, { ...valid, reason: "bad" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/^reason: /);
    }
  });
});

// ---------------------------------------------------------------------------
// ApprovalResolveSchema
// ---------------------------------------------------------------------------

describe("ApprovalResolveSchema", () => {
  it("accepts allow decision", () => {
    expect(ApprovalResolveSchema.safeParse({ decision: "allow" }).success).toBe(true);
  });

  it("accepts deny decision", () => {
    expect(ApprovalResolveSchema.safeParse({ decision: "deny" }).success).toBe(true);
  });

  it("accepts with optional resolvedBy", () => {
    expect(
      ApprovalResolveSchema.safeParse({ decision: "allow", resolvedBy: "user:42" }).success,
    ).toBe(true);
  });

  it("rejects missing decision", () => {
    expect(ApprovalResolveSchema.safeParse({}).success).toBe(false);
  });

  it("rejects invalid decision value", () => {
    expect(ApprovalResolveSchema.safeParse({ decision: "maybe" }).success).toBe(false);
  });

  it("rejects empty resolvedBy", () => {
    expect(
      ApprovalResolveSchema.safeParse({ decision: "allow", resolvedBy: "" }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ApprovalRecordSchema
// ---------------------------------------------------------------------------

describe("ApprovalRecordSchema", () => {
  it("accepts a valid tool-use record", () => {
    const result = ApprovalRecordSchema.safeParse({
      requestId: "appr_123",
      status: "pending",
      agentName: "bot1",
      toolName: "Bash",
      summary: "Bash: rm -rf /",
      reason: "dangerous_bash",
      createdAt: "2026-04-15T12:00:00Z",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a resolved tool-use record", () => {
    const result = ApprovalRecordSchema.safeParse({
      requestId: "appr_456",
      status: "resolved",
      agentName: "bot1",
      toolName: "Write",
      summary: "Write /etc/passwd",
      reason: "write_outside_safezone",
      createdAt: "2026-04-15T12:00:00Z",
      resolvedAt: "2026-04-15T12:01:00Z",
      decision: "deny",
      resolvedBy: "user:1",
    });
    expect(result.success).toBe(true);
  });

  it("rejects record with invalid status", () => {
    const result = ApprovalRecordSchema.safeParse({
      requestId: "appr_123",
      status: "waiting", // invalid
      agentName: "bot1",
      toolName: "Bash",
      summary: "x",
      reason: "dangerous_bash",
      createdAt: "2026-04-15T12:00:00Z",
    });
    expect(result.success).toBe(false);
  });

  it("rejects record missing required toolName", () => {
    const result = ApprovalRecordSchema.safeParse({
      requestId: "appr_123",
      status: "pending",
      agentName: "bot1",
      summary: "x",
      reason: "dangerous_bash",
      createdAt: "2026-04-15T12:00:00Z",
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ApprovalListResponseSchema
// ---------------------------------------------------------------------------

describe("ApprovalListResponseSchema", () => {
  it("accepts empty pending and resolved arrays", () => {
    expect(
      ApprovalListResponseSchema.safeParse({ pending: [], resolved: [] }).success,
    ).toBe(true);
  });

  it("accepts a list of tool-use records", () => {
    const result = ApprovalListResponseSchema.safeParse({
      pending: [
        {
          requestId: "appr_1",
          status: "pending",
          agentName: "bot1",
          toolName: "Bash",
          summary: "x",
          reason: "dangerous_bash",
          createdAt: "2026-04-15T12:00:00Z",
        },
      ],
      resolved: [
        {
          requestId: "appr_2",
          status: "resolved",
          agentName: "bot1",
          toolName: "Write",
          summary: "Write /etc/passwd",
          reason: "write_outside_safezone",
          createdAt: "2026-04-15T12:00:00Z",
          resolvedAt: "2026-04-15T12:01:00Z",
          decision: "deny",
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing pending array", () => {
    expect(
      ApprovalListResponseSchema.safeParse({ resolved: [] }).success,
    ).toBe(false);
  });
});
