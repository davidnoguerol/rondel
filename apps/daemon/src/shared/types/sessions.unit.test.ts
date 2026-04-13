import { describe, it, expect } from "vitest";
import { conversationKey, parseConversationKey, type ConversationKey } from "./sessions.js";

describe("conversationKey", () => {
  it("builds a key in the documented order {agent}:{channel}:{chat}", () => {
    expect(conversationKey("kai", "telegram", "123")).toBe("kai:telegram:123");
  });

  it("produces distinct keys for the same chatId on different channels", () => {
    const a = conversationKey("kai", "telegram", "1");
    const b = conversationKey("kai", "slack", "1");
    expect(a).not.toBe(b);
  });

  it("preserves colons inside the chatId segment during construction", () => {
    expect(conversationKey("kai", "telegram", "-100:thread:7")).toBe(
      "kai:telegram:-100:thread:7",
    );
  });
});

describe("parseConversationKey", () => {
  it("round-trips a simple key", () => {
    const key = conversationKey("kai", "telegram", "123");
    expect(parseConversationKey(key)).toEqual(["kai", "telegram", "123"]);
  });

  it("preserves colons inside chatId on parse", () => {
    const key = conversationKey("kai", "telegram", "-100:thread:7");
    const [agent, channel, chatId] = parseConversationKey(key);
    expect(agent).toBe("kai");
    expect(channel).toBe("telegram");
    expect(chatId).toBe("-100:thread:7");
  });

  it("handles an empty chatId segment", () => {
    const key = conversationKey("kai", "telegram", "");
    expect(parseConversationKey(key)).toEqual(["kai", "telegram", ""]);
  });

  it("round-trips a table of representative inputs", () => {
    const cases: ReadonlyArray<[string, string, string]> = [
      ["alice", "telegram", "1"],
      ["bot_2", "slack", "C1234"],
      ["kai", "internal", "agent-mail"],
      ["a-b-c", "discord", "987654321"],
      ["kai", "telegram", "-100:supergroup:42"],
    ];
    for (const [agent, channel, chatId] of cases) {
      const key = conversationKey(agent, channel, chatId);
      expect(parseConversationKey(key)).toEqual([agent, channel, chatId]);
    }
  });
});

describe("ConversationKey uniqueness guarantees", () => {
  it("distinguishes agents with identical channel+chatId", () => {
    const a = conversationKey("alice", "telegram", "1");
    const b = conversationKey("bob", "telegram", "1");
    expect(a).not.toBe(b);
    expect(parseConversationKey(a)[0]).toBe("alice");
    expect(parseConversationKey(b)[0]).toBe("bob");
  });
});

describe("parseConversationKey (malformed input)", () => {
  // The branded type makes these unreachable in normal code paths, but
  // `as ConversationKey` casts exist in the codebase — harden the export.
  it("throws when the key has no colons", () => {
    expect(() => parseConversationKey("kaionly" as ConversationKey)).toThrow(
      /Malformed ConversationKey/,
    );
  });

  it("throws when the key has only one colon", () => {
    expect(() => parseConversationKey("kai:telegram" as ConversationKey)).toThrow(
      /Malformed ConversationKey/,
    );
  });

  it("throws on the empty string", () => {
    expect(() => parseConversationKey("" as ConversationKey)).toThrow(
      /Malformed ConversationKey/,
    );
  });
});
