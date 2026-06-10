import { describe, it, expect } from "vitest";
import { TranscriptStreamSource, type TranscriptFrameData } from "./transcript-stream.js";
import type { SseFrame } from "./sse-types.js";
import { createHooks } from "../shared/hooks.js";

describe("TranscriptStreamSource", () => {
  it("fans transcript:appended notifications and turn:complete usage frames to clients", () => {
    const hooks = createHooks();
    const source = new TranscriptStreamSource(hooks);
    const frames: SseFrame<TranscriptFrameData>[] = [];
    const unsubscribe = source.subscribe((f) => frames.push(f));

    hooks.emit("transcript:appended", { agentName: "kai", sessionId: "s1", mode: "main", kind: "user" });
    hooks.emit("turn:complete", {
      agentName: "kai",
      sessionId: "s1",
      mode: "main",
      channelType: "telegram",
      chatId: "42",
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 },
      stopReason: "end_turn",
      isError: false,
      costUsd: 0.01,
      toolNames: ["rondel_bash"],
    });

    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatchObject({ event: "transcript.appended", data: { kind: "appended", agent: "kai", entryKind: "user" } });
    expect(frames[1]).toMatchObject({
      event: "transcript.turn",
      data: { kind: "turn", agent: "kai", usage: { inputTokens: 10 }, toolNames: ["rondel_bash"] },
    });

    unsubscribe();
    hooks.emit("transcript:appended", { agentName: "kai", sessionId: "s1", mode: "main", kind: "user" });
    expect(frames).toHaveLength(2);
  });

  it("dispose removes the hook listeners", () => {
    const hooks = createHooks();
    const source = new TranscriptStreamSource(hooks);
    const frames: SseFrame<TranscriptFrameData>[] = [];
    source.subscribe((f) => frames.push(f));
    source.dispose();
    hooks.emit("transcript:appended", { agentName: "kai", sessionId: "s1", mode: "main", kind: "user" });
    expect(frames).toHaveLength(0);
  });
});
