/**
 * Unit tests for ConversationManager's post-turn restart scheduling surface.
 *
 * Scope: the pending-restart Set that backs `rondel_reload_skills`. These are
 * pure in-memory operations — no process is spawned, no file is touched.
 *
 * What's covered here:
 *   - `scheduleRestartAfterTurn` returns false when no conversation exists
 *     (the "stale tool call" path: agent reset between authoring the tool
 *     call and the bridge receiving the HTTP POST).
 *   - `hasPendingRestart` is false for an unscheduled key.
 *   - `clearPendingRestart` is idempotent on an unscheduled key.
 *
 * What's deferred to Tier 3 (see docs/TESTING.md §10 — apps/daemon/src/agents/
 * is deferred until a mocked-CLI harness exists):
 *   - The happy-path `scheduleRestartAfterTurn → true` transition requires an
 *     AgentProcess in the conversations Map, which in turn requires spawning
 *     a real Claude CLI child process.
 *   - The Router's `consumePendingRestart` → `process.restart()` wiring,
 *     including the "reload scheduled during a busy turn fires on the next
 *     idle, before drain" invariant.
 *   - Session preservation via `--resume` after a post-turn restart.
 *   - Crash/halt clearing the pending-restart flag via the Router.
 */

import { describe, it, expect } from "vitest";
import { ConversationManager } from "./conversation-manager.js";
import { conversationKey } from "../shared/types/index.js";
import { createCapturingLogger } from "../../tests/helpers/logger.js";

function makeManager(): ConversationManager {
  // None of these dependencies are exercised by the pending-restart code path.
  // The constructor just stashes them on private fields.
  return new ConversationManager(
    "/tmp/unused-state",
    "/tmp/unused-mcp-server.js",
    () => "http://127.0.0.1:0",
    createCapturingLogger(),
  );
}

describe("ConversationManager.scheduleRestartAfterTurn", () => {
  it("returns false when no conversation exists for the given triple", () => {
    const mgr = makeManager();
    expect(mgr.scheduleRestartAfterTurn("kai", "telegram", "123")).toBe(false);
  });

  it("does not set a pending flag when scheduling fails", () => {
    const mgr = makeManager();
    mgr.scheduleRestartAfterTurn("kai", "telegram", "123");
    // Even though we called schedule, the conversation doesn't exist so the
    // Set was never touched — hasPendingRestart stays false. This is the
    // invariant that prevents zombie flags on reset conversations from
    // firing a restart on some unrelated future conversation.
    const key = conversationKey("kai", "telegram", "123");
    expect(mgr.hasPendingRestart(key)).toBe(false);
  });

  it("returns false independently for distinct (agent, channel, chat) triples", () => {
    const mgr = makeManager();
    expect(mgr.scheduleRestartAfterTurn("kai", "telegram", "1")).toBe(false);
    expect(mgr.scheduleRestartAfterTurn("kai", "slack", "1")).toBe(false);
    expect(mgr.scheduleRestartAfterTurn("alice", "telegram", "1")).toBe(false);
  });
});

describe("ConversationManager.hasPendingRestart", () => {
  it("is false for a key that was never scheduled", () => {
    const mgr = makeManager();
    const key = conversationKey("kai", "telegram", "123");
    expect(mgr.hasPendingRestart(key)).toBe(false);
  });

  it("distinguishes keys by the full (agent, channel, chat) composite", () => {
    const mgr = makeManager();
    const a = conversationKey("kai", "telegram", "1");
    const b = conversationKey("kai", "slack", "1");
    const c = conversationKey("alice", "telegram", "1");
    expect(mgr.hasPendingRestart(a)).toBe(false);
    expect(mgr.hasPendingRestart(b)).toBe(false);
    expect(mgr.hasPendingRestart(c)).toBe(false);
  });
});

describe("ConversationManager.clearPendingRestart", () => {
  it("is idempotent on a key that was never scheduled", () => {
    const mgr = makeManager();
    const key = conversationKey("kai", "telegram", "123");
    expect(() => mgr.clearPendingRestart(key)).not.toThrow();
    expect(() => mgr.clearPendingRestart(key)).not.toThrow();
    expect(mgr.hasPendingRestart(key)).toBe(false);
  });

  it("does not affect other keys", () => {
    const mgr = makeManager();
    const a = conversationKey("kai", "telegram", "1");
    const b = conversationKey("kai", "telegram", "2");
    mgr.clearPendingRestart(a);
    expect(mgr.hasPendingRestart(a)).toBe(false);
    expect(mgr.hasPendingRestart(b)).toBe(false);
  });
});
