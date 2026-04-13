/**
 * Unit tests for the web-chat additions to bridge/schemas.ts.
 *
 * Scope: the Zod shapes only — the runtime endpoint wiring is covered by
 * bridge integration tests. Kept in a separate file from schemas.unit.test.ts
 * so the focused failure mode reads "web chat schemas" instead of mixing
 * with the admin-endpoint assertions.
 */

import { describe, it, expect } from "vitest";
import {
  WebSendRequestSchema,
  ConversationTurnSchema,
  ConversationHistoryResponseSchema,
  ConversationStreamFrameSchema,
  validateBody,
} from "./schemas.js";

describe("WebSendRequestSchema", () => {
  const valid = {
    agent_name: "assistant",
    chat_id: "web-main",
    text: "hello",
  };

  it("accepts a minimal valid body", () => {
    expect(WebSendRequestSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects chat_id without the web- prefix", () => {
    const result = WebSendRequestSchema.safeParse({ ...valid, chat_id: "123" });
    expect(result.success).toBe(false);
  });

  it("rejects empty text", () => {
    const result = WebSendRequestSchema.safeParse({ ...valid, text: "" });
    expect(result.success).toBe(false);
  });

  it("rejects agent_name with invalid characters", () => {
    const result = WebSendRequestSchema.safeParse({ ...valid, agent_name: "bad name" });
    expect(result.success).toBe(false);
  });

  it("validateBody returns a structured error on failure", () => {
    const result = validateBody(WebSendRequestSchema, { ...valid, chat_id: "nope" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/chat_id/);
    }
  });
});

describe("ConversationTurnSchema", () => {
  it("accepts user and assistant roles with text", () => {
    expect(
      ConversationTurnSchema.safeParse({ role: "user", text: "hi" }).success,
    ).toBe(true);
    expect(
      ConversationTurnSchema.safeParse({ role: "assistant", text: "hello" }).success,
    ).toBe(true);
  });

  it("rejects unknown roles", () => {
    const result = ConversationTurnSchema.safeParse({ role: "system", text: "x" });
    expect(result.success).toBe(false);
  });
});

describe("ConversationHistoryResponseSchema", () => {
  it("accepts a valid response with turns and sessionId", () => {
    const result = ConversationHistoryResponseSchema.safeParse({
      turns: [{ role: "user", text: "hi" }, { role: "assistant", text: "hello" }],
      sessionId: "s-1",
    });
    expect(result.success).toBe(true);
  });

  it("accepts null sessionId for empty history", () => {
    const result = ConversationHistoryResponseSchema.safeParse({
      turns: [],
      sessionId: null,
    });
    expect(result.success).toBe(true);
  });
});

describe("ConversationStreamFrameSchema", () => {
  const ts = "2026-04-13T12:00:00.000Z";

  it("accepts a user_message frame", () => {
    const result = ConversationStreamFrameSchema.safeParse({
      event: "conversation.frame",
      data: { kind: "user_message", ts, text: "hi", senderName: "Web" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts an agent_response frame", () => {
    const result = ConversationStreamFrameSchema.safeParse({
      event: "conversation.frame",
      data: { kind: "agent_response", ts, text: "sure" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts typing_start / typing_stop frames", () => {
    for (const kind of ["typing_start", "typing_stop"] as const) {
      const result = ConversationStreamFrameSchema.safeParse({
        event: "conversation.frame",
        data: { kind, ts },
      });
      expect(result.success).toBe(true);
    }
  });

  it("accepts session frames with valid event", () => {
    const result = ConversationStreamFrameSchema.safeParse({
      event: "conversation.frame",
      data: { kind: "session", ts, event: "start", sessionId: "s1" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects the wrong event tag", () => {
    const result = ConversationStreamFrameSchema.safeParse({
      event: "ledger.appended",
      data: { kind: "user_message", ts, text: "hi" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown data.kind", () => {
    const result = ConversationStreamFrameSchema.safeParse({
      event: "conversation.frame",
      data: { kind: "unknown_kind", ts },
    });
    expect(result.success).toBe(false);
  });
});
