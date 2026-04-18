/**
 * Unit tests for the pure `summarizeSchedule` helper.
 *
 * The summarizer is the single source of truth for the on-wire
 * `ScheduleSummary` shape. Both the HTTP read endpoints and the SSE
 * `ScheduleStreamSource` call through it, so any drift in its output
 * shows up everywhere at once. Even a trivial projection is worth a
 * direct test — this one pins the contract that:
 *
 *   - Every field on the returned summary maps from either the job or
 *     the snapshot, never from thin air.
 *   - `undefined` snapshot means "no timing info" — the `deleted` frame
 *     path relies on this (scheduler has already dropped the job).
 *   - Defaults match the documented ScheduleSummary contract:
 *       · `enabled: false` only when job.enabled is explicitly `false`
 *       · `sessionTarget: "isolated"` when omitted
 *       · `source: "runtime"` when omitted (declarative jobs set it explicitly)
 *
 * This used to be a private method on ScheduleService; extracting it
 * makes the stream source reuse it and makes these tests possible
 * without spinning up the whole service stack.
 */

import { describe, it, expect } from "vitest";

import { summarizeSchedule } from "./schedule-service.js";
import type { CronJob } from "../shared/types/index.js";

function baseJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: "sched_1700000000_deadbeef",
    name: "ping",
    schedule: { kind: "every", interval: "5m" },
    prompt: "say hi",
    source: "runtime",
    owner: "alice",
    createdAtMs: 1_700_000_000_000,
    ...overrides,
  };
}

describe("summarizeSchedule", () => {
  it("projects every required field from the job", () => {
    const job = baseJob({ model: "claude-opus-4-5", timeoutMs: 30_000 });
    const out = summarizeSchedule(job, undefined);

    expect(out.id).toBe(job.id);
    expect(out.name).toBe(job.name);
    expect(out.owner).toBe("alice");
    expect(out.schedule).toEqual(job.schedule);
    expect(out.prompt).toBe(job.prompt);
    expect(out.model).toBe("claude-opus-4-5");
    expect(out.timeoutMs).toBe(30_000);
    expect(out.createdAtMs).toBe(1_700_000_000_000);
  });

  it("defaults enabled to true when job.enabled is undefined", () => {
    const out = summarizeSchedule(baseJob({ enabled: undefined }), undefined);
    expect(out.enabled).toBe(true);
  });

  it("defaults enabled to true when job.enabled is true", () => {
    const out = summarizeSchedule(baseJob({ enabled: true }), undefined);
    expect(out.enabled).toBe(true);
  });

  it("surfaces enabled: false only when the job opts out explicitly", () => {
    const out = summarizeSchedule(baseJob({ enabled: false }), undefined);
    expect(out.enabled).toBe(false);
  });

  it('defaults sessionTarget to "isolated" when omitted', () => {
    const out = summarizeSchedule(baseJob({ sessionTarget: undefined }), undefined);
    expect(out.sessionTarget).toBe("isolated");
  });

  it("preserves an explicit session:<name> sessionTarget", () => {
    const out = summarizeSchedule(
      baseJob({ sessionTarget: "session:ops" }),
      undefined,
    );
    expect(out.sessionTarget).toBe("session:ops");
  });

  it('defaults source to "runtime" when job.source is undefined', () => {
    const out = summarizeSchedule(baseJob({ source: undefined }), undefined);
    expect(out.source).toBe("runtime");
  });

  it("preserves declarative source", () => {
    const out = summarizeSchedule(baseJob({ source: "declarative" }), undefined);
    expect(out.source).toBe("declarative");
  });

  it("omits timing fields when snapshot is undefined (deleted-frame path)", () => {
    // This is the exact shape the ScheduleStreamSource uses on the
    // schedule.deleted frame — the scheduler has already dropped the
    // job state, so we get `undefined` everywhere timing-related.
    const out = summarizeSchedule(baseJob(), undefined);
    expect(out.nextRunAtMs).toBeUndefined();
    expect(out.lastRunAtMs).toBeUndefined();
    expect(out.lastStatus).toBeUndefined();
    expect(out.consecutiveErrors).toBeUndefined();
  });

  it("pulls all timing fields from the snapshot when present", () => {
    const out = summarizeSchedule(baseJob(), {
      nextRunAtMs: 1_700_000_300_000,
      lastRunAtMs: 1_699_999_700_000,
      lastStatus: "ok",
      consecutiveErrors: 0,
    });
    expect(out.nextRunAtMs).toBe(1_700_000_300_000);
    expect(out.lastRunAtMs).toBe(1_699_999_700_000);
    expect(out.lastStatus).toBe("ok");
    expect(out.consecutiveErrors).toBe(0);
  });

  it("surfaces consecutiveErrors even when it's the only populated snapshot field", () => {
    // A job that has failed twice but never completed — lastRunAtMs
    // is the failure time, lastStatus is "error", nextRunAtMs is the
    // backoff-delayed next attempt. Typical error-path shape.
    const out = summarizeSchedule(baseJob(), {
      nextRunAtMs: 1_700_000_600_000,
      lastRunAtMs: 1_700_000_000_000,
      lastStatus: "error",
      consecutiveErrors: 2,
    });
    expect(out.consecutiveErrors).toBe(2);
    expect(out.lastStatus).toBe("error");
  });

  it("preserves the delivery field verbatim (announce with channel)", () => {
    const out = summarizeSchedule(
      baseJob({
        delivery: {
          mode: "announce",
          chatId: "12345",
          channelType: "telegram",
          accountId: "primary",
        },
      }),
      undefined,
    );
    expect(out.delivery).toEqual({
      mode: "announce",
      chatId: "12345",
      channelType: "telegram",
      accountId: "primary",
    });
  });

  it("preserves an explicit none delivery", () => {
    const out = summarizeSchedule(
      baseJob({ delivery: { mode: "none" } }),
      undefined,
    );
    expect(out.delivery).toEqual({ mode: "none" });
  });

  it("leaves delivery undefined when the job has none (declarative default)", () => {
    const out = summarizeSchedule(baseJob({ delivery: undefined }), undefined);
    expect(out.delivery).toBeUndefined();
  });

  it("preserves deleteAfterRun when explicitly set on the job", () => {
    const out = summarizeSchedule(baseJob({ deleteAfterRun: true }), undefined);
    expect(out.deleteAfterRun).toBe(true);
  });

  it("handles all three schedule kinds unchanged", () => {
    const every = summarizeSchedule(
      baseJob({ schedule: { kind: "every", interval: "1h" } }),
      undefined,
    );
    const at = summarizeSchedule(
      baseJob({ schedule: { kind: "at", at: "2026-05-01T09:00:00Z" } }),
      undefined,
    );
    const cron = summarizeSchedule(
      baseJob({
        schedule: { kind: "cron", expression: "0 8 * * *", timezone: "UTC" },
      }),
      undefined,
    );

    expect(every.schedule).toEqual({ kind: "every", interval: "1h" });
    expect(at.schedule).toEqual({ kind: "at", at: "2026-05-01T09:00:00Z" });
    expect(cron.schedule).toEqual({
      kind: "cron",
      expression: "0 8 * * *",
      timezone: "UTC",
    });
  });
});
