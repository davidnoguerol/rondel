/**
 * Fixture test for bridge response schemas.
 *
 * Why this test exists:
 *   The web package and daemon package ship independently. The most likely
 *   way M1 breaks is that the daemon changes a response shape and the
 *   web package doesn't update its schemas. This test locks in the shapes
 *   at a known-good point in time by parsing real captured responses.
 *
 * Fixtures are captured manually by hitting the daemon and saving the raw
 * JSON to `__fixtures__/`. When a schema is intentionally changed:
 *   1. Update the schema in `lib/bridge/schemas.ts`.
 *   2. Bump `BRIDGE_API_VERSION` in `apps/daemon/src/bridge/schemas.ts`.
 *   3. Recapture the fixture from a running daemon.
 *   4. Run this test.
 *
 * If this test fails without an intentional schema change, the daemon
 * and web are drifting — investigate before pushing.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  AgentStateFrameSchema,
  ConversationHistoryResponseSchema,
  ConversationStreamFrameSchema,
  ConversationsResponseSchema,
  HeartbeatReadAllResponseSchema,
  HeartbeatStreamFrameSchema,
  HeartbeatUpdateResponseSchema,
  LedgerQueryResponseSchema,
  LedgerStreamFrameSchema,
  ListAgentsResponseSchema,
  MemoryResponseSchema,
  MultiplexedEnvelopeSchema,
  ScheduleListResponseSchema,
  ScheduleStreamFrameSchema,
  VersionResponseSchema,
} from "../schemas";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, "..", "__fixtures__");

function loadFixture(name: string): unknown {
  const raw = readFileSync(join(FIXTURES, name), "utf-8");
  return JSON.parse(raw);
}

describe("bridge response schemas", () => {
  it("parses /version", () => {
    const parsed = VersionResponseSchema.safeParse(loadFixture("version.json"));
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.apiVersion).toBeGreaterThanOrEqual(1);
      expect(parsed.data.rondelVersion).toMatch(/^\d+\.\d+\.\d+/);
    }
  });

  it("parses /agents", () => {
    const parsed = ListAgentsResponseSchema.safeParse(loadFixture("agents.json"));
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(Array.isArray(parsed.data.agents)).toBe(true);
    }
  });

  it("parses /conversations/:name", () => {
    const parsed = ConversationsResponseSchema.safeParse(
      loadFixture("conversations.json"),
    );
    expect(parsed.success).toBe(true);
  });

  it("parses /memory/:agent", () => {
    const parsed = MemoryResponseSchema.safeParse(loadFixture("memory.json"));
    expect(parsed.success).toBe(true);
  });

  it("parses /ledger/query", () => {
    const parsed = LedgerQueryResponseSchema.safeParse(
      loadFixture("ledger-query.json"),
    );
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(Array.isArray(parsed.data.events)).toBe(true);
    }
  });

  // ---------------------------------------------------------------------
  // SSE frame fixtures (M2)
  // ---------------------------------------------------------------------

  it("parses an SSE ledger.appended frame", () => {
    const parsed = LedgerStreamFrameSchema.safeParse(
      loadFixture("ledger-stream-frame.json"),
    );
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.event).toBe("ledger.appended");
      expect(typeof parsed.data.data.ts).toBe("string");
    }
  });

  it("parses an SSE agent_state.snapshot frame", () => {
    const parsed = AgentStateFrameSchema.safeParse(
      loadFixture("agent-state-snapshot-frame.json"),
    );
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.event === "agent_state.snapshot") {
      expect(parsed.data.data.kind).toBe("snapshot");
      expect(Array.isArray(parsed.data.data.entries)).toBe(true);
    }
  });

  it("parses an SSE agent_state.delta frame", () => {
    const parsed = AgentStateFrameSchema.safeParse(
      loadFixture("agent-state-delta-frame.json"),
    );
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.event === "agent_state.delta") {
      expect(parsed.data.data.kind).toBe("delta");
      expect(typeof parsed.data.data.entry.agentName).toBe("string");
    }
  });

  // ---------------------------------------------------------------------
  // Multiplex envelope (v17)
  //
  // Two-step validation: parse the envelope, then re-parse the inner
  // frame with the topic-specific schema. This is the load-bearing
  // discipline that catches daemon/web drift on the new transport.
  // Without these tests, a renamed inner-frame field (e.g. heartbeat
  // record adding/removing fields) would only surface as a runtime
  // "Bridge response schema mismatch" in the dashboard.
  // ---------------------------------------------------------------------

  it("parses a multiplex envelope wrapping an agent_state.snapshot frame", () => {
    const parsed = MultiplexedEnvelopeSchema.safeParse(
      loadFixture("multiplex-envelope-agent-state.json"),
    );
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.event).toBe("multiplex");
    expect(parsed.data.data.topic).toBe("agents-state");
    // Re-validate the inner frame with the topic-specific schema —
    // this is what useStreamTopic does at runtime in the agents-state
    // hook's parser. Drift here surfaces the same way as runtime.
    const inner = AgentStateFrameSchema.safeParse(parsed.data.data.frame);
    expect(inner.success).toBe(true);
    if (inner.success && inner.data.event === "agent_state.snapshot") {
      expect(inner.data.data.kind).toBe("snapshot");
      expect(Array.isArray(inner.data.data.entries)).toBe(true);
    }
  });

  it("parses a multiplex envelope wrapping a ledger.appended frame", () => {
    const parsed = MultiplexedEnvelopeSchema.safeParse(
      loadFixture("multiplex-envelope-ledger.json"),
    );
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.event).toBe("multiplex");
    expect(parsed.data.data.topic).toBe("ledger");
    const inner = LedgerStreamFrameSchema.safeParse(parsed.data.data.frame);
    expect(inner.success).toBe(true);
    if (inner.success) {
      expect(inner.data.event).toBe("ledger.appended");
      expect(typeof inner.data.data.ts).toBe("string");
    }
  });

  it("rejects a multiplex envelope with an unknown topic", () => {
    const bad = {
      event: "multiplex",
      data: { topic: "made-up-topic", frame: { event: "x", data: {} } },
    };
    const parsed = MultiplexedEnvelopeSchema.safeParse(bad);
    expect(parsed.success).toBe(false);
  });

  // ---------------------------------------------------------------------
  // Web-chat fixtures (v3)
  // ---------------------------------------------------------------------

  it("parses /conversations/:agent/:channelType/:chatId/history", () => {
    const parsed = ConversationHistoryResponseSchema.safeParse(
      loadFixture("conversation-history.json"),
    );
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.turns).toHaveLength(2);
      expect(parsed.data.sessionId).toMatch(/^[0-9a-f-]+$/);
    }
  });

  it("parses a conversation.frame user_message", () => {
    const parsed = ConversationStreamFrameSchema.safeParse(
      loadFixture("conversation-frame-user.json"),
    );
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.event).toBe("conversation.frame");
      expect(parsed.data.data.kind).toBe("user_message");
      if (parsed.data.data.kind === "user_message") {
        expect(parsed.data.data.text).toBe("hello");
      }
    }
  });

  it("parses a conversation.frame agent_response", () => {
    const parsed = ConversationStreamFrameSchema.safeParse(
      loadFixture("conversation-frame-response.json"),
    );
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.data.kind === "agent_response") {
      expect(parsed.data.data.text).toMatch(/hi there/);
    }
  });

  it("parses a conversation.frame typing_start", () => {
    const parsed = ConversationStreamFrameSchema.safeParse(
      loadFixture("conversation-frame-typing.json"),
    );
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.data.kind).toBe("typing_start");
    }
  });

  it("rejects a malformed conversation.frame", () => {
    const parsed = ConversationStreamFrameSchema.safeParse({
      event: "conversation.frame",
      data: { kind: "user_message" }, // missing ts + text
    });
    expect(parsed.success).toBe(false);
  });

  // ---------------------------------------------------------------------
  // Schedules fixtures (v14)
  // ---------------------------------------------------------------------

  it("parses /schedules with a cron + one-shot mix", () => {
    const parsed = ScheduleListResponseSchema.safeParse(
      loadFixture("schedules-list.json"),
    );
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.schedules).toHaveLength(2);
      expect(parsed.data.schedules[0].schedule.kind).toBe("cron");
      expect(parsed.data.schedules[1].schedule.kind).toBe("at");
    }
  });

  it("parses a schedule.created stream frame", () => {
    const parsed = ScheduleStreamFrameSchema.safeParse(
      loadFixture("schedule-stream-created-frame.json"),
    );
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.event).toBe("schedule.created");
      expect(parsed.data.data.source).toBe("runtime");
    }
  });

  it("parses a schedule.ran stream frame with fresh state", () => {
    const parsed = ScheduleStreamFrameSchema.safeParse(
      loadFixture("schedule-stream-ran-frame.json"),
    );
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.event === "schedule.ran") {
      expect(parsed.data.data.lastStatus).toBe("ok");
      expect(typeof parsed.data.data.lastRunAtMs).toBe("number");
    }
  });

  it("parses a schedule.deleted stream frame and requires a reason", () => {
    const parsed = ScheduleStreamFrameSchema.safeParse(
      loadFixture("schedule-stream-deleted-frame.json"),
    );
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.event === "schedule.deleted") {
      expect(parsed.data.data.reason).toBe("requested");
    }
  });

  it("rejects a schedule.deleted frame without a reason", () => {
    const parsed = ScheduleStreamFrameSchema.safeParse({
      event: "schedule.deleted",
      data: {
        id: "sched_1745100000_feedface",
        name: "x",
        enabled: true,
        schedule: { kind: "every", interval: "5m" },
        prompt: "run",
        sessionTarget: "isolated",
        source: "runtime",
      },
    });
    expect(parsed.success).toBe(false);
  });

  // ---------------------------------------------------------------------
  // Heartbeats (v15)
  // ---------------------------------------------------------------------
  //
  // No on-disk fixtures yet — these are inline, same style as the
  // schedule.deleted rejection test above. Capture real fixtures the
  // first time the dashboard consumes the endpoints.

  const sampleRecordWithHealth = {
    agent: "scout",
    org: "flint",
    status: "wrapped up inbox sweep, nothing urgent",
    currentTask: "draft weekly summary",
    updatedAt: "2026-04-20T09:00:00.000Z",
    intervalMs: 4 * 60 * 60 * 1000,
    notes: undefined,
    health: "healthy",
    ageMs: 0,
  };

  it("parses /heartbeats/:org response", () => {
    const parsed = HeartbeatReadAllResponseSchema.safeParse({
      records: [sampleRecordWithHealth],
      missing: ["newcomer"],
      summary: { healthy: 1, stale: 0, down: 0, missing: 1 },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.records[0].health).toBe("healthy");
    }
  });

  it("rejects a heartbeat record with an unknown health value", () => {
    const parsed = HeartbeatReadAllResponseSchema.safeParse({
      records: [{ ...sampleRecordWithHealth, health: "yellow" }],
      missing: [],
      summary: { healthy: 0, stale: 0, down: 0, missing: 0 },
    });
    expect(parsed.success).toBe(false);
  });

  it("parses POST /heartbeats/update response (bare record, no health)", () => {
    // The write path returns the on-disk record WITHOUT computed health —
    // if this test starts rejecting because the daemon added health/ageMs
    // to the write response, widen `record` to HeartbeatRecordWithHealthSchema.
    const { health, ageMs, ...bareRecord } = sampleRecordWithHealth;
    void health; void ageMs;
    const parsed = HeartbeatUpdateResponseSchema.safeParse({
      ok: true,
      record: bareRecord,
    });
    expect(parsed.success).toBe(true);
  });

  it("parses a heartbeat.snapshot frame", () => {
    const parsed = HeartbeatStreamFrameSchema.safeParse({
      event: "heartbeat.snapshot",
      data: { kind: "snapshot", entries: [sampleRecordWithHealth] },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.event === "heartbeat.snapshot") {
      expect(parsed.data.data.entries).toHaveLength(1);
    }
  });

  it("parses a heartbeat.delta frame", () => {
    const parsed = HeartbeatStreamFrameSchema.safeParse({
      event: "heartbeat.delta",
      data: { kind: "delta", entry: { ...sampleRecordWithHealth, health: "stale", ageMs: 6 * 60 * 60 * 1000 } },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.event === "heartbeat.delta") {
      expect(parsed.data.data.entry.health).toBe("stale");
    }
  });

  it("rejects a heartbeat frame with a mismatched discriminator", () => {
    // snapshot event carrying delta-shaped data — discriminated union
    // should reject this.
    const parsed = HeartbeatStreamFrameSchema.safeParse({
      event: "heartbeat.snapshot",
      data: { kind: "delta", entry: sampleRecordWithHealth },
    });
    expect(parsed.success).toBe(false);
  });
});
