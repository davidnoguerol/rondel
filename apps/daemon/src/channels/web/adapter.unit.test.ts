/**
 * Unit tests for WebChannelAdapter.
 *
 * Scope: the adapter-local state machine only — account registration,
 * per-conversation frame fan-out, ring buffer bounds, inbound ingestion,
 * typing indicators. We don't boot Router or hooks; those integrations are
 * covered by higher-level tests.
 */

import { describe, it, expect, beforeEach } from "vitest";

import { WebChannelAdapter, type WebChannelFrame } from "./adapter.js";
import type { ChannelMessage } from "../core/channel.js";

function silentLogger() {
  // Minimal Logger stub — the adapter only calls .info/.warn/.child. `child`
  // returns the same logger so nested calls compile.
  const log: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
    debug: (msg: string) => void;
    child: (ns: string) => typeof log;
  } = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    child: () => log,
  };
  // The adapter's Logger type is structurally compatible with this shape.
  return log as unknown as import("../../shared/logger.js").Logger;
}

describe("WebChannelAdapter — account lifecycle", () => {
  let adapter: WebChannelAdapter;

  beforeEach(() => {
    adapter = new WebChannelAdapter(silentLogger());
  });

  it("registers and removes accounts", () => {
    adapter.addAccount("alice", { primary: "", extra: {} });
    expect(() => adapter.addAccount("alice", { primary: "", extra: {} })).toThrow(
      /already registered/,
    );
    adapter.removeAccount("alice");
    // Re-adding after removal must succeed.
    expect(() => adapter.addAccount("alice", { primary: "", extra: {} })).not.toThrow();
  });

  it("sendText throws for an unknown account", async () => {
    await expect(adapter.sendText("ghost", "web-1", "hi")).rejects.toThrow(/Unknown web account/);
  });

  it("typing indicators are no-ops for unknown accounts", () => {
    // No-op means: no throw, no frame fan-out (no subscribers yet anyway).
    expect(() => adapter.startTypingIndicator("ghost", "web-1")).not.toThrow();
    expect(() => adapter.stopTypingIndicator("ghost", "web-1")).not.toThrow();
  });
});

describe("WebChannelAdapter — ingestUserMessage", () => {
  it("dispatches a normalized ChannelMessage to every registered handler", () => {
    const adapter = new WebChannelAdapter(silentLogger());
    adapter.addAccount("alice", { primary: "", extra: {} });

    const received: ChannelMessage[] = [];
    adapter.onMessage((msg) => received.push(msg));

    adapter.ingestUserMessage({ accountId: "alice", chatId: "web-1", text: "hello" });

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      channelType: "web",
      accountId: "alice",
      chatId: "web-1",
      text: "hello",
      senderId: "web-user",
      senderName: "Web",
    });
    expect(typeof received[0].messageId).toBe("number");
  });

  it("a throwing handler does not prevent sibling handlers from running", () => {
    const adapter = new WebChannelAdapter(silentLogger());
    adapter.addAccount("alice", { primary: "", extra: {} });

    let good = 0;
    adapter.onMessage(() => {
      throw new Error("boom");
    });
    adapter.onMessage(() => {
      good++;
    });

    expect(() =>
      adapter.ingestUserMessage({ accountId: "alice", chatId: "web-1", text: "hi" }),
    ).not.toThrow();
    expect(good).toBe(1);
  });
});

describe("WebChannelAdapter — fan-out and ring buffer", () => {
  it("sendText fans out an agent_response frame to subscribers of that conversation only", async () => {
    const adapter = new WebChannelAdapter(silentLogger());
    adapter.addAccount("alice", { primary: "", extra: {} });

    const aliceChat1: WebChannelFrame[] = [];
    const aliceChat2: WebChannelFrame[] = [];
    adapter.subscribeConversation("alice", "web-1", (f) => aliceChat1.push(f));
    adapter.subscribeConversation("alice", "web-2", (f) => aliceChat2.push(f));

    await adapter.sendText("alice", "web-1", "response to chat 1");

    expect(aliceChat1).toHaveLength(1);
    expect(aliceChat1[0]).toMatchObject({ kind: "agent_response", text: "response to chat 1" });
    expect(aliceChat2).toHaveLength(0);
  });

  it("startTypingIndicator / stopTypingIndicator dispatch typing frames", () => {
    const adapter = new WebChannelAdapter(silentLogger());
    adapter.addAccount("alice", { primary: "", extra: {} });

    const frames: WebChannelFrame[] = [];
    adapter.subscribeConversation("alice", "web-1", (f) => frames.push(f));

    adapter.startTypingIndicator("alice", "web-1");
    adapter.stopTypingIndicator("alice", "web-1");

    expect(frames.map((f) => f.kind)).toEqual(["typing_start", "typing_stop"]);
  });

  it("unsubscribe stops further frame delivery", async () => {
    const adapter = new WebChannelAdapter(silentLogger());
    adapter.addAccount("alice", { primary: "", extra: {} });

    const frames: WebChannelFrame[] = [];
    const unsub = adapter.subscribeConversation("alice", "web-1", (f) => frames.push(f));

    await adapter.sendText("alice", "web-1", "first");
    unsub();
    await adapter.sendText("alice", "web-1", "second");

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ text: "first" });
  });

  it("ring buffer accumulates recent frames and is returned by getRingBuffer", async () => {
    const adapter = new WebChannelAdapter(silentLogger());
    adapter.addAccount("alice", { primary: "", extra: {} });

    for (let i = 0; i < 5; i++) {
      await adapter.sendText("alice", "web-1", `msg ${i}`);
    }

    const buf = adapter.getRingBuffer("alice", "web-1");
    expect(buf).toHaveLength(5);
    expect(buf.map((f) => (f.kind === "agent_response" ? f.text : null))).toEqual([
      "msg 0", "msg 1", "msg 2", "msg 3", "msg 4",
    ]);
  });

  it("ring buffer is bounded — oldest frames are dropped when full", async () => {
    const adapter = new WebChannelAdapter(silentLogger());
    adapter.addAccount("alice", { primary: "", extra: {} });

    // Exceed RING_BUFFER_SIZE (20). We send 25 and assert only the last 20
    // survive. This test pins the boundedness contract — if the constant
    // changes, update both the source and this assertion.
    for (let i = 0; i < 25; i++) {
      await adapter.sendText("alice", "web-1", `m${i}`);
    }
    const buf = adapter.getRingBuffer("alice", "web-1");
    expect(buf).toHaveLength(20);
    // First should be m5 (we dropped m0..m4), last should be m24.
    const first = buf[0];
    const last = buf[buf.length - 1];
    expect(first.kind === "agent_response" ? first.text : null).toBe("m5");
    expect(last.kind === "agent_response" ? last.text : null).toBe("m24");
  });

  it("a throwing listener does not break sibling delivery", async () => {
    const adapter = new WebChannelAdapter(silentLogger());
    adapter.addAccount("alice", { primary: "", extra: {} });

    let good = 0;
    adapter.subscribeConversation("alice", "web-1", () => {
      throw new Error("boom");
    });
    adapter.subscribeConversation("alice", "web-1", () => {
      good++;
    });

    await expect(adapter.sendText("alice", "web-1", "hi")).resolves.toBeUndefined();
    expect(good).toBe(1);
  });
});

describe("WebChannelAdapter — removeAccount cleanup", () => {
  it("drops per-conversation buffers scoped to the removed account", async () => {
    const adapter = new WebChannelAdapter(silentLogger());
    adapter.addAccount("alice", { primary: "", extra: {} });
    adapter.addAccount("bob", { primary: "", extra: {} });

    await adapter.sendText("alice", "web-1", "hi");
    await adapter.sendText("bob", "web-1", "hello");

    adapter.removeAccount("alice");

    expect(adapter.getRingBuffer("alice", "web-1")).toHaveLength(0);
    expect(adapter.getRingBuffer("bob", "web-1")).toHaveLength(1);
  });
});
