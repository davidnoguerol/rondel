/**
 * Zod validation tests for the heartbeat schemas that guard the
 * /heartbeats endpoints and the `rondel_heartbeat_*` MCP tools.
 *
 * The HeartbeatService integration tests work against already-validated
 * TypeScript types — they don't prove that malformed bodies get rejected
 * at the bridge boundary. These tests do.
 *
 * Split from schemas.unit.test.ts to keep each file focused on one feature.
 * Pattern source: approval-schemas.unit.test.ts + schedule-schemas.unit.test.ts.
 */

import { describe, it, expect } from "vitest";
import {
  HeartbeatRecordSchema,
  HeartbeatRecordWithHealthSchema,
  HeartbeatHealthStatusSchema,
  HeartbeatUpdateInputSchema,
  HeartbeatReadAllResponseSchema,
  validateBody,
} from "./schemas.js";

// ---------------------------------------------------------------------------
// HeartbeatHealthStatusSchema
// ---------------------------------------------------------------------------

describe("HeartbeatHealthStatusSchema", () => {
  it.each(["healthy", "stale", "down"] as const)("accepts %s", (value) => {
    expect(HeartbeatHealthStatusSchema.safeParse(value).success).toBe(true);
  });

  it("rejects unknown statuses", () => {
    expect(HeartbeatHealthStatusSchema.safeParse("missing").success).toBe(false);
    expect(HeartbeatHealthStatusSchema.safeParse("").success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// HeartbeatRecordSchema — the canonical on-disk shape
// ---------------------------------------------------------------------------

describe("HeartbeatRecordSchema", () => {
  const valid = {
    agent: "kai",
    org: "global",
    status: "in flow",
    updatedAt: "2026-04-15T12:00:00Z",
    intervalMs: 4 * 60 * 60 * 1000,
  };

  it("accepts a minimal valid record", () => {
    expect(HeartbeatRecordSchema.safeParse(valid).success).toBe(true);
  });

  it("accepts optional currentTask and notes", () => {
    expect(
      HeartbeatRecordSchema.safeParse({
        ...valid,
        currentTask: "ingestion",
        notes: "see pr 42",
      }).success,
    ).toBe(true);
  });

  it("rejects invalid agent name (starts with hyphen)", () => {
    expect(
      HeartbeatRecordSchema.safeParse({ ...valid, agent: "-bad" }).success,
    ).toBe(false);
  });

  it("rejects empty org (min 1)", () => {
    expect(HeartbeatRecordSchema.safeParse({ ...valid, org: "" }).success).toBe(false);
  });

  it("rejects non-ISO updatedAt", () => {
    expect(
      HeartbeatRecordSchema.safeParse({ ...valid, updatedAt: "yesterday" }).success,
    ).toBe(false);
  });

  it("rejects non-positive intervalMs", () => {
    expect(
      HeartbeatRecordSchema.safeParse({ ...valid, intervalMs: 0 }).success,
    ).toBe(false);
    expect(
      HeartbeatRecordSchema.safeParse({ ...valid, intervalMs: -1 }).success,
    ).toBe(false);
  });

  it("rejects fractional intervalMs (must be int)", () => {
    expect(
      HeartbeatRecordSchema.safeParse({ ...valid, intervalMs: 1.5 }).success,
    ).toBe(false);
  });

  it("rejects status exceeding 500 chars", () => {
    expect(
      HeartbeatRecordSchema.safeParse({ ...valid, status: "x".repeat(501) }).success,
    ).toBe(false);
  });

  it("accepts status at exactly 500 chars (boundary)", () => {
    expect(
      HeartbeatRecordSchema.safeParse({ ...valid, status: "x".repeat(500) }).success,
    ).toBe(true);
  });

  it("rejects notes exceeding 2000 chars", () => {
    expect(
      HeartbeatRecordSchema.safeParse({ ...valid, notes: "x".repeat(2001) }).success,
    ).toBe(false);
  });

  it("accepts notes at exactly 2000 chars (boundary)", () => {
    expect(
      HeartbeatRecordSchema.safeParse({ ...valid, notes: "x".repeat(2000) }).success,
    ).toBe(true);
  });

  it("round-trips a full record through parse", () => {
    const full = {
      ...valid,
      currentTask: "drafting spec",
      notes: "blocked on review",
    };
    const parsed = HeartbeatRecordSchema.parse(full);
    expect(parsed).toEqual(full);
  });
});

// ---------------------------------------------------------------------------
// HeartbeatRecordWithHealthSchema — read-side wire shape
// ---------------------------------------------------------------------------

describe("HeartbeatRecordWithHealthSchema", () => {
  const base = {
    agent: "kai",
    org: "global",
    status: "alive",
    updatedAt: "2026-04-15T12:00:00Z",
    intervalMs: 4 * 60 * 60 * 1000,
    health: "healthy" as const,
    ageMs: 1000,
  };

  it("accepts a valid record with computed fields", () => {
    expect(HeartbeatRecordWithHealthSchema.safeParse(base).success).toBe(true);
  });

  it("accepts ageMs of 0 (just written)", () => {
    expect(
      HeartbeatRecordWithHealthSchema.safeParse({ ...base, ageMs: 0 }).success,
    ).toBe(true);
  });

  it("rejects negative ageMs", () => {
    expect(
      HeartbeatRecordWithHealthSchema.safeParse({ ...base, ageMs: -1 }).success,
    ).toBe(false);
  });

  it("rejects missing health", () => {
    const { health: _, ...rest } = base;
    expect(HeartbeatRecordWithHealthSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects invalid health value", () => {
    expect(
      HeartbeatRecordWithHealthSchema.safeParse({ ...base, health: "missing" }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// HeartbeatUpdateInputSchema — POST /heartbeats/update body
// ---------------------------------------------------------------------------

describe("HeartbeatUpdateInputSchema", () => {
  const valid = {
    callerAgent: "kai",
    status: "in flow",
  };

  it("accepts a minimal valid body", () => {
    expect(HeartbeatUpdateInputSchema.safeParse(valid).success).toBe(true);
  });

  it("accepts optional currentTask and notes", () => {
    expect(
      HeartbeatUpdateInputSchema.safeParse({
        ...valid,
        currentTask: "ingestion",
        notes: "see pr 42",
      }).success,
    ).toBe(true);
  });

  it("rejects missing callerAgent", () => {
    const { callerAgent: _, ...rest } = valid;
    expect(HeartbeatUpdateInputSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects invalid callerAgent (starts with hyphen)", () => {
    expect(
      HeartbeatUpdateInputSchema.safeParse({ ...valid, callerAgent: "-bad" }).success,
    ).toBe(false);
  });

  it("rejects empty status (min 1)", () => {
    expect(
      HeartbeatUpdateInputSchema.safeParse({ ...valid, status: "" }).success,
    ).toBe(false);
  });

  it("rejects status exceeding 500 chars", () => {
    expect(
      HeartbeatUpdateInputSchema.safeParse({ ...valid, status: "x".repeat(501) }).success,
    ).toBe(false);
  });

  it("rejects notes exceeding 2000 chars", () => {
    expect(
      HeartbeatUpdateInputSchema.safeParse({ ...valid, notes: "x".repeat(2001) }).success,
    ).toBe(false);
  });

  it("rejects extra unknown status values as non-string types", () => {
    expect(
      HeartbeatUpdateInputSchema.safeParse({ ...valid, status: 42 }).success,
    ).toBe(false);
  });

  it("produces path-prefixed error via validateBody", () => {
    const result = validateBody(HeartbeatUpdateInputSchema, { ...valid, callerAgent: "-bad" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/^callerAgent: /);
    }
  });

  it("does NOT accept intervalMs from the client (service sets it)", () => {
    // Regression guard: the record carries `intervalMs`, but the update
    // body must not — the service derives it from the agent's cron
    // config. Zod's default strip mode won't reject an unexpected field,
    // but we still confirm the parsed shape omits it.
    const parsed = HeartbeatUpdateInputSchema.parse({ ...valid, intervalMs: 999 });
    expect("intervalMs" in parsed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// HeartbeatReadAllResponseSchema — GET /heartbeats/:org response
// ---------------------------------------------------------------------------

describe("HeartbeatReadAllResponseSchema", () => {
  it("accepts an empty fleet response", () => {
    const result = HeartbeatReadAllResponseSchema.safeParse({
      records: [],
      missing: [],
      summary: { healthy: 0, stale: 0, down: 0, missing: 0 },
    });
    expect(result.success).toBe(true);
  });

  it("accepts a populated fleet response", () => {
    const result = HeartbeatReadAllResponseSchema.safeParse({
      records: [
        {
          agent: "kai",
          org: "global",
          status: "alive",
          updatedAt: "2026-04-15T12:00:00Z",
          intervalMs: 4 * 60 * 60 * 1000,
          health: "healthy",
          ageMs: 1000,
        },
      ],
      missing: ["ada"],
      summary: { healthy: 1, stale: 0, down: 0, missing: 1 },
    });
    expect(result.success).toBe(true);
  });

  it("rejects response missing summary field", () => {
    const result = HeartbeatReadAllResponseSchema.safeParse({
      records: [],
      missing: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects response with negative summary counts", () => {
    const result = HeartbeatReadAllResponseSchema.safeParse({
      records: [],
      missing: [],
      summary: { healthy: -1, stale: 0, down: 0, missing: 0 },
    });
    expect(result.success).toBe(false);
  });

  it("rejects response where missing contains an invalid agent name", () => {
    const result = HeartbeatReadAllResponseSchema.safeParse({
      records: [],
      missing: ["-bad"],
      summary: { healthy: 0, stale: 0, down: 0, missing: 1 },
    });
    expect(result.success).toBe(false);
  });
});
