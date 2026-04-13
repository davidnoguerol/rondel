/**
 * Parser-only test for use-conversation-tail.
 *
 * The React hook itself needs a DOM (EventSource), which the node-environment
 * vitest setup doesn't provide. But the core correctness concern — "does the
 * Zod validator unwrap the frame correctly?" — is a pure function we can
 * exercise without mounting a component.
 *
 * We re-implement the parser inline (it is literally one line calling
 * `ConversationStreamFrameSchema.safeParse`). If the schema ever gets more
 * complex, this test guards the unwrap.
 */

import { describe, it, expect } from "vitest";

import {
  ConversationStreamFrameSchema,
  type ConversationStreamFrameData,
} from "../bridge/schemas";

function parseFrame(raw: unknown): ConversationStreamFrameData | null {
  const parsed = ConversationStreamFrameSchema.safeParse(raw);
  return parsed.success ? parsed.data.data : null;
}

describe("use-conversation-tail — parseFrame", () => {
  it("unwraps a well-formed user_message frame into its data payload", () => {
    const raw = {
      event: "conversation.frame",
      data: { kind: "user_message", ts: "2026-04-13T12:00:00.000Z", text: "hi" },
    };
    const result = parseFrame(raw);
    expect(result).not.toBeNull();
    expect(result?.kind).toBe("user_message");
    if (result?.kind === "user_message") {
      expect(result.text).toBe("hi");
    }
  });

  it("returns null for a frame with the wrong event tag", () => {
    const raw = {
      event: "ledger.appended",
      data: { kind: "user_message", ts: "x", text: "hi" },
    };
    expect(parseFrame(raw)).toBeNull();
  });

  it("returns null for a frame with an unknown kind", () => {
    const raw = {
      event: "conversation.frame",
      data: { kind: "something_else", ts: "x" },
    };
    expect(parseFrame(raw)).toBeNull();
  });

  it("returns null for non-object input", () => {
    expect(parseFrame(null)).toBeNull();
    expect(parseFrame("not a frame")).toBeNull();
    expect(parseFrame(42)).toBeNull();
  });
});
