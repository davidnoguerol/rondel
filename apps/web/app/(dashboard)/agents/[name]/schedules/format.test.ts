/**
 * Unit tests for the pure formatters powering the schedules UI.
 *
 * These are plain string builders — the risk isn't correctness so much as
 * silent regression. If the UI starts rendering `"cron 0 8 * * * ()"` with
 * an empty timezone, we'd rather catch it here than in a screenshot.
 *
 * Pure functions, no DOM, no imports from React — runs in node env.
 */

import { describe, it, expect } from "vitest";

import type { ScheduleKind, ScheduleStatus } from "@/lib/bridge";

import {
  formatDelivery,
  formatRelativeTime,
  formatScheduleKind,
  formatStatusBadge,
} from "./format";

// -----------------------------------------------------------------------------
// formatScheduleKind
// -----------------------------------------------------------------------------

describe("formatScheduleKind", () => {
  it("renders 'every' intervals verbatim", () => {
    const kind: ScheduleKind = { kind: "every", interval: "5m" };
    expect(formatScheduleKind(kind)).toBe("every 5m");
  });

  it("renders compound intervals without reformatting", () => {
    const kind: ScheduleKind = { kind: "every", interval: "2h30m" };
    expect(formatScheduleKind(kind)).toBe("every 2h30m");
  });

  it("renders an ISO 'at' value as compact UTC", () => {
    // 2026-05-01T09:00:00Z → "at 2026-05-01 09:00Z"
    const kind: ScheduleKind = { kind: "at", at: "2026-05-01T09:00:00.000Z" };
    expect(formatScheduleKind(kind)).toBe("at 2026-05-01 09:00Z");
  });

  it("passes unparseable 'at' values through unchanged", () => {
    // Relative offsets like "20m" should be accepted even though they're
    // already resolved to ISO on the daemon side — defensive pass-through.
    const kind: ScheduleKind = { kind: "at", at: "20m" };
    expect(formatScheduleKind(kind)).toBe("at 20m");
  });

  it("renders cron without a timezone as bare expression", () => {
    const kind: ScheduleKind = { kind: "cron", expression: "0 8 * * *" };
    expect(formatScheduleKind(kind)).toBe("cron 0 8 * * *");
  });

  it("renders cron with a timezone in parentheses", () => {
    const kind: ScheduleKind = {
      kind: "cron",
      expression: "0 8 * * *",
      timezone: "America/Sao_Paulo",
    };
    expect(formatScheduleKind(kind)).toBe("cron 0 8 * * * (America/Sao_Paulo)");
  });
});

// -----------------------------------------------------------------------------
// formatRelativeTime
// -----------------------------------------------------------------------------

describe("formatRelativeTime", () => {
  const NOW = 1_700_000_000_000;

  it("returns em-dash for undefined", () => {
    expect(formatRelativeTime(undefined, NOW)).toBe("—");
  });

  it("formats a future time with 'in' prefix", () => {
    // 5 minutes from now → "in 5m"
    expect(formatRelativeTime(NOW + 5 * 60_000, NOW)).toBe("in 5m");
  });

  it("formats a past time with ' ago' suffix", () => {
    // 2 hours ago → "2h ago"
    expect(formatRelativeTime(NOW - 2 * 60 * 60_000, NOW)).toBe("2h ago");
  });

  it("uses seconds under a minute", () => {
    expect(formatRelativeTime(NOW + 30_000, NOW)).toBe("in 30s");
  });

  it("uses days past 48 hours", () => {
    expect(formatRelativeTime(NOW - 3 * 24 * 60 * 60_000, NOW)).toBe("3d ago");
  });

  it("treats exact-now as non-negative (uses 'in' prefix)", () => {
    // diff === 0 goes into the 'in ' branch per the implementation
    expect(formatRelativeTime(NOW, NOW)).toBe("in 0s");
  });
});

// -----------------------------------------------------------------------------
// formatStatusBadge
// -----------------------------------------------------------------------------

describe("formatStatusBadge", () => {
  it("maps ok to success styling", () => {
    const badge = formatStatusBadge("ok");
    expect(badge.label).toBe("OK");
    expect(badge.className).toContain("success");
  });

  it("maps error to destructive styling", () => {
    const badge = formatStatusBadge("error");
    expect(badge.label).toBe("ERROR");
    expect(badge.className).toContain("destructive");
  });

  it("maps skipped to muted styling", () => {
    const badge = formatStatusBadge("skipped");
    expect(badge.label).toBe("SKIPPED");
    expect(badge.className).toContain("muted");
  });

  it("falls back to em-dash + muted for undefined", () => {
    const badge = formatStatusBadge(undefined);
    expect(badge.label).toBe("—");
    expect(badge.className).toContain("muted");
  });

  // Defensive: if a future ScheduleStatus literal is added on the daemon
  // without a formatter update, the TS cast here would normally catch it,
  // but the SSE frame could still deliver an unknown string at runtime.
  // We verify the default branch handles the null-ish case — anything
  // unexpected would land in the default too.
  it("treats an unknown status string as the default branch", () => {
    const badge = formatStatusBadge("weird" as unknown as ScheduleStatus);
    expect(badge.label).toBe("—");
  });
});

// -----------------------------------------------------------------------------
// formatDelivery
// -----------------------------------------------------------------------------

describe("formatDelivery", () => {
  it("returns 'no delivery' for undefined", () => {
    expect(formatDelivery(undefined)).toBe("no delivery");
  });

  it("returns 'no delivery' for none mode", () => {
    expect(formatDelivery({ mode: "none" })).toBe("no delivery");
  });

  it("renders announce with channel prefix when channelType is set", () => {
    expect(
      formatDelivery({
        mode: "announce",
        chatId: "12345",
        channelType: "telegram",
      }),
    ).toBe("→ telegram:12345");
  });

  it("omits channel prefix when channelType is missing", () => {
    expect(formatDelivery({ mode: "announce", chatId: "12345" })).toBe("→ 12345");
  });

  it("ignores accountId in the short summary", () => {
    // accountId isn't surfaced in the one-line summary — the card shows
    // it elsewhere. This test pins that decision so an accidental
    // template change that includes it would fail here.
    expect(
      formatDelivery({
        mode: "announce",
        chatId: "12345",
        channelType: "telegram",
        accountId: "primary",
      }),
    ).toBe("→ telegram:12345");
  });
});
