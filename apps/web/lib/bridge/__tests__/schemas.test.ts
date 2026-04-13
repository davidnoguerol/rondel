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
  ConversationsResponseSchema,
  LedgerQueryResponseSchema,
  LedgerStreamFrameSchema,
  ListAgentsResponseSchema,
  MemoryResponseSchema,
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
});
