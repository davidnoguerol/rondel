/**
 * Ledger writer — channelType threading.
 *
 * Scope:
 *
 * 1. Hook → ledger threading: when a conversation/session hook fires
 *    with `channelType`, the constructed `LedgerEvent` carries it
 *    through to every subscriber of `onAppended`. This is the
 *    fire-and-forget seam the SSE stream uses, so asserting on it is
 *    deterministic (no disk latency) and covers the same object that
 *    gets persisted.
 *
 * 2. The `channelType`/`chatId` pairing invariant: conversation and
 *    session events carry both, cron events carry neither.
 */

import { describe, it, expect } from "vitest";

import { withTmpRondel } from "../../../../tests/helpers/tmp.js";
import { createHooks } from "../shared/hooks.js";
import type { CronJob, CronRunResult } from "../shared/types/index.js";
import { LedgerWriter } from "./ledger-writer.js";
import type { LedgerEvent } from "./ledger-types.js";

// -----------------------------------------------------------------------------
// Helper: capture all events appended to the writer, regardless of agent.
// -----------------------------------------------------------------------------

function captureAppended(writer: LedgerWriter): LedgerEvent[] {
  const captured: LedgerEvent[] = [];
  writer.onAppended((e) => captured.push(e));
  return captured;
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe("LedgerWriter — channelType threading", () => {
  it("records channelType on user_message entries", () => {
    const tmp = withTmpRondel();
    const hooks = createHooks();
    const writer = new LedgerWriter(tmp.stateDir, hooks);
    const captured = captureAppended(writer);

    hooks.emit("conversation:message_in", {
      agentName: "alice",
      channelType: "telegram",
      chatId: "12345",
      text: "hello",
      senderId: "u1",
      senderName: "User One",
    });

    expect(captured).toHaveLength(1);
    expect(captured[0].kind).toBe("user_message");
    expect(captured[0].channelType).toBe("telegram");
    expect(captured[0].chatId).toBe("12345");
  });

  it("records channelType on agent_response entries", () => {
    const tmp = withTmpRondel();
    const hooks = createHooks();
    const writer = new LedgerWriter(tmp.stateDir, hooks);
    const captured = captureAppended(writer);

    hooks.emit("conversation:response", {
      agentName: "alice",
      channelType: "web",
      chatId: "web-chat-1",
      text: "hi there",
    });

    expect(captured).toHaveLength(1);
    expect(captured[0].kind).toBe("agent_response");
    expect(captured[0].channelType).toBe("web");
    expect(captured[0].chatId).toBe("web-chat-1");
  });

  it("distinguishes same chatId across different channels", () => {
    // Two conversations that share a chatId string but come from
    // different channels must produce two distinct ledger entries that
    // a consumer can tell apart — this is the core problem the change
    // exists to solve.
    const tmp = withTmpRondel();
    const hooks = createHooks();
    const writer = new LedgerWriter(tmp.stateDir, hooks);
    const captured = captureAppended(writer);

    hooks.emit("conversation:message_in", {
      agentName: "alice",
      channelType: "telegram",
      chatId: "1",
      text: "from telegram",
    });
    hooks.emit("conversation:message_in", {
      agentName: "alice",
      channelType: "web",
      chatId: "1",
      text: "from web",
    });

    expect(captured).toHaveLength(2);
    expect(captured[0].channelType).toBe("telegram");
    expect(captured[1].channelType).toBe("web");
    // chatId alone would collide — the test would fail without channelType.
    expect(captured[0].chatId).toBe(captured[1].chatId);
  });

  it("records channelType on every session lifecycle entry", () => {
    const tmp = withTmpRondel();
    const hooks = createHooks();
    const writer = new LedgerWriter(tmp.stateDir, hooks);
    const captured = captureAppended(writer);

    hooks.emit("session:start", {
      agentName: "alice",
      channelType: "telegram",
      chatId: "c1",
      sessionId: "sess-1111aaaa",
    });
    hooks.emit("session:resumed", {
      agentName: "alice",
      channelType: "telegram",
      chatId: "c1",
      sessionId: "sess-2222bbbb",
    });
    hooks.emit("session:reset", {
      agentName: "alice",
      channelType: "telegram",
      chatId: "c1",
    });
    hooks.emit("session:crash", {
      agentName: "alice",
      channelType: "telegram",
      chatId: "c1",
      sessionId: "sess-3333cccc",
    });
    hooks.emit("session:halt", {
      agentName: "alice",
      channelType: "telegram",
      chatId: "c1",
      sessionId: "sess-4444dddd",
    });

    expect(captured.map((e) => e.kind)).toEqual([
      "session_start",
      "session_resumed",
      "session_reset",
      "crash",
      "halt",
    ]);
    for (const entry of captured) {
      expect(entry.channelType).toBe("telegram");
      expect(entry.chatId).toBe("c1");
    }
  });
});

describe("LedgerWriter — invariant: channelType iff chatId", () => {
  it("cron_completed entries carry neither chatId nor channelType", () => {
    const tmp = withTmpRondel();
    const hooks = createHooks();
    const writer = new LedgerWriter(tmp.stateDir, hooks);
    const captured = captureAppended(writer);

    const job: CronJob = {
      id: "job-1",
      name: "daily-digest",
      schedule: { kind: "every", interval: "1h" },
      prompt: "Summarise yesterday",
      enabled: true,
    };
    const result: CronRunResult = {
      status: "ok",
      durationMs: 1234,
      costUsd: 0.0021,
    };

    hooks.emit("cron:completed", { agentName: "alice", job, result });

    expect(captured).toHaveLength(1);
    expect(captured[0].kind).toBe("cron_completed");
    expect(captured[0].chatId).toBeUndefined();
    expect(captured[0].channelType).toBeUndefined();
  });
});

// -----------------------------------------------------------------------------
// Workflow event wiring (Layer 4 v0)
//
// Every workflow:* hook fires with an originator — the agent whose
// conversation triggered the run. The ledger writer keys each event on
// that agent and carries the conversation identity through so the ledger
// query / SSE stream both see a well-formed event.
// -----------------------------------------------------------------------------

describe("LedgerWriter — workflow events", () => {
  const originator = {
    agent: "pm",
    channelType: "telegram",
    accountId: "pm-bot",
    chatId: "12345",
  };

  it("records workflow_started on the originator's ledger", () => {
    const tmp = withTmpRondel();
    const hooks = createHooks();
    const writer = new LedgerWriter(tmp.stateDir, hooks);
    const captured = captureAppended(writer);

    hooks.emit("workflow:started", {
      run: {
        runId: "run_1_aaaaaa",
        workflowId: "full-feature-dev",
        workflowVersion: 1,
        status: "running",
        startedAt: "2026-04-15T00:00:00.000Z",
        updatedAt: "2026-04-15T00:00:00.000Z",
        completedAt: null,
        originator,
        inputs: {},
        currentStepKey: null,
        stepStates: {},
        failReason: null,
      },
    });

    expect(captured).toHaveLength(1);
    expect(captured[0].kind).toBe("workflow_started");
    expect(captured[0].agent).toBe("pm");
    expect(captured[0].channelType).toBe("telegram");
    expect(captured[0].chatId).toBe("12345");
    expect(captured[0].summary).toContain("full-feature-dev");
  });

  it("records workflow_step_completed with the step id and artifact", () => {
    const tmp = withTmpRondel();
    const hooks = createHooks();
    const writer = new LedgerWriter(tmp.stateDir, hooks);
    const captured = captureAppended(writer);

    hooks.emit("workflow:step_completed", {
      runId: "run_1_aaaaaa",
      originator,
      stepState: {
        stepKey: "architecture",
        stepId: "architecture",
        kind: "agent",
        status: "completed",
        attempt: 1,
        startedAt: "2026-04-15T00:00:00.000Z",
        completedAt: "2026-04-15T00:01:00.000Z",
        outputArtifact: "dev-plan.md",
        summary: "plan drafted",
        failReason: null,
        subagentId: "sub_1_abc",
        gateId: null,
      },
    });

    expect(captured).toHaveLength(1);
    expect(captured[0].kind).toBe("workflow_step_completed");
    expect(captured[0].summary).toContain("architecture");
    expect(captured[0].summary).toContain("plan drafted");
    const detail = captured[0].detail as { outputArtifact: string };
    expect(detail.outputArtifact).toBe("dev-plan.md");
  });

  it("records workflow_gate_waiting and workflow_gate_resolved as a pair", () => {
    const tmp = withTmpRondel();
    const hooks = createHooks();
    const writer = new LedgerWriter(tmp.stateDir, hooks);
    const captured = captureAppended(writer);

    const gate = {
      gateId: "gate_1_aaaaaa",
      runId: "run_1_aaaaaa",
      stepKey: "approve-plan",
      status: "pending" as const,
      prompt: "approve?",
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

    hooks.emit("workflow:gate_waiting", {
      runId: "run_1_aaaaaa",
      originator,
      gate,
    });

    hooks.emit("workflow:gate_resolved", {
      runId: "run_1_aaaaaa",
      originator,
      gate: {
        ...gate,
        status: "resolved",
        resolvedAt: "2026-04-15T00:05:00.000Z",
        decision: "approved",
        decidedBy: "telegram:42",
        note: "LGTM",
      },
    });

    expect(captured).toHaveLength(2);
    expect(captured[0].kind).toBe("workflow_gate_waiting");
    expect(captured[1].kind).toBe("workflow_gate_resolved");
    expect(captured[1].summary).toContain("approved");
    expect(captured[1].summary).toContain("telegram:42");
  });

  it("records workflow_failed with the reason on the originator's ledger", () => {
    const tmp = withTmpRondel();
    const hooks = createHooks();
    const writer = new LedgerWriter(tmp.stateDir, hooks);
    const captured = captureAppended(writer);

    hooks.emit("workflow:failed", {
      runId: "run_1_aaaaaa",
      originator,
      workflowId: "full-feature-dev",
      reason: "step 'architecture' failed",
    });

    expect(captured).toHaveLength(1);
    expect(captured[0].kind).toBe("workflow_failed");
    expect(captured[0].summary).toContain("failed");
    expect(captured[0].summary).toContain("architecture");
  });

  it("records workflow_interrupted with the reason", () => {
    const tmp = withTmpRondel();
    const hooks = createHooks();
    const writer = new LedgerWriter(tmp.stateDir, hooks);
    const captured = captureAppended(writer);

    hooks.emit("workflow:interrupted", {
      runId: "run_1_aaaaaa",
      originator,
      reason: "Daemon restart while run was waiting-gate",
    });

    expect(captured).toHaveLength(1);
    expect(captured[0].kind).toBe("workflow_interrupted");
    expect(captured[0].summary).toContain("Daemon restart");
  });
});

