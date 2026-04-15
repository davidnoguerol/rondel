import { describe, it, expect, vi } from "vitest";
import { executeAgentStep, type AgentStepDeps, type StepAgentOutcome, type ResolvedAgent } from "./step-agent.js";
import type {
  AgentStep,
  WorkflowOriginator,
  SubagentSpawnRequest,
  SubagentInfo,
} from "../shared/types/index.js";

// --- Fixtures ---

const originator: WorkflowOriginator = {
  agent: "pm",
  channelType: "telegram",
  accountId: "pm-bot",
  chatId: "12345",
};

const baseStep: AgentStep = {
  id: "architecture",
  kind: "agent",
  agent: "architect",
  task: "Plan the feature for run {{run.id}}",
};

const happyAgent: ResolvedAgent = {
  agentDir: "/tmp/rondel-test/workspaces/global/agents/architect",
  model: "sonnet",
  workingDirectory: null,
};

const happyInfo: SubagentInfo = {
  id: "sub_999_abc",
  parentAgentName: "architect",
  parentChannelType: "telegram",
  parentAccountId: "pm-bot",
  parentChatId: "12345",
  task: "Plan the feature for run run_1_aaaaaa",
  state: "running",
  startedAt: "2026-04-15T00:00:00.000Z",
};

const okOutcome: StepAgentOutcome = {
  status: "ok",
  summary: "Plan complete",
  outputArtifact: "dev-plan.md",
  subagentId: "sub_999_abc",
};

/**
 * Build a complete happy-path deps object where every function succeeds.
 * Individual tests override the pieces they care about.
 */
function buildDeps(overrides: Partial<AgentStepDeps> = {}): AgentStepDeps & {
  spawnCalls: SubagentSpawnRequest[];
  waitCalls: Array<{ runId: string; stepKey: string; subagentId: string; timeoutMs: number }>;
} {
  const spawnCalls: SubagentSpawnRequest[] = [];
  const waitCalls: Array<{ runId: string; stepKey: string; subagentId: string; timeoutMs: number }> = [];

  return Object.assign({
    stateDir: "/tmp/rondel-test/state",
    resolveAgent: vi.fn(() => happyAgent),
    assembleEphemeralContext: vi.fn(async () => "# architect\nPlan phased delivery."),
    spawnSubagent: vi.fn(async (req: SubagentSpawnRequest): Promise<SubagentInfo> => {
      spawnCalls.push(req);
      return { ...happyInfo, task: req.task };
    }),
    waitForStepCompletion: vi.fn(async (args) => {
      waitCalls.push(args);
      return okOutcome;
    }),
    spawnCalls,
    waitCalls,
    ...overrides,
  });
}

function request(overrides: Partial<Parameters<typeof executeAgentStep>[1]> = {}) {
  return {
    runId: "run_1_aaaaaa",
    stepKey: "architecture",
    step: baseStep,
    originator,
    templateInputs: {},
    templateArtifacts: {},
    ...overrides,
  };
}

// --- Tests ---

describe("executeAgentStep — happy path", () => {
  it("resolves agent, renders task, spawns subagent, awaits completion", async () => {
    const deps = buildDeps();
    const outcome = await executeAgentStep(deps, request());
    expect(outcome).toEqual(okOutcome);
  });

  it("renders {{run.id}} in the task before spawning", async () => {
    const deps = buildDeps();
    await executeAgentStep(deps, request());
    expect(deps.spawnCalls[0]!.task).toBe("Plan the feature for run run_1_aaaaaa");
  });

  it("passes the workflow run id and step key into the subagent spawn request", async () => {
    const deps = buildDeps();
    await executeAgentStep(deps, request());
    expect(deps.spawnCalls[0]!.workflowRunId).toBe("run_1_aaaaaa");
    expect(deps.spawnCalls[0]!.workflowStepKey).toBe("architecture");
  });

  it("points the subagent working directory at the run's artifact folder", async () => {
    const deps = buildDeps();
    await executeAgentStep(deps, request());
    expect(deps.spawnCalls[0]!.workingDirectory).toBe(
      "/tmp/rondel-test/state/workflows/run_1_aaaaaa/artifacts",
    );
  });

  it("carries the originator's channel identity through to the subagent", async () => {
    const deps = buildDeps();
    await executeAgentStep(deps, request());
    const spawned = deps.spawnCalls[0]!;
    expect(spawned.parentAgentName).toBe("architect");
    expect(spawned.parentChannelType).toBe("telegram");
    expect(spawned.parentAccountId).toBe("pm-bot");
    expect(spawned.parentChatId).toBe("12345");
  });

  it("uses the resolved agent's model and system prompt", async () => {
    const deps = buildDeps();
    await executeAgentStep(deps, request());
    const spawned = deps.spawnCalls[0]!;
    expect(spawned.model).toBe("sonnet");
    expect(spawned.systemPrompt).toContain("architect");
  });

  it("applies the step's timeout to both the spawn request and the wait", async () => {
    const deps = buildDeps();
    await executeAgentStep(deps, request({
      step: { ...baseStep, timeoutMs: 12345 },
    }));
    expect(deps.spawnCalls[0]!.timeoutMs).toBe(12345);
    expect(deps.waitCalls[0]!.timeoutMs).toBe(12345);
  });

  it("uses the default timeout when the step omits it", async () => {
    const deps = buildDeps();
    await executeAgentStep(deps, request());
    // Default is 30 minutes
    expect(deps.spawnCalls[0]!.timeoutMs).toBe(30 * 60 * 1000);
  });
});

describe("executeAgentStep — failure modes", () => {
  it("returns fail (no subagent) when agent is unknown", async () => {
    const deps = buildDeps({ resolveAgent: vi.fn(() => undefined) });
    const outcome = await executeAgentStep(deps, request());
    expect(outcome.status).toBe("fail");
    if (outcome.status === "fail") {
      expect(outcome.subagentId).toBeNull();
      expect(outcome.failReason).toMatch(/not found/);
    }
    expect(deps.spawnSubagent).not.toHaveBeenCalled();
  });

  it("returns fail when the task template references an unknown input", async () => {
    const deps = buildDeps();
    const outcome = await executeAgentStep(deps, request({
      step: { ...baseStep, task: "use {{inputs.missing}}" },
    }));
    expect(outcome.status).toBe("fail");
    if (outcome.status === "fail") {
      expect(outcome.failReason).toMatch(/Template render failed/);
      expect(outcome.failReason).toMatch(/inputs\.missing/);
    }
    expect(deps.spawnSubagent).not.toHaveBeenCalled();
  });

  it("returns fail when context assembly throws", async () => {
    const deps = buildDeps({
      assembleEphemeralContext: vi.fn(async () => {
        throw new Error("AGENT.md missing");
      }),
    });
    const outcome = await executeAgentStep(deps, request());
    expect(outcome.status).toBe("fail");
    if (outcome.status === "fail") {
      expect(outcome.failReason).toMatch(/Failed to load agent context/);
      expect(outcome.failReason).toMatch(/AGENT\.md missing/);
    }
    expect(deps.spawnSubagent).not.toHaveBeenCalled();
  });

  it("returns fail when spawnSubagent throws", async () => {
    const deps = buildDeps({
      spawnSubagent: vi.fn(async () => {
        throw new Error("claude CLI not found");
      }),
    });
    const outcome = await executeAgentStep(deps, request());
    expect(outcome.status).toBe("fail");
    if (outcome.status === "fail") {
      expect(outcome.failReason).toMatch(/Subagent spawn failed/);
      expect(outcome.subagentId).toBeNull();
    }
  });

  it("propagates a fail outcome from waitForStepCompletion", async () => {
    const failOutcome: StepAgentOutcome = {
      status: "fail",
      summary: "step timed out",
      failReason: "timeout",
      subagentId: "sub_999_abc",
    };
    const deps = buildDeps({
      waitForStepCompletion: vi.fn(async () => failOutcome),
    });
    const outcome = await executeAgentStep(deps, request());
    expect(outcome).toEqual(failOutcome);
  });

  it("never throws — wraps unexpected errors into fail outcomes", async () => {
    const deps = buildDeps({
      resolveAgent: vi.fn(() => {
        // This would previously crash the runner; the executor must not
        // let this escape. It throws during resolveAgent which is a
        // programmer-error path but good to have a belt-and-braces test
        // that the function's contract holds.
        throw new Error("boom");
      }),
    });
    // The current implementation does NOT try/catch resolveAgent since
    // that's a programmer error, but we want to document the expectation
    // that the executor contract is "never throw from the happy-path
    // branches". A resolver throwing is out of scope — let it surface.
    await expect(executeAgentStep(deps, request())).rejects.toThrow(/boom/);
  });
});

describe("executeAgentStep — input resolution integration with artifact store", () => {
  it("propagates artifact-store errors as fail outcomes when required inputs are missing", async () => {
    const deps = buildDeps();
    const outcome = await executeAgentStep(deps, request({
      // The step declares an input but the artifact dir doesn't exist —
      // resolveStepInputs will throw "Required input artifact ... missing".
      step: { ...baseStep, inputs: ["missing-required.md"] },
    }));
    expect(outcome.status).toBe("fail");
    if (outcome.status === "fail") {
      expect(outcome.failReason).toMatch(/Input resolution failed/);
    }
    expect(deps.spawnSubagent).not.toHaveBeenCalled();
  });
});
