/**
 * Ledger ↔ transcript substrate integration.
 *
 * The transcript design links ledger rows to transcript spans: conversation
 * events carry sessionId in their detail payloads, session_reset carries the
 * abandoned priorSessionId, and session:compacted produces its own row.
 */

import { describe, it, expect } from "vitest";
import { LedgerWriter } from "./ledger-writer.js";
import type { LedgerEvent } from "./ledger-types.js";
import { createHooks } from "../shared/hooks.js";
import { withTmpRondel } from "../../../../tests/helpers/tmp.js";

function setup() {
  const tmp = withTmpRondel();
  const hooks = createHooks();
  const writer = new LedgerWriter(tmp.stateDir, hooks);
  const captured: LedgerEvent[] = [];
  writer.onAppended((e) => captured.push(e));
  return { hooks, captured };
}

describe("LedgerWriter — transcript links", () => {
  it("user_message and agent_response details carry the sessionId", () => {
    const { hooks, captured } = setup();
    hooks.emit("conversation:message_in", { agentName: "alice", channelType: "telegram", chatId: "1", text: "hi", sessionId: "sess-9" });
    hooks.emit("conversation:response", { agentName: "alice", channelType: "telegram", chatId: "1", text: "hello", sessionId: "sess-9" });

    expect((captured[0]!.detail as { sessionId?: string }).sessionId).toBe("sess-9");
    expect((captured[1]!.detail as { sessionId?: string }).sessionId).toBe("sess-9");
  });

  it("session_reset detail carries the abandoned priorSessionId", () => {
    const { hooks, captured } = setup();
    hooks.emit("session:reset", { agentName: "alice", channelType: "telegram", chatId: "1", priorSessionId: "sess-old" });
    expect(captured[0]!.kind).toBe("session_reset");
    expect((captured[0]!.detail as { priorSessionId?: string }).priorSessionId).toBe("sess-old");
  });

  it("session:compacted produces a session_compacted row with trigger + summary length", () => {
    const { hooks, captured } = setup();
    hooks.emit("session:compacted", {
      agentName: "alice",
      sessionId: "sess-9",
      mode: "main",
      channelType: "telegram",
      chatId: "1",
      trigger: "auto",
      summaryLength: 1234,
    });
    expect(captured[0]!.kind).toBe("session_compacted");
    expect(captured[0]!.summary).toContain("auto");
    expect(captured[0]!.detail).toMatchObject({ sessionId: "sess-9", trigger: "auto", summaryLength: 1234 });
  });
});
