/**
 * Integration tests for WorkflowRunner driven through WorkflowManager.startRun.
 *
 * Strategy:
 *   - Real filesystem under `withTmpRondel()` so persistence, artifact
 *     imports, and crash-recovery paths exercise real disk I/O.
 *   - Mocked `spawnSubagent` — returns a deterministic SubagentInfo.
 *     The test drives step completion by calling `notifyStepComplete`
 *     directly on the manager (same entry point the bridge would use).
 *   - Mocked `resolveAgent` / `assembleEphemeralContext` — no real agent
 *     directories needed.
 *   - Real `createHooks()` so tests can subscribe to `workflow:*` events
 *     and assert on the lifecycle sequence.
 *
 * Scenarios:
 *   1. Linear happy path: agent → agent (both ok) → completed
 *   2. Gate approved: agent → gate → agent → completed
 *   3. Gate denied: agent → gate → failed
 *   4. Retry with remediation: dev fails once, remediation runs on attempt 2,
 *      dev/qa succeed → completed
 *   5. Retry exhausted: qa fails every attempt → failed
 *   6. Crash recovery: start run, reach a gate, restart a new manager on the
 *      same state dir → run marked interrupted.
 */

import { describe, it, expect } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { WorkflowManager } from "./workflow-manager.js";
import { withTmpRondel } from "../../../../tests/helpers/tmp.js";
import { createCapturingLogger } from "../../../../tests/helpers/logger.js";
import { createHooks, type RondelHooks } from "../shared/hooks.js";
import type {
  WorkflowDefinition,
  SubagentSpawnRequest,
  SubagentInfo,
  StepCompleteInput,
  WorkflowOriginator,
} from "../shared/types/index.js";
import type { ResolvedAgent } from "./step-agent.js";

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

interface RecordedEvent {
  readonly event: string;
  readonly payload: unknown;
}

function captureWorkflowEvents(hooks: RondelHooks): RecordedEvent[] {
  const records: RecordedEvent[] = [];
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

interface Harness {
  readonly manager: WorkflowManager;
  readonly hooks: RondelHooks;
  readonly events: RecordedEvent[];
  readonly channelCalls: Array<{ agent: string; channelType: string; accountId: string; chatId: string; text: string }>;
  readonly spawnCalls: SubagentSpawnRequest[];
  readonly workflows: Map<string, WorkflowDefinition>;
  /** Set a canned ok outcome for the next step completion under this (runId, stepKey). */
  autoComplete(runId: string, stepKey: string, outcome: { status: "ok" | "fail"; artifact?: string; summary?: string; failReason?: string }): void;
}

function buildHarness(stateDir: string): Harness {
  const hooks = createHooks();
  const events = captureWorkflowEvents(hooks);
  const logger = createCapturingLogger();
  const channelCalls: Harness["channelCalls"] = [];
  const spawnCalls: SubagentSpawnRequest[] = [];
  const workflows = new Map<string, WorkflowDefinition>();

  // Auto-completion map: (runId::stepKey) → outcome
  const autoOutcomes = new Map<string, { status: "ok" | "fail"; artifact?: string; summary?: string; failReason?: string }>();

  // Mock ResolvedAgent — the runner hands this to executeAgentStep which
  // passes agentDir into assembleEphemeralContext and model/tools into the
  // spawn request.
  const resolveAgent = (name: string): ResolvedAgent => ({
    agentDir: `/tmp/mock-agents/${name}`,
    model: "sonnet",
    workingDirectory: null,
  });

  const manager: WorkflowManager = new WorkflowManager({
    stateDir,
    hooks,
    log: logger,
    sendToChannel: (agent, channelType, accountId, chatId, text) => {
      channelCalls.push({ agent, channelType, accountId, chatId, text });
    },
    resolveAgent,
    assembleEphemeralContext: async () => "# mock agent context",
    spawnSubagent: async (req: SubagentSpawnRequest): Promise<SubagentInfo> => {
      spawnCalls.push(req);
      const subagentId = `sub_${spawnCalls.length}_mock00`;
      const info: SubagentInfo = {
        id: subagentId,
        parentAgentName: req.parentAgentName,
        parentChannelType: req.parentChannelType,
        parentAccountId: req.parentAccountId,
        parentChatId: req.parentChatId,
        task: req.task,
        state: "running",
        startedAt: new Date().toISOString(),
      };
      // Schedule step-complete as a macrotask (setTimeout) so it fires
      // AFTER the runner's microtask chain reaches waitForStepCompletion
      // and registers the pending entry. Using queueMicrotask here would
      // run the notification before the registration — the real bridge
      // HTTP round-trip is always a macrotask (network I/O), so modeling
      // it this way matches production ordering.
      const key = `${req.workflowRunId}::${req.workflowStepKey}`;
      const outcome = autoOutcomes.get(key);
      if (outcome) {
        autoOutcomes.delete(key);
        setTimeout(() => {
          const input: StepCompleteInput = {
            runId: req.workflowRunId!,
            stepKey: req.workflowStepKey!,
            status: outcome.status,
            summary: outcome.summary ?? (outcome.status === "ok" ? "done" : "failed"),
            artifact: outcome.artifact,
            failReason: outcome.failReason,
          };
          manager.notifyStepComplete(input);
        }, 0);
      }
      return info;
    },
    loadWorkflow: (id: string) => workflows.get(id),
  });

  return {
    manager,
    hooks,
    events,
    channelCalls,
    spawnCalls,
    workflows,
    autoComplete(runId, stepKey, outcome) {
      autoOutcomes.set(`${runId}::${stepKey}`, outcome);
    },
  };
}

const originator: WorkflowOriginator = {
  agent: "pm",
  channelType: "telegram",
  accountId: "pm-bot",
  chatId: "12345",
};

/**
 * Create a tiny "input" file the manager can import into the run's
 * artifact dir at start time. Returns the absolute path.
 */
function makeInputFile(tmpDir: string, name: string, content: string): string {
  const path = join(tmpDir, name);
  writeFileSync(path, content, "utf-8");
  return path;
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

describe("WorkflowRunner — linear happy path", () => {
  it("runs two sequential agent steps and completes", async () => {
    const tmp = withTmpRondel();
    const h = buildHarness(tmp.stateDir);

    const definition: WorkflowDefinition = {
      id: "linear",
      version: 1,
      inputs: {},
      steps: [
        { id: "a", kind: "agent", agent: "architect", task: "plan it", output: "plan.md" },
        { id: "b", kind: "agent", agent: "architect", task: "refine {{artifacts.plan.md}}", output: "plan-v2.md" },
      ],
    };
    h.workflows.set("linear", definition);

    // Prime step outcomes BEFORE startRun because the runner races to spawn.
    // We don't know the runId yet — but we can set them after start, since
    // the auto-complete lookup happens at spawn time (when runId is known).

    const handle = await h.manager.startRun(originator, "linear", {});
    h.autoComplete(handle.runId, "a", { status: "ok", artifact: "plan.md", summary: "planned" });
    h.autoComplete(handle.runId, "b", { status: "ok", artifact: "plan-v2.md", summary: "refined" });

    const final = await handle.completion;
    expect(final.status).toBe("completed");
    expect(final.stepStates["a"]!.status).toBe("completed");
    expect(final.stepStates["b"]!.status).toBe("completed");
    expect(final.stepStates["b"]!.outputArtifact).toBe("plan-v2.md");

    // Hook sequence includes started + two step_started/completed + completed
    const names = h.events.map((e) => e.event);
    expect(names).toContain("workflow:started");
    expect(names).toContain("workflow:completed");
    expect(names.filter((n) => n === "workflow:step_completed")).toHaveLength(2);
  });
});

describe("WorkflowRunner — gates", () => {
  it("continues after an approved gate", async () => {
    const tmp = withTmpRondel();
    const h = buildHarness(tmp.stateDir);

    const definition: WorkflowDefinition = {
      id: "with-gate",
      version: 1,
      inputs: {},
      steps: [
        { id: "a", kind: "agent", agent: "architect", task: "do a", output: "a.md" },
        { id: "gate-it", kind: "gate", prompt: "approve?" },
        { id: "b", kind: "agent", agent: "architect", task: "do b", output: "b.md" },
      ],
    };
    h.workflows.set("with-gate", definition);

    const handle = await h.manager.startRun(originator, "with-gate", {});
    h.autoComplete(handle.runId, "a", { status: "ok", artifact: "a.md" });
    h.autoComplete(handle.runId, "b", { status: "ok", artifact: "b.md" });

    // Poll until the gate record is on disk and the channel message fired.
    // The runner emits workflow:gate_waiting — we can subscribe to that to
    // know exactly when to resolve.
    const gatePromise = new Promise<string>((resolve) => {
      h.hooks.on("workflow:gate_waiting", (payload) => {
        resolve((payload as { gate: { gateId: string } }).gate.gateId);
      });
    });
    const gateId = await gatePromise;
    await h.manager.resolveGate(handle.runId, gateId, {
      decision: "approved",
      decidedBy: "telegram:99",
      note: null,
    });

    const final = await handle.completion;
    expect(final.status).toBe("completed");
    expect(final.stepStates["gate-it"]!.status).toBe("completed");
    expect(final.stepStates["b"]!.status).toBe("completed");
  });

  it("fails the run when a gate is denied", async () => {
    const tmp = withTmpRondel();
    const h = buildHarness(tmp.stateDir);

    const definition: WorkflowDefinition = {
      id: "denied-gate",
      version: 1,
      inputs: {},
      steps: [
        { id: "a", kind: "agent", agent: "architect", task: "do a" },
        { id: "gate-it", kind: "gate", prompt: "approve?" },
        { id: "b", kind: "agent", agent: "architect", task: "do b" },
      ],
    };
    h.workflows.set("denied-gate", definition);

    const handle = await h.manager.startRun(originator, "denied-gate", {});
    h.autoComplete(handle.runId, "a", { status: "ok" });

    const gatePromise = new Promise<string>((resolve) => {
      h.hooks.on("workflow:gate_waiting", (payload) => {
        resolve((payload as { gate: { gateId: string } }).gate.gateId);
      });
    });
    const gateId = await gatePromise;
    await h.manager.resolveGate(handle.runId, gateId, {
      decision: "denied",
      decidedBy: "telegram:99",
      note: "too risky",
    });

    const final = await handle.completion;
    expect(final.status).toBe("failed");
    expect(final.stepStates["gate-it"]!.status).toBe("failed");
    // Step b never ran
    expect(final.stepStates["b"]).toBeUndefined();
  });
});

describe("WorkflowRunner — retry block", () => {
  it("loops on failure and succeeds when the target step reports ok", async () => {
    const tmp = withTmpRondel();
    const h = buildHarness(tmp.stateDir);

    const definition: WorkflowDefinition = {
      id: "retry-success",
      version: 1,
      inputs: {},
      steps: [
        {
          id: "loop",
          kind: "retry",
          maxAttempts: 3,
          succeedsWhen: { stepId: "qa", statusIs: "ok" },
          body: [
            {
              id: "remediation",
              kind: "agent",
              when: "on-retry",
              agent: "architect",
              task: "remediate",
              output: "remediation.md",
            },
            { id: "dev", kind: "agent", agent: "dev", task: "build" },
            { id: "qa", kind: "agent", agent: "qa", task: "test" },
          ],
        },
      ],
    };
    h.workflows.set("retry-success", definition);

    const handle = await h.manager.startRun(originator, "retry-success", {});

    // Attempt 1: remediation skipped (when: on-retry), dev ok, qa FAIL
    h.autoComplete(handle.runId, "loop/attempt:1/dev", { status: "ok" });
    h.autoComplete(handle.runId, "loop/attempt:1/qa", { status: "fail", failReason: "tests red" });

    // Attempt 2: remediation runs, dev ok, qa OK
    h.autoComplete(handle.runId, "loop/attempt:2/remediation", { status: "ok", artifact: "remediation.md" });
    h.autoComplete(handle.runId, "loop/attempt:2/dev", { status: "ok" });
    h.autoComplete(handle.runId, "loop/attempt:2/qa", { status: "ok" });

    const final = await handle.completion;
    expect(final.status).toBe("completed");
    expect(final.stepStates["loop"]!.status).toBe("completed");

    // Attempt 1 remediation was skipped
    expect(final.stepStates["loop/attempt:1/remediation"]!.status).toBe("skipped");
    // Attempt 1 qa failed
    expect(final.stepStates["loop/attempt:1/qa"]!.status).toBe("failed");
    // Attempt 2 everything succeeded
    expect(final.stepStates["loop/attempt:2/remediation"]!.status).toBe("completed");
    expect(final.stepStates["loop/attempt:2/qa"]!.status).toBe("completed");
  });

  it("fails the run when maxAttempts is exhausted", async () => {
    const tmp = withTmpRondel();
    const h = buildHarness(tmp.stateDir);

    const definition: WorkflowDefinition = {
      id: "retry-exhaust",
      version: 1,
      inputs: {},
      steps: [
        {
          id: "loop",
          kind: "retry",
          maxAttempts: 2,
          succeedsWhen: { stepId: "qa", statusIs: "ok" },
          body: [
            { id: "dev", kind: "agent", agent: "dev", task: "build" },
            { id: "qa", kind: "agent", agent: "qa", task: "test" },
          ],
        },
      ],
    };
    h.workflows.set("retry-exhaust", definition);

    const handle = await h.manager.startRun(originator, "retry-exhaust", {});

    // Both attempts fail qa
    h.autoComplete(handle.runId, "loop/attempt:1/dev", { status: "ok" });
    h.autoComplete(handle.runId, "loop/attempt:1/qa", { status: "fail" });
    h.autoComplete(handle.runId, "loop/attempt:2/dev", { status: "ok" });
    h.autoComplete(handle.runId, "loop/attempt:2/qa", { status: "fail" });

    const final = await handle.completion;
    expect(final.status).toBe("failed");
    expect(final.stepStates["loop"]!.status).toBe("failed");
    expect(final.stepStates["loop"]!.failReason).toMatch(/exhausted 2 attempts/);
  });
});

describe("WorkflowRunner — declared inputs", () => {
  it("imports an input file and makes it available to the first step", async () => {
    const tmp = withTmpRondel();
    const h = buildHarness(tmp.stateDir);

    const srcFile = makeInputFile(tmp.stateDir, "source-prd.md", "# PRD\n");

    const definition: WorkflowDefinition = {
      id: "with-input",
      version: 1,
      inputs: {
        prd: { kind: "artifact", required: true },
      },
      steps: [
        {
          id: "architecture",
          kind: "agent",
          agent: "architect",
          task: "read {{inputs.prd}}",
          inputs: ["prd"],
          output: "dev-plan.md",
        },
      ],
    };
    h.workflows.set("with-input", definition);

    const handle = await h.manager.startRun(originator, "with-input", { prd: srcFile });
    h.autoComplete(handle.runId, "architecture", { status: "ok", artifact: "dev-plan.md" });

    const final = await handle.completion;
    expect(final.status).toBe("completed");

    // The rendered task on the spawn call should include the input name
    expect(h.spawnCalls[0]!.task).toContain("read prd");
  });

  it("rejects startRun when a required input is missing", async () => {
    const tmp = withTmpRondel();
    const h = buildHarness(tmp.stateDir);

    h.workflows.set("needs-prd", {
      id: "needs-prd",
      version: 1,
      inputs: { prd: { kind: "artifact", required: true } },
      steps: [{ id: "a", kind: "agent", agent: "x", task: "t" }],
    });

    await expect(h.manager.startRun(originator, "needs-prd", {})).rejects.toThrow(
      /requires input "prd"/,
    );
  });
});

describe("WorkflowManager.initialize — crash recovery", () => {
  it("marks a running run as interrupted on restart", async () => {
    const tmp = withTmpRondel();
    const h1 = buildHarness(tmp.stateDir);

    const definition: WorkflowDefinition = {
      id: "slow",
      version: 1,
      inputs: {},
      steps: [{ id: "a", kind: "agent", agent: "architect", task: "t" }],
    };
    h1.workflows.set("slow", definition);

    // Start but never complete step "a" — the runner is stuck awaiting.
    const handle = await h1.manager.startRun(originator, "slow", {});

    // Wait briefly so the runner persists the running state.
    await new Promise((r) => setTimeout(r, 50));

    // Simulate daemon restart: new manager on the same state dir.
    const h2 = buildHarness(tmp.stateDir);
    h2.workflows.set("slow", definition);
    await h2.manager.initialize();

    // The run should now be marked interrupted on disk. Read it via h2.
    // Simplest assertion: look for the workflow:interrupted event emitted
    // by the recovery scan.
    const interruptedEvents = h2.events.filter((e) => e.event === "workflow:interrupted");
    expect(interruptedEvents).toHaveLength(1);
    expect((interruptedEvents[0]!.payload as { runId: string }).runId).toBe(handle.runId);

    // The first manager's runner is still waiting — tell it to shut down
    // so the test process can exit cleanly.
    h1.manager.shutdown();
  });
});
