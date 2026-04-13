/**
 * Integration tests for loadTranscriptTurns.
 *
 * The ENOENT distinction is load-bearing: a missing transcript is a healthy
 * "fresh conversation with no history" state and must return []. Any other
 * read error (permissions, I/O, disk gone) must rethrow so the bridge can
 * surface a real 500 instead of lying with an empty history view.
 */

import { describe, it, expect } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { loadTranscriptTurns } from "./transcript.js";
import { withTmpRondel } from "../../tests/helpers/tmp.js";

describe("loadTranscriptTurns", () => {
  it("returns [] when the transcript file does not exist (ENOENT)", async () => {
    const tmp = withTmpRondel();
    const missing = join(tmp.stateDir, "nope", "missing.jsonl");
    const turns = await loadTranscriptTurns(missing);
    expect(turns).toEqual([]);
  });

  it("rethrows non-ENOENT read errors so callers can surface a real failure", async () => {
    const tmp = withTmpRondel();
    // Pointing at a directory, not a file — readFile raises EISDIR on Linux
    // and macOS, which is a non-ENOENT errno that must propagate. This is
    // the simplest way to trigger a rethrow without fs-level mocking.
    await expect(loadTranscriptTurns(tmp.stateDir)).rejects.toThrow();
  });

  it("parses user and assistant turns from a real JSONL file", async () => {
    const tmp = withTmpRondel();
    const path = join(tmp.stateDir, "transcript.jsonl");
    const lines = [
      JSON.stringify({ type: "session_header", sessionId: "s1" }),
      JSON.stringify({ type: "user", text: "hello", timestamp: "2026-01-01T00:00:00Z" }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "hi there" }] },
        timestamp: "2026-01-01T00:00:01Z",
      }),
      // Malformed line should be skipped without throwing
      "not-json",
      // Assistant with no text blocks should be skipped (no empty turn emitted)
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use" }] } }),
      "",
    ];
    await writeFile(path, lines.join("\n"), "utf-8");

    const turns = await loadTranscriptTurns(path);
    expect(turns).toEqual([
      { role: "user", text: "hello", ts: "2026-01-01T00:00:00Z" },
      { role: "assistant", text: "hi there", ts: "2026-01-01T00:00:01Z" },
    ]);
  });
});
