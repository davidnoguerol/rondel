/**
 * Unit tests for ConversationStreamSource.
 *
 * Scope: per-conversation hook filtering, session lifecycle frames,
 * web-adapter typing frame forwarding, dispose semantics. We build a real
 * RondelHooks (it's a plain EventEmitter) and a real WebChannelAdapter with
 * a silent logger — both are cheap, no I/O.
 */

import { describe, it, expect, beforeEach } from "vitest";

import { createHooks, type RondelHooks } from "../shared/hooks.js";
import { WebChannelAdapter } from "../channels/web/adapter.js";
import {
  ConversationStreamSource,
  type ConversationStreamFrame,
} from "./conversation-stream.js";
import type { SseFrame } from "./sse-types.js";

function silentLogger() {
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
  return log as unknown as import("../shared/logger.js").Logger;
}

function collect(source: ConversationStreamSource): {
  frames: ConversationStreamFrame[];
  unsub: () => void;
} {
  const frames: ConversationStreamFrame[] = [];
  const unsub = source.subscribe((frame: SseFrame<ConversationStreamFrame>) => {
    frames.push(frame.data);
  });
  return { frames, unsub };
}

describe("ConversationStreamSource — hook filtering", () => {
  let hooks: RondelHooks;

  beforeEach(() => {
    hooks = createHooks();
  });

  it("emits a user_message frame when conversation:message_in matches the target", () => {
    const source = new ConversationStreamSource({
      agentName: "alice",
      channelType: "web",
      chatId: "web-1",
      hooks,
    });
    const { frames } = collect(source);

    hooks.emit("conversation:message_in", {
      agentName: "alice",
      chatId: "web-1",
      text: "hello",
      senderName: "Web",
    });

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      kind: "user_message",
      text: "hello",
      senderName: "Web",
    });
  });

  it("ignores events for a different agent or chatId", () => {
    const source = new ConversationStreamSource({
      agentName: "alice",
      channelType: "web",
      chatId: "web-1",
      hooks,
    });
    const { frames } = collect(source);

    hooks.emit("conversation:message_in", {
      agentName: "bob", // wrong agent
      chatId: "web-1",
      text: "not me",
    });
    hooks.emit("conversation:message_in", {
      agentName: "alice",
      chatId: "web-2", // wrong chat
      text: "not me either",
    });

    expect(frames).toHaveLength(0);
  });

  it("emits agent_response frames from conversation:response", () => {
    const source = new ConversationStreamSource({
      agentName: "alice",
      channelType: "web",
      chatId: "web-1",
      hooks,
    });
    const { frames } = collect(source);

    hooks.emit("conversation:response", {
      agentName: "alice",
      chatId: "web-1",
      text: "sure thing",
    });

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ kind: "agent_response", text: "sure thing" });
  });

  it("emits session frames for start/crash/halt", () => {
    const source = new ConversationStreamSource({
      agentName: "alice",
      channelType: "web",
      chatId: "web-1",
      hooks,
    });
    const { frames } = collect(source);

    hooks.emit("session:start", { agentName: "alice", chatId: "web-1", sessionId: "s1" });
    hooks.emit("session:crash", { agentName: "alice", chatId: "web-1", sessionId: "s1" });
    hooks.emit("session:halt", { agentName: "alice", chatId: "web-1", sessionId: "s1" });

    expect(frames.map((f) => (f.kind === "session" ? f.event : f.kind))).toEqual([
      "start", "crash", "halt",
    ]);
  });
});

describe("ConversationStreamSource — web adapter typing frames", () => {
  it("forwards typing_start / typing_stop from the web adapter for web channels", () => {
    const hooks = createHooks();
    const adapter = new WebChannelAdapter(silentLogger());
    adapter.addAccount("alice", { primary: "", extra: {} });

    const source = new ConversationStreamSource({
      agentName: "alice",
      channelType: "web",
      chatId: "web-1",
      hooks,
      webAdapter: adapter,
    });
    const { frames } = collect(source);

    adapter.startTypingIndicator("alice", "web-1");
    adapter.stopTypingIndicator("alice", "web-1");

    expect(frames.map((f) => f.kind)).toEqual(["typing_start", "typing_stop"]);
  });

  it("does NOT forward agent_response from the web adapter (dedupes with hooks)", async () => {
    // The adapter publishes an agent_response frame via sendText, but the
    // hooks path already emits one for every text block. Double-forwarding
    // would duplicate entries in the merged web UI timeline.
    const hooks = createHooks();
    const adapter = new WebChannelAdapter(silentLogger());
    adapter.addAccount("alice", { primary: "", extra: {} });

    const source = new ConversationStreamSource({
      agentName: "alice",
      channelType: "web",
      chatId: "web-1",
      hooks,
      webAdapter: adapter,
    });
    const { frames } = collect(source);

    await adapter.sendText("alice", "web-1", "from adapter");

    // Only the adapter fired — no hook — so the stream should be empty
    // because the web-frame translator drops agent_response.
    expect(frames).toHaveLength(0);
  });

  it("emits agent_response exactly once when both hook and adapter fire for the same text", async () => {
    // In production, every text block triggers BOTH:
    //   (a) hooks.emit("conversation:response", ...) from the agent process
    //   (b) webAdapter.sendText(...) from the Router's outbound path
    // The dedup contract is: hooks emit, adapter drops. This test pins both
    // halves — if someone ever unscrews `translateWebFrame` to pass
    // agent_response through, the browser timeline would get duplicate text.
    const hooks = createHooks();
    const adapter = new WebChannelAdapter(silentLogger());
    adapter.addAccount("alice", { primary: "", extra: {} });

    const source = new ConversationStreamSource({
      agentName: "alice",
      channelType: "web",
      chatId: "web-1",
      hooks,
      webAdapter: adapter,
    });
    const { frames } = collect(source);

    // Fire both paths in the realistic order: hook first (agent process
    // emits before Router calls sendText), adapter second.
    hooks.emit("conversation:response", { agentName: "alice", chatId: "web-1", text: "reply" });
    await adapter.sendText("alice", "web-1", "reply");

    const responses = frames.filter((f) => f.kind === "agent_response");
    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({ kind: "agent_response", text: "reply" });
  });

  it("replayRingBuffer emits typing frames that the adapter has cached", () => {
    const hooks = createHooks();
    const adapter = new WebChannelAdapter(silentLogger());
    adapter.addAccount("alice", { primary: "", extra: {} });

    adapter.startTypingIndicator("alice", "web-1");
    adapter.stopTypingIndicator("alice", "web-1");

    const source = new ConversationStreamSource({
      agentName: "alice",
      channelType: "web",
      chatId: "web-1",
      hooks,
      webAdapter: adapter,
    });

    const replayed: ConversationStreamFrame[] = [];
    source.replayRingBuffer((frame) => replayed.push(frame.data));

    expect(replayed.map((f) => f.kind)).toEqual(["typing_start", "typing_stop"]);
  });
});

describe("ConversationStreamSource — dispose", () => {
  it("unsubscribes from hooks on dispose", () => {
    const hooks = createHooks();
    const source = new ConversationStreamSource({
      agentName: "alice",
      channelType: "web",
      chatId: "web-1",
      hooks,
    });
    const { frames } = collect(source);

    source.dispose();

    hooks.emit("conversation:message_in", {
      agentName: "alice",
      chatId: "web-1",
      text: "should not arrive",
    });

    expect(frames).toHaveLength(0);
  });

  it("getClientCount tracks subscribe / unsubscribe", () => {
    const source = new ConversationStreamSource({
      agentName: "alice",
      channelType: "web",
      chatId: "web-1",
      hooks: createHooks(),
    });
    expect(source.getClientCount()).toBe(0);

    const unsubA = source.subscribe(() => {});
    const unsubB = source.subscribe(() => {});
    expect(source.getClientCount()).toBe(2);

    unsubA();
    expect(source.getClientCount()).toBe(1);
    unsubB();
    expect(source.getClientCount()).toBe(0);
  });
});
