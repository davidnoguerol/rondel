/**
 * Ledger writer — runtime schedule lifecycle events.
 *
 * Covers the `schedule:created | schedule:updated | schedule:deleted` hook
 * handlers added alongside the runtime-scheduling surface. Each handler
 * should produce one append, carry the owner as the ledger agent, and
 * never attach channelType/chatId (scheduling is system-wide, same
 * invariant as cron_completed — see the existing test in
 * ledger-writer.integration.test.ts).
 *
 * Sibling file to ledger-writer.integration.test.ts — split to keep each
 * file scoped to one feature area and readable at a glance.
 */

import { describe, it, expect } from "vitest";

import { withTmpRondel } from "../../../../tests/helpers/tmp.js";
import { createHooks } from "../shared/hooks.js";
import type { CronJob } from "../shared/types/index.js";
import { LedgerWriter } from "./ledger-writer.js";
import type { LedgerEvent } from "./ledger-types.js";

function capture(writer: LedgerWriter): LedgerEvent[] {
  const captured: LedgerEvent[] = [];
  writer.onAppended((e) => captured.push(e));
  return captured;
}

function runtimeJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: "sched_1700000000_aa11bb22",
    name: "Morning digest",
    schedule: { kind: "every", interval: "1h" },
    prompt: "summarise",
    sessionTarget: "isolated",
    source: "runtime",
    owner: "alice",
    createdAtMs: 1_700_000_000_000,
    enabled: true,
    ...overrides,
  };
}

describe("LedgerWriter — schedule lifecycle hooks", () => {
  it("appends a schedule_created entry keyed on the owner agent", () => {
    const tmp = withTmpRondel();
    const hooks = createHooks();
    const writer = new LedgerWriter(tmp.stateDir, hooks);
    const entries = capture(writer);

    const job = runtimeJob();
    hooks.emit("schedule:created", { job });

    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("schedule_created");
    expect(entries[0].agent).toBe("alice");
    // System-wide event — the invariant from ledger-types.ts is that
    // channelType and chatId are always paired or both absent. Here both
    // are absent (scheduling is not conversation-bound).
    expect(entries[0].channelType).toBeUndefined();
    expect(entries[0].chatId).toBeUndefined();
    expect(entries[0].summary).toContain("Morning digest");
    expect(entries[0].summary).toContain("every 1h");
  });

  it("appends a schedule_updated entry", () => {
    const tmp = withTmpRondel();
    const hooks = createHooks();
    const writer = new LedgerWriter(tmp.stateDir, hooks);
    const entries = capture(writer);

    hooks.emit("schedule:updated", {
      job: runtimeJob({
        schedule: { kind: "cron", expression: "0 8 * * *" },
      }),
    });

    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("schedule_updated");
    expect(entries[0].summary).toMatch(/cron "0 8 \* \* \*"/);
  });

  it("appends a schedule_deleted entry with the reason in detail", () => {
    const tmp = withTmpRondel();
    const hooks = createHooks();
    const writer = new LedgerWriter(tmp.stateDir, hooks);
    const entries = capture(writer);

    hooks.emit("schedule:deleted", {
      job: runtimeJob(),
      reason: "ran_once",
    });

    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("schedule_deleted");
    expect(entries[0].summary).toMatch(/removed \(ran_once\)/);
    expect(entries[0].detail).toMatchObject({
      scheduleId: "sched_1700000000_aa11bb22",
      reason: "ran_once",
    });
  });

  it("drops events without an owner — the agent column would be missing", () => {
    // An invariant of the ledger is that every event has an `agent`. The
    // schedule handlers short-circuit when job.owner is absent; guarding
    // this at the hook boundary means nothing downstream has to defend
    // against empty strings in the ledger.
    const tmp = withTmpRondel();
    const hooks = createHooks();
    const writer = new LedgerWriter(tmp.stateDir, hooks);
    const entries = capture(writer);

    const { owner: _omitted, ...rest } = runtimeJob();
    void _omitted;
    hooks.emit("schedule:created", { job: rest as CronJob });

    expect(entries).toHaveLength(0);
  });

  it("describes all three schedule kinds in the summary", () => {
    // The describer is trivial — a switch — but the failure mode if it
    // returned the wrong flavour is exactly the kind of silent rot that
    // unit tests exist for.
    const tmp = withTmpRondel();
    const hooks = createHooks();
    const writer = new LedgerWriter(tmp.stateDir, hooks);
    const entries = capture(writer);

    hooks.emit("schedule:created", {
      job: runtimeJob({ schedule: { kind: "every", interval: "30s" } }),
    });
    hooks.emit("schedule:created", {
      job: runtimeJob({
        id: "sched_1700000000_cc33dd44",
        schedule: { kind: "at", at: "2026-04-19T08:00:00Z" },
      }),
    });
    hooks.emit("schedule:created", {
      job: runtimeJob({
        id: "sched_1700000000_ee55ff66",
        schedule: { kind: "cron", expression: "*/5 * * * *" },
      }),
    });

    expect(entries.map((e) => e.summary)).toEqual([
      expect.stringContaining("every 30s"),
      expect.stringContaining("at 2026-04-19T08:00:00Z"),
      expect.stringContaining('cron "*/5 * * * *"'),
    ]);
  });
});
