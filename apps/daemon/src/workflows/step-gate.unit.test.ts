import { describe, it, expect, vi } from "vitest";
import {
  executeGateStep,
  type GateStepDeps,
  type GateResolution,
} from "./step-gate.js";
import type { GateStep, GateRecord, WorkflowOriginator } from "../shared/types/index.js";

const originator: WorkflowOriginator = {
  agent: "pm",
  channelType: "telegram",
  accountId: "pm-bot",
  chatId: "12345",
};

const baseStep: GateStep = {
  id: "approve-plan",
  kind: "gate",
  prompt: "Review dev-plan.md and decide",
};

/** Fixed timestamp and suffix so gate ids are deterministic. */
const FROZEN_NOW = new Date("2026-04-15T00:00:00.000Z");
const FROZEN_GATE_ID = `gate_${FROZEN_NOW.getTime()}_aaaaaa`;

const approval: GateResolution = {
  decision: "approved",
  decidedBy: "telegram:42",
  note: "ship it",
  decidedAt: "2026-04-15T00:00:01.000Z",
};

function buildDeps(overrides: Partial<GateStepDeps> = {}): GateStepDeps & {
  writtenGates: GateRecord[];
  channelCalls: Array<{ agent: string; channelType: string; chatId: string; text: string }>;
  hookCalls: Array<{ event: string; payload: unknown }>;
  resolveRegistrations: Array<{ runId: string; gateId: string }>;
} {
  const writtenGates: GateRecord[] = [];
  const channelCalls: Array<{ agent: string; channelType: string; chatId: string; text: string }> = [];
  const hookCalls: Array<{ event: string; payload: unknown }> = [];
  const resolveRegistrations: Array<{ runId: string; gateId: string }> = [];

  return Object.assign({
    now: () => FROZEN_NOW,
    randomSuffix: () => "aaaaaa",
    writeGate: vi.fn(async (record: GateRecord) => {
      writtenGates.push(record);
    }),
    registerPendingGate: vi.fn(async (runId: string, gateId: string) => {
      resolveRegistrations.push({ runId, gateId });
      return approval;
    }),
    sendToChannel: vi.fn((agent: string, channelType: string, chatId: string, text: string) => {
      channelCalls.push({ agent, channelType, chatId, text });
    }),
    hooks: {
      emit: vi.fn((event, payload) => {
        hookCalls.push({ event, payload });
      }),
    },
    writtenGates,
    channelCalls,
    hookCalls,
    resolveRegistrations,
    ...overrides,
  });
}

function request(overrides: Partial<Parameters<typeof executeGateStep>[1]> = {}) {
  return {
    runId: "run_1_aaaaaa",
    stepKey: "approve-plan",
    step: baseStep,
    originator,
    templateInputs: {},
    templateArtifacts: {},
    ...overrides,
  };
}

describe("executeGateStep — happy path", () => {
  it("writes a pending gate record, notifies the channel, and awaits resolution", async () => {
    const deps = buildDeps();
    const outcome = await executeGateStep(deps, request());
    expect(outcome.status).toBe("approved");
    expect(outcome.gateId).toBe(FROZEN_GATE_ID);
    expect(deps.writtenGates).toHaveLength(1);
    expect(deps.writtenGates[0]!.status).toBe("pending");
    expect(deps.writtenGates[0]!.gateId).toBe(FROZEN_GATE_ID);
    expect(deps.channelCalls).toHaveLength(1);
    expect(deps.resolveRegistrations).toHaveLength(1);
  });

  it("prefixes the notification with the WORKFLOW GATE marker", async () => {
    const deps = buildDeps();
    await executeGateStep(deps, request());
    const call = deps.channelCalls[0]!;
    expect(call.text).toMatch(new RegExp(`^\\[WORKFLOW GATE ${FROZEN_GATE_ID}\\]\\n`));
    expect(call.text).toContain("Review dev-plan.md and decide");
  });

  it("sends the notification to the originator's conversation", async () => {
    const deps = buildDeps();
    await executeGateStep(deps, request());
    const call = deps.channelCalls[0]!;
    expect(call.agent).toBe("pm");
    expect(call.channelType).toBe("telegram");
    expect(call.chatId).toBe("12345");
  });

  it("registers the pending promise BEFORE sending the notification", async () => {
    const order: string[] = [];
    const deps = buildDeps({
      writeGate: vi.fn(async () => { order.push("write"); }),
      registerPendingGate: vi.fn(async () => {
        order.push("register");
        return approval;
      }),
      sendToChannel: vi.fn(() => { order.push("send"); }),
    });
    await executeGateStep(deps, request());
    // write → register → emit → send → await
    // register must come before send; write must come first
    expect(order.indexOf("write")).toBeLessThan(order.indexOf("register"));
    expect(order.indexOf("register")).toBeLessThan(order.indexOf("send"));
  });

  it("emits workflow:gate_waiting with the pending record", async () => {
    const deps = buildDeps();
    await executeGateStep(deps, request());
    expect(deps.hookCalls).toHaveLength(1);
    expect(deps.hookCalls[0]!.event).toBe("workflow:gate_waiting");
    const payload = deps.hookCalls[0]!.payload as { runId: string; gate: GateRecord };
    expect(payload.runId).toBe("run_1_aaaaaa");
    expect(payload.gate.status).toBe("pending");
  });

  it("propagates template variables into the gate prompt", async () => {
    const deps = buildDeps();
    await executeGateStep(deps, request({
      step: { ...baseStep, prompt: "Decide for {{inputs.feature}}" },
      templateInputs: { feature: "login" },
    }));
    expect(deps.channelCalls[0]!.text).toContain("Decide for login");
    expect(deps.writtenGates[0]!.prompt).toContain("Decide for login");
  });

  it("captures the originator's accountId in the gate record", async () => {
    const deps = buildDeps();
    await executeGateStep(deps, request());
    expect(deps.writtenGates[0]!.notifiedAccountId).toBe("pm-bot");
  });

  it("records declared input artifacts on the gate record", async () => {
    const deps = buildDeps();
    await executeGateStep(deps, request({
      step: { ...baseStep, inputs: ["dev-plan.md", "test-results.md"] },
    }));
    expect(deps.writtenGates[0]!.inputArtifacts).toEqual(["dev-plan.md", "test-results.md"]);
  });

  it("returns approved outcome fields from the resolution", async () => {
    const deps = buildDeps();
    const outcome = await executeGateStep(deps, request());
    if (outcome.status === "failed_to_open") throw new Error("unexpected failed_to_open");
    expect(outcome.status).toBe("approved");
    expect(outcome.note).toBe("ship it");
    expect(outcome.decidedBy).toBe("telegram:42");
    expect(outcome.decidedAt).toBe("2026-04-15T00:00:01.000Z");
  });

  it("propagates denied resolution as a denied outcome", async () => {
    const deps = buildDeps({
      registerPendingGate: vi.fn(async () => ({
        decision: "denied",
        decidedBy: "telegram:42",
        note: "plan too risky",
        decidedAt: "2026-04-15T00:00:02.000Z",
      })),
    });
    const outcome = await executeGateStep(deps, request());
    expect(outcome.status).toBe("denied");
    if (outcome.status === "denied") {
      expect(outcome.note).toBe("plan too risky");
    }
  });
});

describe("executeGateStep — failure modes", () => {
  it("returns failed_to_open when the prompt template references an unknown input", async () => {
    const deps = buildDeps();
    const outcome = await executeGateStep(deps, request({
      step: { ...baseStep, prompt: "Decide for {{inputs.missing}}" },
    }));
    expect(outcome.status).toBe("failed_to_open");
    if (outcome.status === "failed_to_open") {
      expect(outcome.failReason).toMatch(/Template render failed/);
    }
    expect(deps.writtenGates).toHaveLength(0);
    expect(deps.channelCalls).toHaveLength(0);
  });

  it("returns failed_to_open when writeGate throws", async () => {
    const deps = buildDeps({
      writeGate: vi.fn(async () => { throw new Error("disk full"); }),
    });
    const outcome = await executeGateStep(deps, request());
    expect(outcome.status).toBe("failed_to_open");
    if (outcome.status === "failed_to_open") {
      expect(outcome.failReason).toMatch(/Could not persist gate/);
      expect(outcome.failReason).toMatch(/disk full/);
    }
    expect(deps.channelCalls).toHaveLength(0);
  });
});
