/**
 * Ledger writer — heartbeat lifecycle events.
 *
 * Covers the `heartbeat:updated` hook handler added alongside the
 * per-agent heartbeat surface. The handler should:
 *   - produce one append per hook event
 *   - key the ledger row on the beating agent (`record.agent`)
 *   - carry a short `beat: <status>` summary (truncated to GENERAL_MAX = 80)
 *   - preserve org/currentTask/notes/intervalMs in the detail payload
 *   - NOT attach channelType/chatId (heartbeats are system-wide, same
 *     invariant as cron_completed / schedule_created)
 *
 * Sibling file to ledger-writer-schedules.integration.test.ts —
 * split to keep each feature readable at a glance.
 */

import { describe, it, expect } from "vitest";

import { withTmpRondel } from "../../../../tests/helpers/tmp.js";
import { createHooks } from "../shared/hooks.js";
import type { HeartbeatRecord } from "../shared/types/heartbeats.js";
import { LedgerWriter } from "./ledger-writer.js";
import type { LedgerEvent } from "./ledger-types.js";

function capture(writer: LedgerWriter): LedgerEvent[] {
  const captured: LedgerEvent[] = [];
  writer.onAppended((e) => captured.push(e));
  return captured;
}

function heartbeat(overrides: Partial<HeartbeatRecord> = {}): HeartbeatRecord {
  return {
    agent: "kai",
    org: "global",
    status: "in flow",
    currentTask: "drafting spec",
    notes: undefined,
    updatedAt: "2026-04-15T12:00:00Z",
    intervalMs: 4 * 60 * 60 * 1000,
    ...overrides,
  };
}

describe("LedgerWriter — heartbeat:updated hook", () => {
  it("appends a heartbeat_updated entry keyed on the beating agent", () => {
    const tmp = withTmpRondel();
    const hooks = createHooks();
    const writer = new LedgerWriter(tmp.stateDir, hooks);
    const entries = capture(writer);

    const record = heartbeat();
    hooks.emit("heartbeat:updated", { record });

    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("heartbeat_updated");
    expect(entries[0].agent).toBe("kai");
    // System-wide event — same invariant as cron_completed and
    // schedule_created: no channelType/chatId pair.
    expect(entries[0].channelType).toBeUndefined();
    expect(entries[0].chatId).toBeUndefined();
  });

  it("carries a `beat: <status>` summary", () => {
    const tmp = withTmpRondel();
    const hooks = createHooks();
    const writer = new LedgerWriter(tmp.stateDir, hooks);
    const entries = capture(writer);

    hooks.emit("heartbeat:updated", { record: heartbeat({ status: "in flow" }) });

    expect(entries[0].summary).toBe("beat: in flow");
  });

  it("truncates long statuses via the writer's GENERAL_MAX budget", () => {
    // Regression guard: the writer truncates summaries via its private
    // `truncate` helper (slice to GENERAL_MAX=80 then append "..."), so
    // the summary for a 500-char status (the schema cap) must not make
    // it onto the ledger row verbatim — the ledger is an index, not a
    // transcript. We assert the shape ("beat: xxx...") and that the
    // result is far shorter than the input.
    const tmp = withTmpRondel();
    const hooks = createHooks();
    const writer = new LedgerWriter(tmp.stateDir, hooks);
    const entries = capture(writer);

    const longStatus = "x".repeat(500);
    hooks.emit("heartbeat:updated", { record: heartbeat({ status: longStatus }) });

    expect(entries).toHaveLength(1);
    // The summary starts with "beat: " and ends with the truncation
    // marker. 80-char slice + "..." = 83 total chars.
    expect(entries[0].summary.startsWith("beat: ")).toBe(true);
    expect(entries[0].summary.endsWith("...")).toBe(true);
    expect(entries[0].summary.length).toBeLessThan(100);
    expect(entries[0].summary.length).toBeLessThan(longStatus.length);
  });

  it("preserves org / currentTask / notes / intervalMs in detail", () => {
    const tmp = withTmpRondel();
    const hooks = createHooks();
    const writer = new LedgerWriter(tmp.stateDir, hooks);
    const entries = capture(writer);

    const record = heartbeat({
      org: "acme",
      currentTask: "ingestion",
      notes: "see pr 42",
      intervalMs: 30 * 60 * 1000,
    });
    hooks.emit("heartbeat:updated", { record });

    expect(entries[0].detail).toEqual({
      org: "acme",
      currentTask: "ingestion",
      notes: "see pr 42",
      intervalMs: 30 * 60 * 1000,
    });
  });

  it("leaves currentTask/notes undefined in detail when absent on the record", () => {
    // Regression guard: the handler passes them straight through, so
    // records without these optional fields produce detail payloads
    // with explicit `undefined` values rather than missing keys or
    // coerced empty strings. Downstream queries (e.g. the ledger
    // reader filtering by detail) rely on this shape.
    const tmp = withTmpRondel();
    const hooks = createHooks();
    const writer = new LedgerWriter(tmp.stateDir, hooks);
    const entries = capture(writer);

    hooks.emit("heartbeat:updated", {
      record: heartbeat({ currentTask: undefined, notes: undefined }),
    });

    const detail = entries[0].detail as Record<string, unknown>;
    expect(detail.currentTask).toBeUndefined();
    expect(detail.notes).toBeUndefined();
  });

  it("emits one entry per hook call (no coalescing)", () => {
    // Heartbeats are low-frequency (4h default), but the writer is a
    // pure fan-out over emits. Two consecutive emits → two rows.
    const tmp = withTmpRondel();
    const hooks = createHooks();
    const writer = new LedgerWriter(tmp.stateDir, hooks);
    const entries = capture(writer);

    hooks.emit("heartbeat:updated", { record: heartbeat({ status: "first" }) });
    hooks.emit("heartbeat:updated", { record: heartbeat({ status: "second" }) });

    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.summary)).toEqual([
      "beat: first",
      "beat: second",
    ]);
  });
});
