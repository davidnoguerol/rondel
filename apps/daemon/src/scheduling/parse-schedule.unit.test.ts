import { describe, it, expect } from "vitest";
import { parseInterval, parseSchedule } from "./parse-schedule.js";

describe("parseInterval", () => {
  it.each([
    ["30s", 30_000],
    ["5m", 5 * 60_000],
    ["1h", 3_600_000],
    ["24h", 86_400_000],
    ["2h30m", 2 * 3_600_000 + 30 * 60_000],
    ["7d", 7 * 86_400_000],
  ] as const)("parses %s → %d ms", (input, expected) => {
    expect(parseInterval(input)).toBe(expected);
  });

  it("rejects zero duration", () => {
    expect(() => parseInterval("0s")).toThrow(/greater than zero/);
  });

  it("rejects malformed strings", () => {
    expect(() => parseInterval("")).toThrow();
    expect(() => parseInterval("5x")).toThrow();
    expect(() => parseInterval("5 m")).toThrow();
  });
});

describe("parseSchedule — every", () => {
  it("returns the interval added to fromMs on every call", () => {
    const parsed = parseSchedule({ kind: "every", interval: "1h" });
    const now = 1_000_000;
    expect(parsed.nextRunAtMs(now)).toBe(now + 3_600_000);
    expect(parsed.isOneShot).toBe(false);
    expect(parsed.normalized).toEqual({ kind: "every", interval: "1h" });
  });

  it("throws on malformed interval", () => {
    expect(() => parseSchedule({ kind: "every", interval: "bogus" })).toThrow();
  });
});

describe("parseSchedule — at (one-shot)", () => {
  it("resolves an absolute ISO timestamp and returns it until it passes", () => {
    const future = new Date(Date.now() + 10_000).toISOString();
    const parsed = parseSchedule({ kind: "at", at: future });
    expect(parsed.isOneShot).toBe(true);
    expect(parsed.normalized).toEqual({ kind: "at", at: future });
    expect(parsed.nextRunAtMs(Date.now())).toBe(Date.parse(future));
  });

  it("resolves a relative offset to an absolute ISO string", () => {
    const now = 1_700_000_000_000;
    const parsed = parseSchedule({ kind: "at", at: "20m" }, now);
    expect(parsed.isOneShot).toBe(true);
    expect(parsed.normalized.kind).toBe("at");
    if (parsed.normalized.kind === "at") {
      const absMs = Date.parse(parsed.normalized.at);
      expect(absMs).toBe(now + 20 * 60_000);
    }
  });

  it("returns null after the fire time has passed", () => {
    const parsed = parseSchedule({ kind: "at", at: "2020-01-01T00:00:00Z" });
    expect(parsed.nextRunAtMs(Date.now())).toBeNull();
  });

  it("rejects unparseable timestamps", () => {
    expect(() => parseSchedule({ kind: "at", at: "not a date" })).toThrow(/Invalid "at" value/);
  });

  it('rejects relative offsets that overflow Date\'s ±2^53 range', () => {
    expect(() =>
      parseSchedule({ kind: "at", at: "9999999999999999m" }),
    ).toThrow(/out of range/);
  });
});

describe("parseSchedule — cron", () => {
  it("computes the next fire for a standard 5-field expression", () => {
    const parsed = parseSchedule({ kind: "cron", expression: "0 8 * * *" });
    const base = Date.parse("2026-04-19T07:30:00Z");
    const next = parsed.nextRunAtMs(base);
    expect(next).not.toBeNull();
    // Must be in the future of `base` and within 24h.
    expect(next! > base).toBe(true);
    expect(next! - base).toBeLessThanOrEqual(24 * 3_600_000);
  });

  it("honours an IANA timezone", () => {
    const base = Date.parse("2026-04-19T00:00:00Z");
    const utc = parseSchedule({ kind: "cron", expression: "0 12 * * *" });
    const tokyo = parseSchedule({ kind: "cron", expression: "0 12 * * *", timezone: "Asia/Tokyo" });
    // UTC fires at 12:00 UTC; Tokyo fires at 12:00 JST = 03:00 UTC, which on
    // the same UTC day is EARLIER than UTC 12:00.
    expect(tokyo.nextRunAtMs(base)).toBeLessThan(utc.nextRunAtMs(base)!);
  });

  it("rejects an invalid expression", () => {
    expect(() => parseSchedule({ kind: "cron", expression: "not a cron" })).toThrow();
  });

  it("marks recurring (not one-shot)", () => {
    const parsed = parseSchedule({ kind: "cron", expression: "*/5 * * * *" });
    expect(parsed.isOneShot).toBe(false);
  });
});
