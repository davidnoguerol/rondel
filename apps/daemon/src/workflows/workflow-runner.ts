/**
 * WorkflowRunner — per-run execution loop.
 *
 * Walks `definition.steps` linearly, dispatches each step to the right
 * executor (agent / gate / retry), persists state transitions, and emits
 * lifecycle hooks. Retry blocks recurse into the same runStep entry point
 * so nested retries work automatically if ever added.
 *
 * Invariants:
 *   - Every state transition is persisted to disk BEFORE the corresponding
 *     hook fires. Listeners always see on-disk-consistent state.
 *   - `run()` never throws. Unexpected errors become a terminal `failed`
 *     state so callers can always depend on a completion signal.
 *   - Failing steps at the top level fail the whole run. Failing steps
 *     inside a retry block are absorbed by the retry loop.
 *   - Retry bodies run ALL their steps every attempt (no early-exit on
 *     fail), then evaluate `succeedsWhen` at the end of the attempt.
 *     This matches the user's reference scenario: remediation → dev → qa
 *     each attempt, with remediation skipped on attempt 1 via `when: on-retry`.
 */

import type {
  WorkflowDefinition,
  Step,
  AgentStep,
  GateStep,
  RetryStep,
  WorkflowRunState,
  StepRunState,
  GateRecord,
} from "../shared/types/index.js";
import type { RondelHooks } from "../shared/hooks.js";
import type { Logger } from "../shared/logger.js";
import {
  writeRunState,
  writeGateRecord,
} from "./workflow-storage.js";
import {
  shouldRunInAttempt,
  buildRetryStepKey,
  evaluateSucceedsWhen,
} from "./step-retry.js";
import {
  executeAgentStep,
  type AgentStepDeps,
  type AgentResolver,
} from "./step-agent.js";
import {
  executeGateStep,
  type GateResolution,
  defaultGateRandomSuffix,
} from "./step-gate.js";

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface WorkflowRunnerDeps {
  readonly stateDir: string;
  readonly hooks: RondelHooks;
  readonly log: Logger;
  /** Current time — injected for deterministic tests. */
  readonly now: () => Date;
  /** Resolve an agent name to its template/dir/model. */
  readonly resolveAgent: AgentResolver;
  /** Load ephemeral system prompt for a given agent directory. */
  readonly assembleEphemeralContext: (agentDir: string) => Promise<string>;
  /** Spawn a subagent via the (real or mocked) SubagentManager. */
  readonly spawnSubagent: AgentStepDeps["spawnSubagent"];
  /**
   * Send a text message to the originator's channel for gate notifications.
   * `accountId` is required so channels with multiple bound accounts
   * deliver via the correct bot/user pair.
   */
  readonly sendToChannel: (
    agent: string,
    channelType: string,
    accountId: string,
    chatId: string,
    text: string,
  ) => void;
  /**
   * Register a pending AgentStep. Implemented by the WorkflowManager —
   * returns a promise that resolves when either the step agent calls
   * `rondel_step_complete`, the subagent exits without calling it, or
   * the step's timeout fires.
   */
  readonly registerPendingStep: AgentStepDeps["waitForStepCompletion"];
  /**
   * Register a pending GateStep. Implemented by the WorkflowManager —
   * returns a promise that resolves when a human POSTs to
   * /workflows/gates/:id/resolve via `rondel_resolve_gate`.
   */
  readonly registerPendingGate: (runId: string, gateId: string) => Promise<GateResolution>;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

type StepResult = "completed" | "failed" | "skipped";

export class WorkflowRunner {
  private state: WorkflowRunState;
  private templateArtifacts: Record<string, string>;

  constructor(
    private readonly deps: WorkflowRunnerDeps,
    private readonly definition: WorkflowDefinition,
    initialState: WorkflowRunState,
  ) {
    this.state = initialState;
    this.templateArtifacts = {};
    this.seedTemplateArtifacts();
  }

  /** Final state snapshot — safe to read after `run()` resolves. */
  get finalState(): WorkflowRunState {
    return this.state;
  }

  /**
   * Execute the run end-to-end. Always resolves (never rejects) with the
   * final WorkflowRunState. Terminal errors show up as status === "failed"
   * with a populated `failReason`.
   */
  async run(): Promise<WorkflowRunState> {
    this.deps.log.info(
      `Workflow run starting: ${this.state.runId} (${this.state.workflowId})`,
    );

    this.state = {
      ...this.state,
      status: "running",
      updatedAt: this.deps.now().toISOString(),
    };
    await this.persist();
    this.deps.hooks.emit("workflow:started", { run: this.state });

    try {
      for (const step of this.definition.steps) {
        const result = await this.runStep(step, step.id, 1);
        if (result === "failed") {
          return await this.finish("failed", `step "${step.id}" failed`);
        }
      }
      return await this.finish("completed", null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.deps.log.error(`Workflow runner crashed: ${msg}`);
      return await this.finish("failed", `unexpected runner error: ${msg}`);
    }
  }

  // -------------------------------------------------------------------------
  // Dispatch
  // -------------------------------------------------------------------------

  private async runStep(
    step: Step,
    stepKey: string,
    attempt: number,
  ): Promise<StepResult> {
    // `when` filter — may skip the step without running
    if (!shouldRunInAttempt(step, attempt)) {
      const skipped = this.newStepState(step, stepKey, attempt, "skipped");
      this.setStepState(stepKey, skipped);
      await this.persist();
      return "skipped";
    }

    // Mark as running, emit step_started
    const startedAt = this.deps.now().toISOString();
    const running = this.newStepState(step, stepKey, attempt, "running", { startedAt });
    this.setStepState(stepKey, running);
    this.state = { ...this.state, currentStepKey: stepKey };
    await this.persist();
    this.deps.hooks.emit("workflow:step_started", {
      runId: this.state.runId,
      originator: this.state.originator,
      stepState: running,
    });

    switch (step.kind) {
      case "agent":
        return this.runAgentStep(step, stepKey, attempt);
      case "gate":
        return this.runGateStep(step, stepKey, attempt);
      case "retry":
        return this.runRetryStep(step, stepKey);
    }
  }

  // -------------------------------------------------------------------------
  // Agent step
  // -------------------------------------------------------------------------

  private async runAgentStep(
    step: AgentStep,
    stepKey: string,
    attempt: number,
  ): Promise<StepResult> {
    const outcome = await executeAgentStep(
      {
        stateDir: this.deps.stateDir,
        resolveAgent: this.deps.resolveAgent,
        assembleEphemeralContext: this.deps.assembleEphemeralContext,
        spawnSubagent: this.deps.spawnSubagent,
        waitForStepCompletion: this.deps.registerPendingStep,
      },
      {
        runId: this.state.runId,
        stepKey,
        step,
        originator: this.state.originator,
        templateInputs: this.state.inputs,
        templateArtifacts: this.templateArtifacts,
      },
    );

    const completedAt = this.deps.now().toISOString();
    const priorStartedAt = this.state.stepStates[stepKey]?.startedAt ?? null;

    if (outcome.status === "ok") {
      const completed = this.newStepState(step, stepKey, attempt, "completed", {
        startedAt: priorStartedAt,
        completedAt,
        outputArtifact: outcome.outputArtifact,
        summary: outcome.summary,
        subagentId: outcome.subagentId,
      });
      this.setStepState(stepKey, completed);
      if (outcome.outputArtifact) {
        this.templateArtifacts[outcome.outputArtifact] = outcome.outputArtifact;
      }
      await this.persist();
      this.deps.hooks.emit("workflow:step_completed", {
        runId: this.state.runId,
        originator: this.state.originator,
        stepState: completed,
      });
      return "completed";
    }

    const failed = this.newStepState(step, stepKey, attempt, "failed", {
      startedAt: priorStartedAt,
      completedAt,
      failReason: outcome.failReason,
      summary: outcome.summary,
      subagentId: outcome.subagentId,
    });
    this.setStepState(stepKey, failed);
    await this.persist();
    this.deps.hooks.emit("workflow:step_failed", {
      runId: this.state.runId,
      originator: this.state.originator,
      stepState: failed,
    });
    return "failed";
  }

  // -------------------------------------------------------------------------
  // Gate step
  // -------------------------------------------------------------------------

  private async runGateStep(
    step: GateStep,
    stepKey: string,
    attempt: number,
  ): Promise<StepResult> {
    // Move run to waiting-gate before dispatching so a restart picks up
    // the correct status while the gate is outstanding.
    this.state = {
      ...this.state,
      status: "waiting-gate",
      updatedAt: this.deps.now().toISOString(),
    };
    await this.persist();

    const outcome = await executeGateStep(
      {
        now: this.deps.now,
        randomSuffix: defaultGateRandomSuffix,
        writeGate: (record: GateRecord) => writeGateRecord(this.deps.stateDir, record),
        registerPendingGate: this.deps.registerPendingGate,
        sendToChannel: this.deps.sendToChannel,
        hooks: this.deps.hooks,
      },
      {
        runId: this.state.runId,
        stepKey,
        step,
        originator: this.state.originator,
        templateInputs: this.state.inputs,
        templateArtifacts: this.templateArtifacts,
      },
    );

    // Capture the gate-start timestamp before any state mutations so the
    // prior `running` entry's startedAt survives into the terminal entry.
    const completedAt = this.deps.now().toISOString();
    const priorStartedAt = this.state.stepStates[stepKey]?.startedAt ?? null;

    // Flip the run back to `running` atomically with the terminal step
    // state update — a single persist captures both transitions so the
    // "persist before hook" invariant holds. Discriminated switch below
    // narrows each variant independently.
    switch (outcome.status) {
      case "approved": {
        const completed = this.newStepState(step, stepKey, attempt, "completed", {
          startedAt: priorStartedAt,
          completedAt,
          summary: outcome.note ?? "approved",
          gateId: outcome.gateId,
        });
        this.state = { ...this.state, status: "running", updatedAt: completedAt };
        this.setStepState(stepKey, completed);
        await this.persist();
        this.deps.hooks.emit("workflow:step_completed", {
          runId: this.state.runId,
          originator: this.state.originator,
          stepState: completed,
        });
        return "completed";
      }
      case "denied": {
        const reason = `gate denied${outcome.note ? `: ${outcome.note}` : ""}`;
        const failed = this.newStepState(step, stepKey, attempt, "failed", {
          startedAt: priorStartedAt,
          completedAt,
          failReason: reason,
          summary: reason,
          gateId: outcome.gateId,
        });
        this.state = { ...this.state, status: "running", updatedAt: completedAt };
        this.setStepState(stepKey, failed);
        await this.persist();
        this.deps.hooks.emit("workflow:step_failed", {
          runId: this.state.runId,
          originator: this.state.originator,
          stepState: failed,
        });
        return "failed";
      }
      case "failed_to_open": {
        const reason = `gate failed to open: ${outcome.failReason}`;
        const failed = this.newStepState(step, stepKey, attempt, "failed", {
          startedAt: priorStartedAt,
          completedAt,
          failReason: reason,
          summary: reason,
        });
        this.state = { ...this.state, status: "running", updatedAt: completedAt };
        this.setStepState(stepKey, failed);
        await this.persist();
        this.deps.hooks.emit("workflow:step_failed", {
          runId: this.state.runId,
          originator: this.state.originator,
          stepState: failed,
        });
        return "failed";
      }
    }
  }

  // -------------------------------------------------------------------------
  // Retry step
  // -------------------------------------------------------------------------

  private async runRetryStep(
    retry: RetryStep,
    retryKey: string,
  ): Promise<StepResult> {
    for (let attempt = 1; attempt <= retry.maxAttempts; attempt++) {
      for (const innerStep of retry.body) {
        const innerKey = buildRetryStepKey(retry.id, attempt, innerStep.id);
        await this.runStep(innerStep, innerKey, attempt);
      }

      const succeeded = evaluateSucceedsWhen(retry, attempt, this.state.stepStates);
      if (succeeded === true) {
        const completedAt = this.deps.now().toISOString();
        const priorStartedAt = this.state.stepStates[retryKey]?.startedAt ?? null;
        const completed = this.newStepState(retry, retryKey, attempt, "completed", {
          startedAt: priorStartedAt,
          completedAt,
          summary: `succeeded on attempt ${attempt}`,
        });
        this.setStepState(retryKey, completed);
        await this.persist();
        this.deps.hooks.emit("workflow:step_completed", {
          runId: this.state.runId,
          originator: this.state.originator,
          stepState: completed,
        });
        return "completed";
      }
      // false or null — try the next attempt
    }

    // Exhausted
    const completedAt = this.deps.now().toISOString();
    const priorStartedAt = this.state.stepStates[retryKey]?.startedAt ?? null;
    const failed = this.newStepState(retry, retryKey, retry.maxAttempts, "failed", {
      startedAt: priorStartedAt,
      completedAt,
      failReason: `exhausted ${retry.maxAttempts} attempts`,
      summary: `all ${retry.maxAttempts} attempts failed`,
    });
    this.setStepState(retryKey, failed);
    await this.persist();
    this.deps.hooks.emit("workflow:step_failed", {
      runId: this.state.runId,
      originator: this.state.originator,
      stepState: failed,
    });
    return "failed";
  }

  // -------------------------------------------------------------------------
  // Finish + state helpers
  // -------------------------------------------------------------------------

  private async finish(
    status: "completed" | "failed",
    failReason: string | null,
  ): Promise<WorkflowRunState> {
    const now = this.deps.now().toISOString();
    this.state = {
      ...this.state,
      status,
      completedAt: now,
      currentStepKey: null,
      updatedAt: now,
      failReason,
    };
    await this.persist();
    if (status === "completed") {
      this.deps.hooks.emit("workflow:completed", {
        runId: this.state.runId,
        originator: this.state.originator,
        workflowId: this.state.workflowId,
      });
    } else {
      this.deps.hooks.emit("workflow:failed", {
        runId: this.state.runId,
        originator: this.state.originator,
        workflowId: this.state.workflowId,
        reason: failReason ?? "failed",
      });
    }
    this.deps.log.info(
      `Workflow run finished: ${this.state.runId} (${status}${failReason ? `: ${failReason}` : ""})`,
    );
    return this.state;
  }

  private async persist(): Promise<void> {
    await writeRunState(this.deps.stateDir, this.state);
  }

  private setStepState(key: string, state: StepRunState): void {
    this.state = {
      ...this.state,
      stepStates: { ...this.state.stepStates, [key]: state },
      updatedAt: this.deps.now().toISOString(),
    };
  }

  private newStepState(
    step: Step,
    stepKey: string,
    attempt: number,
    status: StepRunState["status"],
    overrides: Partial<StepRunState> = {},
  ): StepRunState {
    return {
      stepKey,
      stepId: step.id,
      kind: step.kind,
      status,
      attempt,
      startedAt: null,
      completedAt: null,
      outputArtifact: null,
      summary: null,
      failReason: null,
      subagentId: null,
      gateId: null,
      ...overrides,
    };
  }

  private seedTemplateArtifacts(): void {
    // Declared inputs — addressable by their artifact name
    for (const [, artifactName] of Object.entries(this.state.inputs)) {
      this.templateArtifacts[artifactName] = artifactName;
    }
    // Plus outputs from any already-completed steps (resume case)
    for (const s of Object.values(this.state.stepStates)) {
      if (s.status === "completed" && s.outputArtifact) {
        this.templateArtifacts[s.outputArtifact] = s.outputArtifact;
      }
    }
  }
}
