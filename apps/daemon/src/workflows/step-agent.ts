/**
 * AgentStep executor.
 *
 * Converts an authored `AgentStep` into a spawned subagent and waits for
 * that subagent to report completion. The module is pure-DI: every
 * external concern (agent resolution, context assembly, subagent spawning,
 * completion waiting) is injected as a function. The real wiring lives in
 * the WorkflowManager (commit 5); this file is unit-testable with trivial
 * mocks.
 *
 * Error handling: any failure between receiving a request and spawning the
 * subagent translates to a `fail` outcome rather than propagating. The
 * runner treats fail outcomes as legitimate business-level failures and
 * persists them to the ledger. An unexpected exception would poison the
 * entire workflow run — `fail` lets the retry-block logic act on it.
 */

import type {
  AgentStep,
  WorkflowOriginator,
  SubagentSpawnRequest,
  SubagentInfo,
} from "../shared/types/index.js";
import { renderTemplate } from "./template-render.js";
import { artifactDirectory } from "./workflow-storage.js";
import { resolveStepInputs } from "./artifact-store.js";

/** Default timeout for an agent step when AgentStep.timeoutMs is omitted. */
export const DEFAULT_AGENT_STEP_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

// ---------------------------------------------------------------------------
// Dependency contracts
// ---------------------------------------------------------------------------

/** Minimal view of an agent's template the executor needs. */
export interface ResolvedAgent {
  readonly agentDir: string;
  readonly model: string;
  readonly workingDirectory: string | null;
  readonly allowedTools?: readonly string[];
  readonly disallowedTools?: readonly string[];
}

/** Look up an agent by name. Undefined if the agent is unknown. */
export type AgentResolver = (agentName: string) => ResolvedAgent | undefined;

/**
 * Deps injected by the workflow manager. Keeping this as a plain interface
 * of functions (not a class) makes unit testing a 3-line mock.
 */
export interface AgentStepDeps {
  readonly stateDir: string;
  /** Look up a workflow-referenced agent. */
  readonly resolveAgent: AgentResolver;
  /**
   * Assemble a system prompt for the given agent directory in ephemeral
   * mode (strips MEMORY.md, USER.md, BOOTSTRAP.md). The manager wires
   * this to `assembleContext(..., { isEphemeral: true })`.
   */
  readonly assembleEphemeralContext: (agentDir: string) => Promise<string>;
  /** Spawn a subagent. Returns immediately with tracking info. */
  readonly spawnSubagent: (req: SubagentSpawnRequest) => Promise<SubagentInfo>;
  /**
   * Wait for the spawned subagent to report completion.
   *
   * Resolution sources (in order of precedence, manager-implemented):
   *   1. Explicit `rondel_step_complete` tool call from the step agent.
   *   2. Fallback: `subagent:completed` hook translated to an implicit
   *      `fail` outcome with reason "step did not call rondel_step_complete".
   *   3. Timeout: resolves as `fail` with reason "step timeout".
   *
   * For unit tests this function is mocked directly — no hook wiring.
   */
  readonly waitForStepCompletion: (args: {
    readonly runId: string;
    readonly stepKey: string;
    readonly subagentId: string;
    readonly timeoutMs: number;
  }) => Promise<StepAgentOutcome>;
}

// ---------------------------------------------------------------------------
// Request & outcome shapes
// ---------------------------------------------------------------------------

export interface ExecuteAgentStepRequest {
  readonly runId: string;
  readonly stepKey: string;
  readonly step: AgentStep;
  readonly originator: WorkflowOriginator;
  /** Variables available via `{{inputs.x}}` in the task template. */
  readonly templateInputs: Readonly<Record<string, string>>;
  /** Variables available via `{{artifacts.x}}` in the task template. */
  readonly templateArtifacts: Readonly<Record<string, string>>;
}

export type StepAgentOutcome =
  | {
      readonly status: "ok";
      readonly summary: string;
      readonly outputArtifact: string | null;
      readonly subagentId: string;
    }
  | {
      readonly status: "fail";
      readonly summary: string;
      readonly failReason: string;
      /** Null if the failure happened before a subagent was spawned. */
      readonly subagentId: string | null;
    };

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

/**
 * Execute one AgentStep end-to-end.
 *
 * The function never throws — every failure mode produces a typed
 * `fail` outcome that the runner can persist and reason about. A thrown
 * exception here would indicate a programmer error, not a step failure.
 */
export async function executeAgentStep(
  deps: AgentStepDeps,
  request: ExecuteAgentStepRequest,
): Promise<StepAgentOutcome> {
  const { runId, stepKey, step, originator, templateInputs, templateArtifacts } = request;

  // 1. Resolve the agent's template.
  const resolved = deps.resolveAgent(step.agent);
  if (!resolved) {
    return makeFail(`Agent "${step.agent}" not found`, null);
  }

  // 2. Render the task template. Authoring mistakes (unknown placeholders)
  //    surface as a fail outcome rather than crashing the runner.
  let renderedTask: string;
  try {
    renderedTask = renderTemplate(step.task, {
      runId,
      stepId: step.id,
      inputs: templateInputs,
      artifacts: templateArtifacts,
    });
  } catch (err) {
    return makeFail(`Template render failed: ${errMessage(err)}`, null);
  }

  // 3. Resolve declared inputs against the run's artifact dir.
  let resolvedInputs: string[];
  try {
    resolvedInputs = await resolveStepInputs(deps.stateDir, runId, step.inputs ?? []);
  } catch (err) {
    return makeFail(`Input resolution failed: ${errMessage(err)}`, null);
  }

  // 4. Assemble the step agent's system prompt in ephemeral mode.
  let systemPrompt: string;
  try {
    systemPrompt = await deps.assembleEphemeralContext(resolved.agentDir);
  } catch (err) {
    return makeFail(`Failed to load agent context: ${errMessage(err)}`, null);
  }

  // 5. Build the spawn request.
  //    - workingDirectory = run's artifact dir so the agent reads/writes
  //      artifacts as plain files in its CWD.
  //    - workflowRunId / workflowStepKey become RONDEL_RUN_ID / RONDEL_STEP_KEY
  //      env vars the rondel_step_complete MCP tool reads at call time.
  //    - workflowEnv carries RONDEL_WORKFLOW_INPUTS (comma-joined artifact
  //      names) so the agent can list its declared inputs without a round
  //      trip to the bridge.
  const workingDir = artifactDirectory(deps.stateDir, runId);
  const timeoutMs = step.timeoutMs ?? DEFAULT_AGENT_STEP_TIMEOUT_MS;

  const spawnReq: SubagentSpawnRequest = {
    parentAgentName: step.agent,
    parentChannelType: originator.channelType,
    parentAccountId: originator.accountId,
    parentChatId: originator.chatId,
    task: renderedTask,
    systemPrompt,
    model: resolved.model,
    workingDirectory: workingDir,
    allowedTools: resolved.allowedTools,
    disallowedTools: resolved.disallowedTools,
    timeoutMs,
    workflowRunId: runId,
    workflowStepKey: stepKey,
    workflowEnv: {
      RONDEL_WORKFLOW_INPUTS: resolvedInputs.join(","),
    },
  };

  // 6. Spawn.
  let info: SubagentInfo;
  try {
    info = await deps.spawnSubagent(spawnReq);
  } catch (err) {
    return makeFail(`Subagent spawn failed: ${errMessage(err)}`, null);
  }

  // 7. Wait for completion. The implementation is injected; for tests it
  //    resolves synchronously with a canned outcome. For the real manager
  //    it resolves when the bridge fires the step-complete hook.
  return deps.waitForStepCompletion({
    runId,
    stepKey,
    subagentId: info.id,
    timeoutMs,
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFail(reason: string, subagentId: string | null): StepAgentOutcome {
  return {
    status: "fail",
    summary: reason.length > 200 ? reason.slice(0, 200) + "…" : reason,
    failReason: reason,
    subagentId,
  };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
