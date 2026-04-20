/**
 * Unit tests for pure heartbeat helpers — no disk, no hooks, no service.
 *
 * The classifier is the single source of truth for "is this record
 * stale?" — if these tests drift from bridge/schemas.ts and
 * streams/heartbeat-stream.ts, the wire format and the display layer
 * diverge silently.
 */

import { describe, it, expect } from "vitest";
import {
  classifyHealth,
  classifyHealthFromAge,
  findStale,
  withHealth,
  HEALTHY_THRESHOLD_MS,
  DOWN_THRESHOLD_MS,
} from "./heartbeat-service.js";
import type { HeartbeatRecord } from "../shared/types/heartbeats.js";

function record(updatedAt: string): HeartbeatRecord {
  return {
    agent: "kai",
    org: "global",
    status: "alive",
    updatedAt,
    intervalMs: 4 * 60 * 60 * 1000,
  };
}

describe("classifyHealthFromAge", () => {
  it("treats 0 age as healthy", () => {
    expect(classifyHealthFromAge(0)).toBe("healthy");
  });

  it("treats negative age (clock skew) as healthy", () => {
    expect(classifyHealthFromAge(-1_000_000)).toBe("healthy");
  });

  it("returns healthy exactly on the 5h boundary", () => {
    expect(classifyHealthFromAge(HEALTHY_THRESHOLD_MS)).toBe("healthy");
  });

  it("returns stale just past the 5h boundary", () => {
    expect(classifyHealthFromAge(HEALTHY_THRESHOLD_MS + 1)).toBe("stale");
  });

  it("returns stale exactly on the 24h boundary", () => {
    expect(classifyHealthFromAge(DOWN_THRESHOLD_MS)).toBe("stale");
  });

  it("returns down just past the 24h boundary", () => {
    expect(classifyHealthFromAge(DOWN_THRESHOLD_MS + 1)).toBe("down");
  });

  it("returns down for very old records", () => {
    expect(classifyHealthFromAge(7 * 24 * 60 * 60 * 1000)).toBe("down");
  });
});

describe("classifyHealth", () => {
  const now = Date.UTC(2026, 3, 20, 12, 0, 0); // 2026-04-20T12:00:00Z

  it("classifies a fresh record as healthy", () => {
    const r = record(new Date(now - 60 * 1000).toISOString());
    expect(classifyHealth(r, now)).toBe("healthy");
  });

  it("classifies a 6h-old record as stale", () => {
    const r = record(new Date(now - 6 * 60 * 60 * 1000).toISOString());
    expect(classifyHealth(r, now)).toBe("stale");
  });

  it("classifies a 25h-old record as down", () => {
    const r = record(new Date(now - 25 * 60 * 60 * 1000).toISOString());
    expect(classifyHealth(r, now)).toBe("down");
  });

  it("treats an unparseable timestamp as very stale (down)", () => {
    const r = record("not-a-date");
    expect(classifyHealth(r, now)).toBe("down");
  });
});

describe("withHealth", () => {
  const now = Date.UTC(2026, 3, 20, 12, 0, 0);

  it("attaches ageMs and health to the record", () => {
    const r = record(new Date(now - 2 * 60 * 60 * 1000).toISOString());
    const enriched = withHealth(r, now);
    expect(enriched.health).toBe("healthy");
    expect(enriched.ageMs).toBe(2 * 60 * 60 * 1000);
  });

  it("clamps negative ageMs to 0 (clock skew → healthy)", () => {
    const r = record(new Date(now + 30_000).toISOString());
    const enriched = withHealth(r, now);
    expect(enriched.health).toBe("healthy");
    expect(enriched.ageMs).toBe(0);
  });
});

describe("findStale", () => {
  const now = Date.UTC(2026, 3, 20, 12, 0, 0);

  it("returns stale + down records, excludes healthy", () => {
    const healthy = { ...record(new Date(now - 60_000).toISOString()), agent: "a" };
    const stale = { ...record(new Date(now - 6 * 60 * 60 * 1000).toISOString()), agent: "b" };
    const down = { ...record(new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString()), agent: "c" };

    const result = findStale([healthy, stale, down], now);
    expect(result.map((r) => r.agent).sort()).toEqual(["b", "c"]);
  });

  it("returns an empty list when everything is healthy", () => {
    const a = { ...record(new Date(now - 60_000).toISOString()), agent: "a" };
    const b = { ...record(new Date(now - 10 * 60 * 1000).toISOString()), agent: "b" };
    expect(findStale([a, b], now)).toEqual([]);
  });

  it("handles the empty input", () => {
    expect(findStale([], now)).toEqual([]);
  });
});
