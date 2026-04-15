import { describe, it, expect } from "vitest";
import { WorkflowManager, GateResolutionError } from "./workflow-manager.js";
import { writeGateRecord, readGateRecord, ensureRunDirectories } from "./workflow-storage.js";
import { withTmpRondel } from "../../../../tests/helpers/tmp.js";
import { createCapturingLogger } from "../../../../tests/helpers/logger.js";
import { createHooks, type RondelHooks } from "../shared/hooks.js";
import type { GateRecord } from "../shared/types/index.js";

function makePendingRecord(runId: string, gateId: string): GateRecord {
  return {
    gateId,
    runId,
    stepKey: "approve-plan",
    status: "pending",
    prompt: "please approve",
    inputArtifacts: [],
    notifiedAgent: "pm",
    notifiedChannelType: "telegram",
    notifiedAccountId: "pm-bot",
    notifiedChatId: "12345",
    createdAt: "2026-04-15T00:00:00.000Z",
    resolvedAt: null,
    decision: null,
    note: null,
    decidedBy: null,
  };
}

/**
 * Capture every `workflow:*` event emitted on a hooks instance. Used by
 * tests to assert that the manager emits the right lifecycle events. We
 * subscribe to the specific event names rather than overriding `emit`
 * because RondelHooks's `emit` override is what gives per-listener error
 * isolation — we don't want to undo that in tests.
 */
function captureWorkflowEvents(hooks: RondelHooks): Array<{ event: string; payload: unknown }> {
  const records: Array<{ event: string; payload: unknown }> = [];
  const events = [
    "workflow:started",
    "workflow:step_started",
    "workflow:step_completed",
    "workflow:step_failed",
    "workflow:gate_waiting",
    "workflow:gate_resolved",
    "workflow:completed",
    "workflow:failed",
    "workflow:resumed",
    "workflow:interrupted",
  ] as const;
  for (const event of events) {
    hooks.on(event, (payload: unknown) => {
      records.push({ event, payload });
    });
  }
  return records;
}

function buildManager(tmpStateDir: string) {
  const hooks = createHooks();
  const records = captureWorkflowEvents(hooks);
  const logger = createCapturingLogger();
  const channelCalls: Array<{ agent: string; channelType: string; chatId: string; text: string }> = [];
  const manager = new WorkflowManager({
    stateDir: tmpStateDir,
    hooks,
    log: logger,
    sendToChannel: (agent, channelType, chatId, text) => {
      channelCalls.push({ agent, channelType, chatId, text });
    },
  });
  return { manager, hooks, records, channelCalls };
}

describe("WorkflowManager.resolveGate", () => {
  it("resolves a pending gate, writes the resolved record, and emits the hook", async () => {
    const tmp = withTmpRondel();
    const runId = "run_1_aaaaaa";
    const gateId = "gate_1_bbbbbb";

    await ensureRunDirectories(tmp.stateDir, runId);
    await writeGateRecord(tmp.stateDir, makePendingRecord(runId, gateId));

    const { manager, records } = buildManager(tmp.stateDir);

    const resolved = await manager.resolveGate(runId, gateId, {
      decision: "approved",
      decidedBy: "telegram:42",
      note: "LGTM",
    });

    expect(resolved.status).toBe("resolved");
    expect(resolved.decision).toBe("approved");
    expect(resolved.decidedBy).toBe("telegram:42");
    expect(resolved.note).toBe("LGTM");
    expect(resolved.resolvedAt).not.toBeNull();

    // Persisted to disk
    const onDisk = await readGateRecord(tmp.stateDir, runId, gateId);
    expect(onDisk?.status).toBe("resolved");
    expect(onDisk?.decision).toBe("approved");

    // Hook emitted
    const events = records.filter((r) => r.event === "workflow:gate_resolved");
    expect(events).toHaveLength(1);
  });

  it("unblocks an in-memory waiter when a pending gate is resolved", async () => {
    const tmp = withTmpRondel();
    const runId = "run_1_aaaaaa";
    const gateId = "gate_1_bbbbbb";

    await ensureRunDirectories(tmp.stateDir, runId);
    await writeGateRecord(tmp.stateDir, makePendingRecord(runId, gateId));

    const { manager } = buildManager(tmp.stateDir);

    const waiter = manager.registerPendingGate(runId, gateId);

    await manager.resolveGate(runId, gateId, {
      decision: "denied",
      decidedBy: "telegram:42",
      note: null,
    });

    const resolution = await waiter;
    expect(resolution.decision).toBe("denied");
    expect(resolution.note).toBeNull();
    expect(resolution.decidedBy).toBe("telegram:42");
    expect(typeof resolution.decidedAt).toBe("string");
  });

  it("drops the pending entry from the registry after resolve", async () => {
    const tmp = withTmpRondel();
    const runId = "run_1_aaaaaa";
    const gateId = "gate_1_bbbbbb";

    await ensureRunDirectories(tmp.stateDir, runId);
    await writeGateRecord(tmp.stateDir, makePendingRecord(runId, gateId));

    const { manager } = buildManager(tmp.stateDir);

    const waiter = manager.registerPendingGate(runId, gateId);
    expect(manager.hasPendingGate(gateId)).toBe(true);

    await manager.resolveGate(runId, gateId, {
      decision: "approved",
      decidedBy: "telegram:42",
      note: null,
    });

    await waiter;
    expect(manager.hasPendingGate(gateId)).toBe(false);
  });

  it("throws not_found for an unknown gate", async () => {
    const tmp = withTmpRondel();
    const { manager } = buildManager(tmp.stateDir);
    await expect(
      manager.resolveGate("run_1_aaaaaa", "gate_999_zzzzzz", {
        decision: "approved",
        decidedBy: "telegram:42",
        note: null,
      }),
    ).rejects.toMatchObject({ name: "GateResolutionError", code: "not_found" });
  });

  it("throws already_resolved if the gate was already decided", async () => {
    const tmp = withTmpRondel();
    const runId = "run_1_aaaaaa";
    const gateId = "gate_1_bbbbbb";

    await ensureRunDirectories(tmp.stateDir, runId);
    const record: GateRecord = {
      ...makePendingRecord(runId, gateId),
      status: "resolved",
      resolvedAt: "2026-04-15T00:00:00.000Z",
      decision: "approved",
      decidedBy: "telegram:42",
      note: null,
    };
    await writeGateRecord(tmp.stateDir, record);

    const { manager } = buildManager(tmp.stateDir);
    await expect(
      manager.resolveGate(runId, gateId, {
        decision: "denied",
        decidedBy: "telegram:42",
        note: null,
      }),
    ).rejects.toBeInstanceOf(GateResolutionError);
  });

  it("succeeds when no in-memory waiter is registered (crash-recovery scenario)", async () => {
    // Simulates: daemon restarted between registering and resolving.
    // No in-memory promise, but the resolve still lands on disk so crash
    // recovery can pick it up later.
    const tmp = withTmpRondel();
    const runId = "run_1_aaaaaa";
    const gateId = "gate_1_bbbbbb";

    await ensureRunDirectories(tmp.stateDir, runId);
    await writeGateRecord(tmp.stateDir, makePendingRecord(runId, gateId));

    const { manager, records } = buildManager(tmp.stateDir);

    const resolved = await manager.resolveGate(runId, gateId, {
      decision: "approved",
      decidedBy: "telegram:42",
      note: null,
    });

    expect(resolved.status).toBe("resolved");
    expect(records.some((r) => r.event === "workflow:gate_resolved")).toBe(true);
  });
});
