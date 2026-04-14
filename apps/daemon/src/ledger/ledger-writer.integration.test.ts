/**
 * Ledger writer — channelType threading.
 *
 * Scope:
 *
 * 1. Hook → ledger threading: when a conversation/session hook fires
 *    with `channelType`, the constructed `LedgerEvent` carries it
 *    through to every subscriber of `onAppended`. This is the
 *    fire-and-forget seam the SSE stream uses, so asserting on it is
 *    deterministic (no disk latency) and covers the same object that
 *    gets persisted.
 *
 * 2. The `channelType`/`chatId` pairing invariant: conversation and
 *    session events carry both, cron events carry neither.
 */

import { describe, it, expect } from "vitest";

import { withTmpRondel } from "../../../../tests/helpers/tmp.js";
import { createHooks } from "../shared/hooks.js";
import type { CronJob, CronRunResult } from "../shared/types/index.js";
import { LedgerWriter } from "./ledger-writer.js";
import type { LedgerEvent } from "./ledger-types.js";

// -----------------------------------------------------------------------------
// Helper: capture all events appended to the writer, regardless of agent.
// -----------------------------------------------------------------------------

function captureAppended(writer: LedgerWriter): LedgerEvent[] {
  const captured: LedgerEvent[] = [];
  writer.onAppended((e) => captured.push(e));
  return captured;
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe("LedgerWriter — channelType threading", () => {
  it("records channelType on user_message entries", () => {
    const tmp = withTmpRondel();
    const hooks = createHooks();
    const writer = new LedgerWriter(tmp.stateDir, hooks);
    const captured = captureAppended(writer);

    hooks.emit("conversation:message_in", {
      agentName: "alice",
      channelType: "telegram",
      chatId: "12345",
      text: "hello",
      senderId: "u1",
      senderName: "User One",
    });

    expect(captured).toHaveLength(1);
    expect(captured[0].kind).toBe("user_message");
    expect(captured[0].channelType).toBe("telegram");
    expect(captured[0].chatId).toBe("12345");
  });

  it("records channelType on agent_response entries", () => {
    const tmp = withTmpRondel();
    const hooks = createHooks();
    const writer = new LedgerWriter(tmp.stateDir, hooks);
    const captured = captureAppended(writer);

    hooks.emit("conversation:response", {
      agentName: "alice",
      channelType: "web",
      chatId: "web-chat-1",
      text: "hi there",
    });

    expect(captured).toHaveLength(1);
    expect(captured[0].kind).toBe("agent_response");
    expect(captured[0].channelType).toBe("web");
    expect(captured[0].chatId).toBe("web-chat-1");
  });

  it("distinguishes same chatId across different channels", () => {
    // Two conversations that share a chatId string but come from
    // different channels must produce two distinct ledger entries that
    // a consumer can tell apart — this is the core problem the change
    // exists to solve.
    const tmp = withTmpRondel();
    const hooks = createHooks();
    const writer = new LedgerWriter(tmp.stateDir, hooks);
    const captured = captureAppended(writer);

    hooks.emit("conversation:message_in", {
      agentName: "alice",
      channelType: "telegram",
      chatId: "1",
      text: "from telegram",
    });
    hooks.emit("conversation:message_in", {
      agentName: "alice",
      channelType: "web",
      chatId: "1",
      text: "from web",
    });

    expect(captured).toHaveLength(2);
    expect(captured[0].channelType).toBe("telegram");
    expect(captured[1].channelType).toBe("web");
    // chatId alone would collide — the test would fail without channelType.
    expect(captured[0].chatId).toBe(captured[1].chatId);
  });

  it("records channelType on every session lifecycle entry", () => {
    const tmp = withTmpRondel();
    const hooks = createHooks();
    const writer = new LedgerWriter(tmp.stateDir, hooks);
    const captured = captureAppended(writer);

    hooks.emit("session:start", {
      agentName: "alice",
      channelType: "telegram",
      chatId: "c1",
      sessionId: "sess-1111aaaa",
    });
    hooks.emit("session:resumed", {
      agentName: "alice",
      channelType: "telegram",
      chatId: "c1",
      sessionId: "sess-2222bbbb",
    });
    hooks.emit("session:reset", {
      agentName: "alice",
      channelType: "telegram",
      chatId: "c1",
    });
    hooks.emit("session:crash", {
      agentName: "alice",
      channelType: "telegram",
      chatId: "c1",
      sessionId: "sess-3333cccc",
    });
    hooks.emit("session:halt", {
      agentName: "alice",
      channelType: "telegram",
      chatId: "c1",
      sessionId: "sess-4444dddd",
    });

    expect(captured.map((e) => e.kind)).toEqual([
      "session_start",
      "session_resumed",
      "session_reset",
      "crash",
      "halt",
    ]);
    for (const entry of captured) {
      expect(entry.channelType).toBe("telegram");
      expect(entry.chatId).toBe("c1");
    }
  });
});

describe("LedgerWriter — invariant: channelType iff chatId", () => {
  it("cron_completed entries carry neither chatId nor channelType", () => {
    const tmp = withTmpRondel();
    const hooks = createHooks();
    const writer = new LedgerWriter(tmp.stateDir, hooks);
    const captured = captureAppended(writer);

    const job: CronJob = {
      id: "job-1",
      name: "daily-digest",
      schedule: { kind: "every", interval: "1h" },
      prompt: "Summarise yesterday",
      enabled: true,
    };
    const result: CronRunResult = {
      status: "ok",
      durationMs: 1234,
      costUsd: 0.0021,
    };

    hooks.emit("cron:completed", { agentName: "alice", job, result });

    expect(captured).toHaveLength(1);
    expect(captured[0].kind).toBe("cron_completed");
    expect(captured[0].chatId).toBeUndefined();
    expect(captured[0].channelType).toBeUndefined();
  });
});

