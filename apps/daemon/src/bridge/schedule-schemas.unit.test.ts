/**
 * Zod validation tests for the runtime-schedule schemas that guard the
 * /schedules endpoints and the `rondel_schedule_*` MCP tools.
 *
 * The ScheduleService integration tests work against already-validated
 * TypeScript types — they don't prove that malformed bodies get rejected
 * at the bridge boundary. These tests do.
 *
 * Split from schemas.unit.test.ts to keep each file focused on one feature.
 */

import { describe, it, expect } from "vitest";
import {
  ScheduleKindSchema,
  ScheduleCreateSchema,
  ScheduleUpdateSchema,
  ScheduleCreateRequestSchema,
  ScheduleMutationRequestSchema,
  validateBody,
} from "./schemas.js";

// ---------------------------------------------------------------------------
// ScheduleKindSchema
// ---------------------------------------------------------------------------

describe("ScheduleKindSchema — every", () => {
  it.each([
    ["30s", true],
    ["5m", true],
    ["1h", true],
    ["24h", true],
    ["2h30m", true],
    ["7d", true],
    ["5x", false],
    ["5 m", false],
    ["5M", false],
    ["", false],
  ] as const)("every interval %j → ok=%s", (interval, ok) => {
    const result = ScheduleKindSchema.safeParse({ kind: "every", interval });
    expect(result.success).toBe(ok);
  });

  it("[drift] admits out-of-order units like '3m2h' that parseInterval would reject", () => {
    // Documents a known gap between the wire schema and the runtime parser:
    //   Zod regex:     /^\d+[dhms](?:\d+[dhms])*$/   — order-agnostic
    //   parseInterval: /^(?:\d+d)?(?:\d+h)?…/         — strict d→h→m→s order
    // Today the mismatch is benign — ScheduleService calls parseSchedule
    // right after Zod, so malformed ordering still throws before the job
    // is stored. But if the pre-validation path ever changes (e.g. the
    // MCP tool trusts the schema and skips parseSchedule), this test
    // will fail and flag the regression.
    expect(
      ScheduleKindSchema.safeParse({ kind: "every", interval: "3m2h" }).success,
    ).toBe(true);
  });
});

describe("ScheduleKindSchema — at", () => {
  it("accepts an absolute ISO 8601 timestamp", () => {
    const result = ScheduleKindSchema.safeParse({
      kind: "at",
      at: "2026-04-19T08:00:00Z",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a relative offset like 20m", () => {
    expect(
      ScheduleKindSchema.safeParse({ kind: "at", at: "20m" }).success,
    ).toBe(true);
  });

  it("rejects unparseable timestamps", () => {
    expect(
      ScheduleKindSchema.safeParse({ kind: "at", at: "tomorrow morning" })
        .success,
    ).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(ScheduleKindSchema.safeParse({ kind: "at", at: "" }).success).toBe(
      false,
    );
  });

  it("accepts a past ISO timestamp at the schema layer — catch-up is a scheduler concern", () => {
    // The schema validates shape, not semantics. Past timestamps are valid
    // input; the scheduler decides whether to fire (missed-job catch-up)
    // or treat as already-fired. Keeping this explicit so a future "helpful"
    // refinement doesn't silently break the catch-up contract.
    expect(
      ScheduleKindSchema.safeParse({
        kind: "at",
        at: "2020-01-01T00:00:00Z",
      }).success,
    ).toBe(true);
  });
});

describe("ScheduleKindSchema — cron", () => {
  it("accepts a standard 5-field expression", () => {
    expect(
      ScheduleKindSchema.safeParse({ kind: "cron", expression: "0 8 * * *" })
        .success,
    ).toBe(true);
  });

  it("accepts an expression with an IANA timezone", () => {
    expect(
      ScheduleKindSchema.safeParse({
        kind: "cron",
        expression: "0 8 * * *",
        timezone: "America/Sao_Paulo",
      }).success,
    ).toBe(true);
  });

  it("rejects a malformed expression", () => {
    expect(
      ScheduleKindSchema.safeParse({ kind: "cron", expression: "not a cron" })
        .success,
    ).toBe(false);
  });

  it("[drift] admits an unknown IANA timezone — croner only rejects on nextRun()", () => {
    // Documents a schema gap: the .refine() hook constructs
    //   new Cron(expression, { timezone, paused: true })
    // which never calls nextRun(), so croner defers timezone validation
    // until the first scheduled fire. Unknown zones slip through Zod
    // today but will throw when the scheduler actually computes the
    // next fire time — which happens inside parseSchedule() in
    // ScheduleService.create, so bad input is still caught before
    // persistence. Locked as a test so a future "helpful" tightening of
    // the schema to call nextRun() is an intentional change, not an
    // accidental one.
    expect(
      ScheduleKindSchema.safeParse({
        kind: "cron",
        expression: "0 8 * * *",
        timezone: "Not/A_Zone",
      }).success,
    ).toBe(true);
  });

  it("rejects an empty expression", () => {
    expect(
      ScheduleKindSchema.safeParse({ kind: "cron", expression: "" }).success,
    ).toBe(false);
  });
});

describe("ScheduleKindSchema — discriminator", () => {
  it("rejects an unknown kind", () => {
    expect(
      ScheduleKindSchema.safeParse({ kind: "hourly", interval: "1h" }).success,
    ).toBe(false);
  });

  it("rejects an 'every' body that omits interval", () => {
    expect(ScheduleKindSchema.safeParse({ kind: "every" }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ScheduleCreateSchema
// ---------------------------------------------------------------------------

describe("ScheduleCreateSchema", () => {
  const valid = {
    name: "Morning digest",
    schedule: { kind: "every", interval: "1h" },
    prompt: "Summarise the last hour.",
  } as const;

  it("accepts a minimal valid body", () => {
    expect(ScheduleCreateSchema.safeParse(valid).success).toBe(true);
  });

  it("accepts delivery.announce with just chatId (channelType/accountId optional)", () => {
    const result = ScheduleCreateSchema.safeParse({
      ...valid,
      delivery: { mode: "announce", chatId: "123" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects delivery.announce without chatId", () => {
    const result = ScheduleCreateSchema.safeParse({
      ...valid,
      delivery: { mode: "announce" },
    });
    expect(result.success).toBe(false);
  });

  it("accepts delivery.none", () => {
    const result = ScheduleCreateSchema.safeParse({
      ...valid,
      delivery: { mode: "none" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown delivery.mode", () => {
    expect(
      ScheduleCreateSchema.safeParse({
        ...valid,
        delivery: { mode: "email", address: "x@example.com" },
      }).success,
    ).toBe(false);
  });

  it.each([
    ["isolated", true],
    ["session:main", true],
    ["session:my_session-1", true],
    ["session:", false],
    ["session:with spaces", false],
    ["other", false],
  ] as const)("sessionTarget %j → ok=%s", (sessionTarget, ok) => {
    const result = ScheduleCreateSchema.safeParse({
      ...valid,
      sessionTarget,
    });
    expect(result.success).toBe(ok);
  });

  it("rejects an empty name", () => {
    expect(
      ScheduleCreateSchema.safeParse({ ...valid, name: "" }).success,
    ).toBe(false);
  });

  it("rejects an empty prompt", () => {
    expect(
      ScheduleCreateSchema.safeParse({ ...valid, prompt: "" }).success,
    ).toBe(false);
  });

  it("rejects a targetAgent that violates the agentName regex", () => {
    expect(
      ScheduleCreateSchema.safeParse({ ...valid, targetAgent: "-bad" }).success,
    ).toBe(false);
  });

  it("rejects a timeoutMs above the 2h cap", () => {
    expect(
      ScheduleCreateSchema.safeParse({
        ...valid,
        timeoutMs: 3 * 60 * 60 * 1000,
      }).success,
    ).toBe(false);
  });

  it("rejects a zero timeoutMs", () => {
    expect(
      ScheduleCreateSchema.safeParse({ ...valid, timeoutMs: 0 }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ScheduleUpdateSchema — all fields optional
// ---------------------------------------------------------------------------

describe("ScheduleUpdateSchema", () => {
  it("accepts an empty object", () => {
    expect(ScheduleUpdateSchema.safeParse({}).success).toBe(true);
  });

  it("accepts model: null (explicit clear)", () => {
    expect(ScheduleUpdateSchema.safeParse({ model: null }).success).toBe(true);
  });

  it("still validates schedule shape when provided", () => {
    expect(
      ScheduleUpdateSchema.safeParse({
        schedule: { kind: "cron", expression: "bogus" },
      }).success,
    ).toBe(false);
  });

  it("rejects a name that exceeds the 200-char cap", () => {
    expect(
      ScheduleUpdateSchema.safeParse({ name: "x".repeat(201) }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Request wrappers (caller + input / patch)
// ---------------------------------------------------------------------------

describe("ScheduleCreateRequestSchema", () => {
  it("requires a caller object", () => {
    const result = ScheduleCreateRequestSchema.safeParse({
      input: {
        name: "x",
        schedule: { kind: "every", interval: "1h" },
        prompt: "p",
      },
    });
    expect(result.success).toBe(false);
  });

  it("accepts a minimal caller with just agentName", () => {
    const result = ScheduleCreateRequestSchema.safeParse({
      caller: { agentName: "alice" },
      input: {
        name: "x",
        schedule: { kind: "every", interval: "1h" },
        prompt: "p",
      },
    });
    expect(result.success).toBe(true);
  });

  it("produces path-prefixed errors under input.schedule on bad schedule", () => {
    const result = validateBody(ScheduleCreateRequestSchema, {
      caller: { agentName: "alice" },
      input: {
        name: "x",
        schedule: { kind: "cron", expression: "nope" },
        prompt: "p",
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      // The helper joins paths with ".". Lock the prefix so a future
      // validator swap can't silently change the error shape that the
      // web UI / MCP tools render back to the agent.
      expect(result.error).toMatch(/input\.schedule/);
    }
  });
});

describe("ScheduleMutationRequestSchema", () => {
  it("only requires caller.agentName (for DELETE and /:id/run)", () => {
    expect(
      ScheduleMutationRequestSchema.safeParse({
        caller: { agentName: "alice" },
      }).success,
    ).toBe(true);
  });

  it("rejects a caller with an invalid agentName", () => {
    expect(
      ScheduleMutationRequestSchema.safeParse({
        caller: { agentName: "-bad" },
      }).success,
    ).toBe(false);
  });
});
