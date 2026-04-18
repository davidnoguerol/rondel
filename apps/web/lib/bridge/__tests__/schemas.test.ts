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
  LedgerQueryResponseSchema,
  LedgerStreamFrameSchema,
  ListAgentsResponseSchema,
  MemoryResponseSchema,
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
});
