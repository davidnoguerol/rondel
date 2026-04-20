/**
 * Tests the session-index persistence contract:
 *
 * 1. Concurrent `persistSessionIndex()` calls are serialized — the second
 *    call's disk write does not begin until the first has resolved.
 * 2. Internal fire-and-forget writes that fail surface via an error-level
 *    log record, not a silent `.catch(() => {})`.
 *
 * Both invariants are load-bearing: the ordering guarantee prevents a
 * lagging disk view of in-memory state, and the error-visibility invariant
 * is what lets an operator notice when disk is rejecting writes (e.g. full
 * filesystem) before the daemon crashes on shutdown.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ConversationManager } from "./conversation-manager.js";
import * as atomicFile from "../shared/atomic-file.js";
import { createCapturingLogger } from "../../../../tests/helpers/logger.js";
import { withTmpRondel } from "../../../../tests/helpers/tmp.js";

function makeManager(stateDir: string) {
  const logger = createCapturingLogger("persist-test");
  const cm = new ConversationManager(stateDir, "/fake/mcp.js", () => "http://localhost:0", logger);
  return { cm, logger };
}

describe("ConversationManager — persistSessionIndex serialization", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("serializes concurrent writes via AsyncLock — second write waits for first to resolve", async () => {
    const tmp = withTmpRondel();
    const { cm } = makeManager(tmp.stateDir);

    // Controllable atomic writes: each call returns a promise we resolve by hand.
    let resolve1!: () => void;
    let resolve2!: () => void;
    const spy = vi.spyOn(atomicFile, "atomicWriteFile")
      .mockImplementationOnce(() => new Promise<void>((r) => { resolve1 = () => r(); }))
      .mockImplementationOnce(() => new Promise<void>((r) => { resolve2 = () => r(); }));

    const p1 = cm.persistSessionIndex();
    const p2 = cm.persistSessionIndex();

    // Yield microtasks so any un-serialized call would have reached atomicWriteFile by now.
    await Promise.resolve();
    await Promise.resolve();

    expect(spy).toHaveBeenCalledTimes(1); // only the first has started

    resolve1();
    await p1;

    // One more microtask cycle to let the second call's chain pick up.
    await Promise.resolve();
    await Promise.resolve();

    expect(spy).toHaveBeenCalledTimes(2); // the second started only after the first resolved

    resolve2();
    await p2;
  });

  it("writes are applied in enqueue order — last enqueued wins on disk", async () => {
    const tmp = withTmpRondel();
    const { cm } = makeManager(tmp.stateDir);
    const indexPath = join(tmp.stateDir, "sessions.json");

    // Access the private field via a narrow cast — test-only mutation to
    // observe that the disk state matches the last-enqueued call.
    const index = (cm as unknown as { sessionIndex: Record<string, { sessionId: string }> }).sessionIndex;

    index["a:telegram:1"] = { sessionId: "first" };
    const p1 = cm.persistSessionIndex();

    index["a:telegram:1"] = { sessionId: "second" };
    const p2 = cm.persistSessionIndex();

    await Promise.all([p1, p2]);

    const contents = JSON.parse(await readFile(indexPath, "utf-8"));
    expect(contents["a:telegram:1"].sessionId).toBe("second");
  });
});

describe("ConversationManager — persist error visibility", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs an error when a fire-and-forget persist fails (no silent swallow)", async () => {
    const tmp = withTmpRondel();
    const { cm, logger } = makeManager(tmp.stateDir);

    vi.spyOn(atomicFile, "atomicWriteFile").mockRejectedValue(new Error("simulated disk failure"));

    // resetSession() calls persistInBackground() internally, even when no
    // matching conversation exists — giving us a deterministic public entry
    // point to trigger the fire-and-forget write without needing a real process.
    cm.resetSession("ghost", "telegram", "abc");

    // Give the .catch handler a chance to fire.
    await new Promise<void>((r) => setTimeout(r, 10));

    const errors = logger.records.filter((r) => r.level === "error");
    expect(errors.length).toBeGreaterThan(0);
    // Not asserting on message text — only on the contract that *something*
    // surfaces at error level. This is the error-channel contract exception
    // to the general "don't assert on log text" rule.
    expect(errors.some((r) => /session index/i.test(r.msg))).toBe(true);
  });
});
