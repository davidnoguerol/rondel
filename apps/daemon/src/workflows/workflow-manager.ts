/**
 * WorkflowManager — top-level DI entry point for the workflow engine.
 *
 * Owns:
 *   - The in-memory pending-gate registry (gate id → resolver function).
 *   - The resolveGate entry point called by the bridge HTTP handler when
 *     `rondel_resolve_gate` fires.
 *   - (Follow-up commit 5) startRun, step dispatch, crash recovery.
 *
 * v0 scope:
 *   This commit wires the gate side only. Commit 5 adds run creation,
 *   the execution loop, and crash-recovery on initialize(). Keeping the
 *   manager's surface narrow in each commit lets tests cover one concern
 *   at a time.
 *
 * The manager takes deps in its constructor — no module-level singletons,
 * no direct imports of concrete subsystems — so a test can spin up a fake
 * manager against `withTmpRondel()` plus recording hooks.
 */

import { randomBytes } from "node:crypto";
import type {
  GateRecord,
  WorkflowOriginator,
  WorkflowGateResolvedEvent,
  WorkflowDefinition,
  WorkflowRunState,
  StepCompleteInput,
} from "../shared/types/index.js";
import type {
  RondelHooks,
  SubagentCompletedEvent,
  SubagentFailedEvent,
} from "../shared/hooks.js";
import type { Logger } from "../shared/logger.js";
import {
  readGateRecord,
  writeGateRecord,
  writeRunState,
  writeDefinitionSnapshot,
  ensureRunDirectories,
} from "./workflow-storage.js";
import type { GateResolution } from "./step-gate.js";
import { importArtifact } from "./artifact-store.js";
import { WorkflowRunner, type WorkflowRunnerDeps } from "./workflow-runner.js";
import { recoverInterruptedRuns } from "./workflow-crash-recovery.js";
import type { StepAgentOutcome, AgentResolver } from "./step-agent.js";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class GateResolutionError extends Error {
  readonly code: "not_found" | "already_resolved" | "invalid_decision";
  constructor(code: "not_found" | "already_resolved" | "invalid_decision", message: string) {
    super(message);
    this.name = "GateResolutionError";
    this.code = code;
  }
}

export class WorkflowStartError extends Error {
  readonly code: "unknown_workflow" | "missing_input" | "invalid_input";
  constructor(code: "unknown_workflow" | "missing_input" | "invalid_input", message: string) {
    super(message);
    this.name = "WorkflowStartError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export interface WorkflowManagerDeps {
  readonly stateDir: string;
  readonly hooks: RondelHooks;
  readonly log: Logger;
  /**
   * Deliver a text message to an agent's conversation. Abstracts
   * Router.sendOrQueue so tests don't need a real router. `accountId`
   * pins delivery to the originating channel account for multi-account
   * channels (see Router.sendOrQueue for details).
   */
  readonly sendToChannel: (
    agent: string,
    channelType: string,
    accountId: string,
    chatId: string,
    text: string,
  ) => void;
  /** Look up a registered agent template by name. */
  readonly resolveAgent: AgentResolver;
  /** Load ephemeral system prompt for a given agent directory. */
  readonly assembleEphemeralContext: (agentDir: string) => Promise<string>;
  /** Spawn a subagent (real or mocked). */
  readonly spawnSubagent: WorkflowRunnerDeps["spawnSubagent"];
  /** Look up a workflow definition by id. */
  readonly loadWorkflow: (workflowId: string) => WorkflowDefinition | undefined;
  /** Current time — injected so tests can freeze it. */
  readonly now?: () => Date;
}

// ---------------------------------------------------------------------------
// Pending gate registry
// ---------------------------------------------------------------------------

interface PendingGateEntry {
  readonly runId: string;
  readonly resolve: (resolution: GateResolution) => void;
}

interface PendingStepEntry {
  readonly runId: string;
  readonly stepKey: string;
  readonly subagentId: string;
  readonly resolve: (outcome: StepAgentOutcome) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/**
 * Handle returned by `startRun`. `completion` resolves when the runner
 * finishes (completed or failed). Tests await it; production MCP callers
 * ignore it — the run proceeds asynchronously in the background.
 */
export interface StartRunHandle {
  readonly runId: string;
  readonly completion: Promise<WorkflowRunState>;
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export class WorkflowManager {
  private readonly pendingGates = new Map<string, PendingGateEntry>();
  private readonly pendingStepsByKey = new Map<string, PendingStepEntry>();
  private readonly pendingStepsBySubagentId = new Map<string, PendingStepEntry>();
  private readonly log: Logger;
  private readonly now: () => Date;

  constructor(private readonly deps: WorkflowManagerDeps) {
    this.log = deps.log.child("workflows");
    this.now = deps.now ?? (() => new Date());
    this.wireSubagentExitFallback();
  }

  // -------------------------------------------------------------------------
  // Gate registry (used by step-gate via dependency injection)
  // -------------------------------------------------------------------------

  /**
   * Register a pending gate and return a promise that resolves when
   * `resolveGate` fires for the same gate id.
   *
   * Called by the step-gate executor just before it notifies the human.
   * Registration must happen BEFORE the notification is sent so there's
   * no race where the user resolves instantly and we have nothing to
   * resolve.
   *
   * Only one waiter per gate id. Re-registering overwrites the previous
   * resolver (and logs a warning) — this only happens on a programmer
   * error, not in normal flow.
   */
  registerPendingGate(runId: string, gateId: string): Promise<GateResolution> {
    return new Promise<GateResolution>((resolve) => {
      if (this.pendingGates.has(gateId)) {
        this.log.warn(`Overwriting pending gate ${gateId} — prior waiter abandoned`);
      }
      this.pendingGates.set(gateId, { runId, resolve });
    });
  }

  /**
   * Drop a pending gate from the registry without resolving it. Used on
   * shutdown or when a run is abandoned for reasons outside the normal
   * resolution flow.
   */
  forgetPendingGate(gateId: string): void {
    this.pendingGates.delete(gateId);
  }

  /** Whether a gate is currently being awaited in memory. */
  hasPendingGate(gateId: string): boolean {
    return this.pendingGates.has(gateId);
  }

  // -------------------------------------------------------------------------
  // Resolve path (called by the bridge HTTP handler in commit 7)
  // -------------------------------------------------------------------------

  /**
   * Record a human decision on a gate and unblock any in-memory waiter.
   *
   * Flow:
   *   1. Load the pending record from disk.
   *   2. If already resolved → reject (409).
   *   3. Write the resolved record atomically.
   *   4. Emit `workflow:gate_resolved` so the ledger picks it up.
   *   5. If a pending waiter is in memory, resolve its promise.
   *   6. Return the resolved record for the caller (bridge returns JSON).
   *
   * Crash safety: the resolved record is persisted BEFORE the waiter is
   * unblocked, so if the daemon dies between steps 3 and 5 the run can
   * be rehydrated on next startup and the runner will see the resolved
   * gate on disk when it re-reaches that step.
   */
  async resolveGate(
    runId: string,
    gateId: string,
    input: {
      readonly decision: "approved" | "denied";
      readonly decidedBy: string;
      readonly note: string | null;
    },
  ): Promise<GateRecord> {
    const pending = await readGateRecord(this.deps.stateDir, runId, gateId);
    if (!pending) {
      throw new GateResolutionError("not_found", `No gate ${gateId} for run ${runId}`);
    }
    if (pending.status === "resolved") {
      throw new GateResolutionError("already_resolved", `Gate ${gateId} is already resolved`);
    }

    const decidedAt = new Date().toISOString();
    const resolved: GateRecord = {
      ...pending,
      status: "resolved",
      resolvedAt: decidedAt,
      decision: input.decision,
      decidedBy: input.decidedBy,
      note: input.note,
    };

    await writeGateRecord(this.deps.stateDir, resolved);

    // The originator on the hook is reconstructed from the gate record —
    // the ledger wants to key the event back to the conversation that
    // opened the gate, which is exactly what we stored.
    const originator: WorkflowOriginator = {
      agent: pending.notifiedAgent,
      channelType: pending.notifiedChannelType,
      accountId: pending.notifiedAccountId,
      chatId: pending.notifiedChatId,
    };

    const event: WorkflowGateResolvedEvent = {
      runId,
      originator,
      gate: resolved,
    };
    this.deps.hooks.emit("workflow:gate_resolved", event);

    // Unblock any in-memory waiter. Crash-recovery note: if the waiter is
    // gone (daemon restarted), the runner will read the resolved record
    // on resume and skip the wait entirely — no double-execution risk.
    const entry = this.pendingGates.get(gateId);
    if (entry) {
      this.pendingGates.delete(gateId);
      entry.resolve({
        decision: input.decision,
        decidedBy: input.decidedBy,
        note: input.note,
        decidedAt,
      });
    } else {
      this.log.debug(
        `Gate ${gateId} resolved with no in-memory waiter — recovery on next runner tick`,
      );
    }

    return resolved;
  }

  // -------------------------------------------------------------------------
  // Pending-step registry (agent steps)
  // -------------------------------------------------------------------------

  /**
   * Register a pending AgentStep. Called by the runner via DI when it
   * dispatches to executeAgentStep.
   *
   * Resolution paths (first to fire wins):
   *   1. `notifyStepComplete` — bridge handler when the step agent POSTs
   *      `rondel_step_complete`.
   *   2. Subagent exit hook — the subagent process finished without
   *      calling the tool. Treated as an implicit fail.
   *   3. Timer — the step's declared timeoutMs elapsed. Also a fail.
   *
   * Keyed by both (runId, stepKey) and subagentId so either signal can
   * look it up in O(1). Entries are removed from both indices on resolve.
   */
  private readonly registerPendingStep: WorkflowRunnerDeps["registerPendingStep"] = (args) => {
    const compositeKey = `${args.runId}::${args.stepKey}`;
    return new Promise<StepAgentOutcome>((resolve) => {
      let entry: PendingStepEntry;
      const resolver = (outcome: StepAgentOutcome): void => {
        if (!this.pendingStepsByKey.has(compositeKey)) return; // already resolved
        this.pendingStepsByKey.delete(compositeKey);
        this.pendingStepsBySubagentId.delete(args.subagentId);
        clearTimeout(entry.timer);
        resolve(outcome);
      };
      const timer = setTimeout(() => {
        resolver({
          status: "fail",
          summary: "Step timed out",
          failReason: `Step timed out after ${args.timeoutMs}ms`,
          subagentId: args.subagentId,
        });
      }, args.timeoutMs);
      entry = {
        runId: args.runId,
        stepKey: args.stepKey,
        subagentId: args.subagentId,
        resolve: resolver,
        timer,
      };
      this.pendingStepsByKey.set(compositeKey, entry);
      this.pendingStepsBySubagentId.set(args.subagentId, entry);
    });
  };

  /**
   * Bridge entry point: called by the HTTP handler when a step agent POSTs
   * `rondel_step_complete`. Finds the pending entry by (runId, stepKey)
   * and resolves it.
   */
  notifyStepComplete(input: StepCompleteInput): void {
    const compositeKey = `${input.runId}::${input.stepKey}`;
    const entry = this.pendingStepsByKey.get(compositeKey);
    if (!entry) {
      this.log.warn(
        `notifyStepComplete: no pending step for ${compositeKey} — ignoring`,
      );
      return;
    }
    if (input.status === "ok") {
      entry.resolve({
        status: "ok",
        summary: input.summary,
        outputArtifact: input.artifact ?? null,
        subagentId: entry.subagentId,
      });
    } else {
      entry.resolve({
        status: "fail",
        summary: input.summary,
        failReason: input.failReason ?? "step reported fail",
        subagentId: entry.subagentId,
      });
    }
  }

  /**
   * Wire the subagent-exit fallback. If a subagent spawned for a workflow
   * step exits (completed or failed) without calling `rondel_step_complete`,
   * we resolve the pending entry with an implicit fail so the runner
   * doesn't hang forever.
   *
   * Idempotent vs notifyStepComplete: whichever signal fires first removes
   * the pending entry; subsequent signals are no-ops.
   */
  private wireSubagentExitFallback(): void {
    const handle = (subagentId: string, state: "completed" | "failed", error?: string): void => {
      const entry = this.pendingStepsBySubagentId.get(subagentId);
      if (!entry) return; // not one of ours, or already resolved
      entry.resolve({
        status: "fail",
        summary: "Step ended without calling rondel_step_complete",
        failReason:
          error ??
          `Subagent ${subagentId} exited (${state}) without calling rondel_step_complete`,
        subagentId,
      });
    };
    this.deps.hooks.on("subagent:completed", (event: SubagentCompletedEvent) => {
      handle(event.info.id, "completed");
    });
    this.deps.hooks.on("subagent:failed", (event: SubagentFailedEvent) => {
      handle(event.info.id, "failed", event.info.error);
    });
  }

  // -------------------------------------------------------------------------
  // startRun
  // -------------------------------------------------------------------------

  /**
   * Start a new workflow run.
   *
   *   1. Look up the workflow definition.
   *   2. Validate declared inputs are present (required ones only).
   *   3. Generate a runId and create state/workflows/{runId}/ dirs.
   *   4. Import each declared input file into the run's artifacts dir.
   *      Input keys become the artifact names (so `{{inputs.prd}}` and
   *      `{{artifacts.prd}}` both resolve correctly — the artifact name
   *      equals the input key for declared inputs).
   *   5. Snapshot the definition alongside the run.
   *   6. Write initial run state (status: "pending").
   *   7. Construct a WorkflowRunner and kick it off in the background.
   *
   * Returns { runId, completion } — the caller typically awaits just the
   * runId for the MCP tool response; tests await completion for assertions.
   */
  async startRun(
    originator: WorkflowOriginator,
    workflowId: string,
    inputs: Readonly<Record<string, string>>,
  ): Promise<StartRunHandle> {
    const definition = this.deps.loadWorkflow(workflowId);
    if (!definition) {
      throw new WorkflowStartError(
        "unknown_workflow",
        `Unknown workflow id "${workflowId}"`,
      );
    }

    // Validate required inputs are present.
    for (const [name, spec] of Object.entries(definition.inputs)) {
      if (spec.required && !(name in inputs)) {
        throw new WorkflowStartError(
          "missing_input",
          `Workflow "${workflowId}" requires input "${name}"`,
        );
      }
    }

    const runId = `run_${this.now().getTime()}_${randomBytes(3).toString("hex")}`;
    await ensureRunDirectories(this.deps.stateDir, runId);

    // Import each declared input file. The input name becomes the
    // artifact filename — this keeps the template API dead simple
    // (`{{inputs.prd}}` renders to "prd" which is the file's name in
    // the artifacts dir).
    const inputArtifactMap: Record<string, string> = {};
    for (const [name, sourcePath] of Object.entries(inputs)) {
      try {
        await importArtifact(this.deps.stateDir, runId, sourcePath, name);
        inputArtifactMap[name] = name;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new WorkflowStartError(
          "invalid_input",
          `Failed to import input "${name}" from ${sourcePath}: ${msg}`,
        );
      }
    }

    // Freeze the definition for this run.
    await writeDefinitionSnapshot(this.deps.stateDir, runId, definition);

    const nowStr = this.now().toISOString();
    const initialState: WorkflowRunState = {
      runId,
      workflowId,
      workflowVersion: definition.version,
      status: "pending",
      startedAt: nowStr,
      updatedAt: nowStr,
      completedAt: null,
      originator,
      inputs: inputArtifactMap,
      currentStepKey: null,
      stepStates: {},
      failReason: null,
    };
    await writeRunState(this.deps.stateDir, initialState);

    const runner = new WorkflowRunner(
      {
        stateDir: this.deps.stateDir,
        hooks: this.deps.hooks,
        log: this.log,
        now: this.now,
        resolveAgent: this.deps.resolveAgent,
        assembleEphemeralContext: this.deps.assembleEphemeralContext,
        spawnSubagent: this.deps.spawnSubagent,
        sendToChannel: this.deps.sendToChannel,
        registerPendingStep: this.registerPendingStep,
        registerPendingGate: (rid, gid) => this.registerPendingGate(rid, gid),
      },
      definition,
      initialState,
    );

    // Kick off in background — callers can await `completion` if they
    // want the final state, or return immediately if they don't.
    const completion = runner.run();
    return { runId, completion };
  }

  // -------------------------------------------------------------------------
  // initialize + shutdown
  // -------------------------------------------------------------------------

  /**
   * Called from apps/daemon/src/index.ts at startup. Scans state/workflows/
   * and marks any non-terminal run as `interrupted`. v0 does not auto-resume
   * — see the WorkflowCrashRecovery rationale in workflow-crash-recovery.ts.
   */
  async initialize(): Promise<void> {
    const result = await recoverInterruptedRuns({
      stateDir: this.deps.stateDir,
      hooks: this.deps.hooks,
      log: this.log,
      now: this.now,
    });
    if (result.interrupted > 0) {
      this.log.warn(
        `Crash recovery: ${result.interrupted}/${result.scanned} runs marked interrupted (${result.interruptedIds.join(", ")})`,
      );
    } else {
      this.log.info(`Crash recovery: ${result.scanned} runs scanned, none interrupted`);
    }
  }

  /**
   * Shutdown hook. Drops all pending gate/step waiters so Node can exit
   * cleanly. Does NOT resolve them — intentional: if the daemon is
   * shutting down, the waiters are going away with the process, and any
   * resolution would be lost anyway.
   */
  shutdown(): void {
    this.pendingGates.clear();
    for (const entry of this.pendingStepsByKey.values()) {
      clearTimeout(entry.timer);
    }
    this.pendingStepsByKey.clear();
    this.pendingStepsBySubagentId.clear();
  }
}
