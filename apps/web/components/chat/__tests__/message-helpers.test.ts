/**
 * Unit tests for convertMessage + extractText.
 *
 * These are thin adapter functions at the boundary between Rondel's
 * internal message shape and assistant-ui's public types. They're
 * small but easy to break — a wrong status or a dropped text part
 * manifests as a broken composer / missing message in the UI.
 *
 * `AppendMessage` from `@assistant-ui/react` is a structural type
 * ({ content: string | Part[] }). We construct minimal fixtures
 * matching only the fields `extractText` actually reads and cast
 * through `unknown` — the goal is to exercise the reducer, not to
 * re-test the upstream type.
 */

import { describe, expect, it } from "vitest";
import type { AppendMessage } from "@assistant-ui/react";

import type { DisplayMessage } from "../fold-frame";
import { convertMessage, extractText } from "../message-helpers";

function appendWith(
  content: AppendMessage["content"] | string
): AppendMessage {
  return { content } as unknown as AppendMessage;
}

describe("convertMessage", () => {
  it("maps a user DisplayMessage to a user ThreadMessageLike", () => {
    const m: DisplayMessage = {
      id: "u-1",
      role: "user",
      text: "hello",
      ts: "2026-04-18T10:00:00.000Z",
    };
    const tml = convertMessage(m);
    expect(tml.id).toBe("u-1");
    expect(tml.role).toBe("user");
    expect(tml.content).toEqual([{ type: "text", text: "hello" }]);
    expect(tml.createdAt).toBeInstanceOf(Date);
    expect((tml.createdAt as Date).toISOString()).toBe(
      "2026-04-18T10:00:00.000Z"
    );
    // User messages don't carry status in this mapping.
    expect("status" in tml).toBe(false);
  });

  it("omits createdAt when ts is missing", () => {
    const tml = convertMessage({ id: "u-1", role: "user", text: "hi" });
    expect(tml.createdAt).toBeUndefined();
  });

  it("maps a completed assistant message to status { complete, stop }", () => {
    const m: DisplayMessage = {
      id: "a-1",
      role: "assistant",
      text: "done",
      ts: "2026-04-18T10:00:01.000Z",
    };
    const tml = convertMessage(m);
    expect(tml.role).toBe("assistant");
    expect(tml.content).toEqual([{ type: "text", text: "done" }]);
    expect(tml.status).toEqual({ type: "complete", reason: "stop" });
  });

  it("maps a streaming assistant message to status { running }", () => {
    const m: DisplayMessage = {
      id: "stream-blk-1",
      role: "assistant",
      text: "partia",
      blockId: "blk-1",
      streaming: true,
    };
    const tml = convertMessage(m);
    expect(tml.status).toEqual({ type: "running" });
  });
});

describe("extractText", () => {
  it("returns the string content as-is", () => {
    expect(extractText(appendWith("hello"))).toBe("hello");
  });

  it("returns an empty string when content is an empty string", () => {
    expect(extractText(appendWith(""))).toBe("");
  });

  it("concatenates text parts from a parts array", () => {
    const msg = appendWith([
      { type: "text", text: "hello " },
      { type: "text", text: "world" },
    ] as unknown as AppendMessage["content"]);
    expect(extractText(msg)).toBe("hello world");
  });

  it("ignores non-text parts", () => {
    const msg = appendWith([
      { type: "text", text: "before" },
      { type: "image", image: "https://example.com/a.png" },
      { type: "text", text: " after" },
    ] as unknown as AppendMessage["content"]);
    expect(extractText(msg)).toBe("before after");
  });

  it("skips text parts whose `text` field is not a string", () => {
    const msg = appendWith([
      { type: "text", text: "ok " },
      { type: "text", text: 42 },
      { type: "text", text: "end" },
    ] as unknown as AppendMessage["content"]);
    expect(extractText(msg)).toBe("ok end");
  });

  it("returns an empty string when the parts array has no text parts", () => {
    const msg = appendWith([
      { type: "image", image: "https://example.com/a.png" },
    ] as unknown as AppendMessage["content"]);
    expect(extractText(msg)).toBe("");
  });
});
