/**
 * Unit tests for foldFrame — the pure reducer that drives the chat
 * runtime's message list.
 *
 * The reducer is the single most load-bearing piece of the chat UI.
 * Getting any of these cases wrong means users see duplicated, missing,
 * or mis-ordered messages. The frame kinds covered here map 1:1 to the
 * `ConversationStreamFrameData` discriminated union — if a new kind is
 * added, a test should be added alongside.
 */

import { describe, expect, it } from "vitest";

import type { ConversationTailFrame } from "../../../lib/streams";

import { foldFrame, type DisplayMessage } from "../fold-frame";

function userFrame(text: string, ts = "2026-04-18T10:00:00.000Z"): ConversationTailFrame {
  return { kind: "user_message", ts, text };
}

function agentFrame(
  text: string,
  blockId?: string,
  ts = "2026-04-18T10:00:01.000Z"
): ConversationTailFrame {
  return { kind: "agent_response", ts, text, blockId };
}

function deltaFrame(
  blockId: string,
  chunk: string,
  ts = "2026-04-18T10:00:02.000Z"
): ConversationTailFrame {
  return { kind: "agent_response_delta", ts, blockId, chunk };
}

describe("foldFrame — user_message", () => {
  it("appends when there is no optimistic bubble", () => {
    const prev: DisplayMessage[] = [];
    const next = foldFrame(prev, userFrame("hi"));
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({
      role: "user",
      text: "hi",
      ts: "2026-04-18T10:00:00.000Z",
    });
    expect(next[0].optimistic).toBeUndefined();
  });

  it("reconciles a matching optimistic bubble (same text) instead of duplicating", () => {
    const prev: DisplayMessage[] = [
      {
        id: "opt-123",
        role: "user",
        text: "hi",
        ts: "2026-04-18T09:59:59.999Z",
        optimistic: true,
      },
    ];
    const next = foldFrame(prev, userFrame("hi"));
    expect(next).toHaveLength(1);
    expect(next[0].optimistic).toBeUndefined();
    // Id is preserved across the optimistic → server reconcile so that
    // assistant-ui treats it as the same message (not a new branch).
    expect(next[0].id).toBe("opt-123");
    expect(next[0].text).toBe("hi");
    expect(next[0].ts).toBe("2026-04-18T10:00:00.000Z");
  });

  it("appends when the optimistic bubble text does not match the frame", () => {
    const prev: DisplayMessage[] = [
      { id: "opt-1", role: "user", text: "hello", optimistic: true },
    ];
    const next = foldFrame(prev, userFrame("goodbye"));
    expect(next).toHaveLength(2);
    expect(next[0].optimistic).toBe(true); // optimistic kept (different text)
    expect(next[1].text).toBe("goodbye");
    expect(next[1].optimistic).toBeUndefined();
  });

  it("reconciles the FIRST matching optimistic bubble when duplicates exist (FIFO)", () => {
    const prev: DisplayMessage[] = [
      { id: "opt-a", role: "user", text: "ping", optimistic: true },
      { id: "opt-b", role: "user", text: "ping", optimistic: true },
    ];
    const next = foldFrame(prev, userFrame("ping"));
    expect(next).toHaveLength(2);
    // First one got reconciled; second one still optimistic.
    expect(next[0].optimistic).toBeUndefined();
    expect(next[1]).toMatchObject({ id: "opt-b", optimistic: true });
  });

  it("does NOT reconcile an assistant bubble that happens to match text", () => {
    const prev: DisplayMessage[] = [
      { id: "a-1", role: "assistant", text: "hi" }, // same text, wrong role
    ];
    const next = foldFrame(prev, userFrame("hi"));
    expect(next).toHaveLength(2);
    expect(next[1].role).toBe("user");
  });
});

describe("foldFrame — agent_response", () => {
  it("appends a fresh assistant bubble when no matching blockId exists", () => {
    const prev: DisplayMessage[] = [];
    const next = foldFrame(prev, agentFrame("hello there", "blk-1"));
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({
      role: "assistant",
      text: "hello there",
      blockId: "blk-1",
    });
    expect(next[0].streaming).toBeUndefined();
  });

  it("appends when the frame has no blockId at all", () => {
    const prev: DisplayMessage[] = [];
    const next = foldFrame(prev, agentFrame("no block"));
    expect(next).toHaveLength(1);
    expect(next[0].text).toBe("no block");
    expect(next[0].blockId).toBeUndefined();
  });

  it("replaces a streaming bubble in-place when blockId matches", () => {
    const prev: DisplayMessage[] = [
      {
        id: "stream-blk-1",
        role: "assistant",
        text: "hel",
        blockId: "blk-1",
        streaming: true,
      },
    ];
    const next = foldFrame(
      prev,
      agentFrame("hello there", "blk-1", "2026-04-18T10:00:05.000Z")
    );
    expect(next).toHaveLength(1);
    expect(next[0].text).toBe("hello there");
    expect(next[0].streaming).toBe(false);
    expect(next[0].ts).toBe("2026-04-18T10:00:05.000Z");
    expect(next[0].blockId).toBe("blk-1");
    // Id preserved so assistant-ui doesn't branch the completed bubble
    // away from the streamed one.
    expect(next[0].id).toBe("stream-blk-1");
  });

  it("appends (not replaces) when blockId exists but no bubble matches", () => {
    const prev: DisplayMessage[] = [
      {
        id: "stream-blk-1",
        role: "assistant",
        text: "hel",
        blockId: "blk-1",
        streaming: true,
      },
    ];
    const next = foldFrame(prev, agentFrame("new block", "blk-2"));
    expect(next).toHaveLength(2);
    expect(next[0].streaming).toBe(true); // untouched
    expect(next[1].blockId).toBe("blk-2");
  });
});

describe("foldFrame — agent_response_delta", () => {
  it("creates a streaming bubble on the first delta for a new blockId", () => {
    const prev: DisplayMessage[] = [];
    const next = foldFrame(prev, deltaFrame("blk-1", "Hel"));
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({
      role: "assistant",
      text: "Hel",
      blockId: "blk-1",
      streaming: true,
    });
    expect(next[0].id).toBe("stream-blk-1");
  });

  it("appends chunks to an existing streaming bubble", () => {
    const prev: DisplayMessage[] = [
      {
        id: "stream-blk-1",
        role: "assistant",
        text: "Hel",
        blockId: "blk-1",
        streaming: true,
      },
    ];
    const after1 = foldFrame(prev, deltaFrame("blk-1", "lo"));
    const after2 = foldFrame(after1, deltaFrame("blk-1", " world"));
    expect(after2).toHaveLength(1);
    expect(after2[0].text).toBe("Hello world");
    expect(after2[0].streaming).toBe(true);
  });

  it("does not affect bubbles with a different blockId", () => {
    const prev: DisplayMessage[] = [
      {
        id: "stream-blk-1",
        role: "assistant",
        text: "one",
        blockId: "blk-1",
        streaming: true,
      },
    ];
    const next = foldFrame(prev, deltaFrame("blk-2", "two"));
    expect(next).toHaveLength(2);
    expect(next[0].text).toBe("one");
    expect(next[1].text).toBe("two");
    expect(next[1].blockId).toBe("blk-2");
  });
});

describe("foldFrame — non-message frames are no-ops for message state", () => {
  const prev: DisplayMessage[] = [
    { id: "u-1", role: "user", text: "hi" },
    { id: "a-1", role: "assistant", text: "hello" },
  ];

  it("typing_start returns prev identity", () => {
    const frame: ConversationTailFrame = {
      kind: "typing_start",
      ts: "2026-04-18T10:00:00.000Z",
    };
    expect(foldFrame(prev, frame)).toBe(prev);
  });

  it("typing_stop returns prev identity", () => {
    const frame: ConversationTailFrame = {
      kind: "typing_stop",
      ts: "2026-04-18T10:00:00.000Z",
    };
    expect(foldFrame(prev, frame)).toBe(prev);
  });

  it("session returns prev identity", () => {
    const frame: ConversationTailFrame = {
      kind: "session",
      ts: "2026-04-18T10:00:00.000Z",
      event: "start",
      sessionId: "sess-1",
    };
    expect(foldFrame(prev, frame)).toBe(prev);
  });
});

describe("foldFrame — immutability", () => {
  it("does not mutate the input array on reconcile", () => {
    const prev: DisplayMessage[] = [
      { id: "opt-1", role: "user", text: "hi", optimistic: true },
    ];
    const snapshot = [...prev];
    foldFrame(prev, userFrame("hi"));
    expect(prev).toEqual(snapshot);
    expect(prev[0].optimistic).toBe(true);
  });

  it("does not mutate the input array on delta fold", () => {
    const prev: DisplayMessage[] = [
      {
        id: "stream-blk-1",
        role: "assistant",
        text: "Hel",
        blockId: "blk-1",
        streaming: true,
      },
    ];
    const snapshot = [{ ...prev[0] }];
    foldFrame(prev, deltaFrame("blk-1", "lo"));
    expect(prev[0]).toEqual(snapshot[0]);
  });
});
