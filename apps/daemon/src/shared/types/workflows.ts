// --- Workflow engine types (Layer 4 v0) ---
//
// Workflows are declarative, multi-step pipelines executed by the workflow
// manager. Each step is either an agent spawn (via the subagent manager),
// a human gate, or a retry block wrapping other steps. Workflow state is
// file-backed under state/workflows/{runId}/ and observable through the
// conversation ledger via workflow:* hook events.
//
// Pure types — zero runtime imports. Runtime code lives in src/workflows/.

// ---------------------------------------------------------------------------
// Workflow definition (authored as JSON, loaded at startup)
// ---------------------------------------------------------------------------

/** Top-level workflow definition loaded from a JSON file. */
export interface WorkflowDefinition {
  readonly id: string;
  readonly version: number;                       // SEAM: schema migration
  readonly description?: string;
  readonly inputs: Readonly<Record<string, WorkflowInputSpec>>;
  readonly steps: readonly Step[];
}

export interface WorkflowInputSpec {
  readonly kind: "artifact" | "string";           // SEAM: future = number, bool, json
  readonly required?: boolean;
  readonly description?: string;
}

/** Discriminated union of step kinds. v0 supports agent, gate, retry. */
export type Step = AgentStep | GateStep | RetryStep;

export interface StepBase {
  readonly id: string;
  /**
   * Controls whether a step runs on first attempt of a retry block or only
   * on re-runs. Default "always". Used to model remediation phases cleanly
   * without a separate condition language.
   */
  readonly when?: "always" | "on-retry";
}

/** Spawn an agent as a subagent, feed it inputs, expect an output artifact. */
export interface AgentStep extends StepBase {
  readonly kind: "agent";
  readonly agent: string;                         // directory name under workspaces/
  readonly task: string;                          // supports {{inputs.x}} / {{artifacts.y}}
  readonly inputs?: readonly string[];            // artifact names; trailing "?" = optional
  readonly output?: string;                       // artifact name the step must produce
  readonly timeoutMs?: number;                    // default 30 min

  // SEAMS — reserved, validated but unused in v0.
  readonly role?: string;                         // future: agent-identity vs instance split
  readonly workingSubdir?: string;                // future: per-step subdir within run
}

/** Pause the workflow and wait for a human decision delivered via an MCP tool. */
export interface GateStep extends StepBase {
  readonly kind: "gate";
  readonly prompt: string;                        // message delivered to the human
  readonly inputs?: readonly string[];            // artifact names referenced in prompt

  // SEAMS — reserved, validated but unused in v0.
  readonly timeoutMs?: number;                    // future: auto-timeout-as-deny
  readonly to?: GateTargetOverride;               // future: override default gate channel
}

/** Reserved seam for future cross-channel gate routing. */
export interface GateTargetOverride {
  readonly channelType: string;
  readonly accountId: string;
  readonly chatId: string;
}

/** Run a body of steps repeatedly until a designated success step returns ok. */
export interface RetryStep extends StepBase {
  readonly kind: "retry";
  readonly body: readonly Step[];
  readonly maxAttempts: number;                   // inclusive cap on attempts
  readonly succeedsWhen: SucceedsWhen;
}

export interface SucceedsWhen {
  readonly stepId: string;                        // must reference a step inside body
  readonly statusIs: "ok";                        // v0: only "ok"; future: richer predicates
}

// ---------------------------------------------------------------------------
// Runtime state (persisted to state/workflows/{runId}/run.json)
// ---------------------------------------------------------------------------

export type WorkflowRunStatus =
  | "pending"          // created, not yet started
  | "running"          // executing a step
  | "waiting-gate"     // paused on a gate awaiting human decision
  | "completed"        // all steps finished successfully
  | "failed"           // a step failed terminally or a gate was denied
  | "interrupted";     // daemon crashed mid-step; requires manual resume

/** Fully-qualified identity of a workflow run. */
export interface WorkflowRunState {
  readonly runId: string;                         // "run_{unixMs}_{rand6}"
  readonly workflowId: string;
  readonly workflowVersion: number;
  readonly status: WorkflowRunStatus;
  readonly startedAt: string;                     // ISO 8601
  readonly updatedAt: string;                     // ISO 8601
  readonly completedAt: string | null;

  /** Where the runner was invoked from — becomes the default gate channel. */
  readonly originator: WorkflowOriginator;

  /** Declared inputs resolved to concrete artifact file names at start time. */
  readonly inputs: Readonly<Record<string, string>>;

  /**
   * Program counter. A path-joined string identifying the current step.
   * Top-level steps: "architecture". Nested retry steps: "dev-qa-loop/attempt:2/qa".
   * Null when status is pending or completed/failed/interrupted.
   */
  readonly currentStepKey: string | null;

  /** Per-step runtime state, keyed by the same path-joined scheme as currentStepKey. */
  readonly stepStates: Readonly<Record<string, StepRunState>>;

  /** Terminal failure reason, populated only when status is "failed" or "interrupted". */
  readonly failReason: string | null;

  // SEAM: reserved for future parent/child workflow relationships.
  readonly parentRunId?: string;
}

/** The agent conversation a workflow was triggered from. */
export interface WorkflowOriginator {
  readonly agent: string;
  readonly channelType: string;
  readonly accountId: string;
  readonly chatId: string;
}

/** Per-step runtime state. */
export interface StepRunState {
  readonly stepKey: string;                       // path-joined identity (matches currentStepKey)
  readonly stepId: string;                        // the Step.id from the definition
  readonly kind: Step["kind"];
  readonly status: "pending" | "running" | "completed" | "failed" | "skipped";
  readonly attempt: number;                       // 1 for normal; >1 inside a retry block
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly outputArtifact: string | null;         // artifact name, not full path
  readonly summary: string | null;
  readonly failReason: string | null;
  readonly subagentId: string | null;             // set for AgentStep
  readonly gateId: string | null;                 // set for GateStep
}

// ---------------------------------------------------------------------------
// Gate records (persisted to state/workflows/{runId}/gates/{gateId}.json)
// ---------------------------------------------------------------------------

export interface GateRecord {
  readonly gateId: string;                        // "gate_{unixMs}_{rand6}"
  readonly runId: string;
  readonly stepKey: string;                       // the step that opened this gate
  readonly status: "pending" | "resolved";
  readonly prompt: string;
  readonly inputArtifacts: readonly string[];
  readonly notifiedAgent: string;
  readonly notifiedChannelType: string;
  readonly notifiedChatId: string;
  readonly createdAt: string;
  readonly resolvedAt: string | null;
  readonly decision: "approved" | "denied" | null;
  readonly note: string | null;
  readonly decidedBy: string | null;              // "{channelType}:{accountId}"
}

// ---------------------------------------------------------------------------
// Hook event payloads — emitted on RondelHooks, consumed by LedgerWriter + UI
// ---------------------------------------------------------------------------

export interface WorkflowStartedEvent {
  readonly run: WorkflowRunState;
}

export interface WorkflowStepStartedEvent {
  readonly runId: string;
  readonly originator: WorkflowOriginator;
  readonly stepState: StepRunState;
}

export interface WorkflowStepCompletedEvent {
  readonly runId: string;
  readonly originator: WorkflowOriginator;
  readonly stepState: StepRunState;
}

export interface WorkflowStepFailedEvent {
  readonly runId: string;
  readonly originator: WorkflowOriginator;
  readonly stepState: StepRunState;
}

export interface WorkflowGateWaitingEvent {
  readonly runId: string;
  readonly originator: WorkflowOriginator;
  readonly gate: GateRecord;
}

export interface WorkflowGateResolvedEvent {
  readonly runId: string;
  readonly originator: WorkflowOriginator;
  readonly gate: GateRecord;
}

export interface WorkflowCompletedEvent {
  readonly runId: string;
  readonly originator: WorkflowOriginator;
  readonly workflowId: string;
}

export interface WorkflowFailedEvent {
  readonly runId: string;
  readonly originator: WorkflowOriginator;
  readonly workflowId: string;
  readonly reason: string;
}

export interface WorkflowResumedEvent {
  readonly runId: string;
  readonly originator: WorkflowOriginator;
}

export interface WorkflowInterruptedEvent {
  readonly runId: string;
  readonly originator: WorkflowOriginator;
  readonly reason: string;
}

// ---------------------------------------------------------------------------
// MCP tool input shapes (what agents pass; wire validation lives in bridge/schemas.ts)
// ---------------------------------------------------------------------------

export interface WorkflowStartInput {
  readonly workflowId: string;
  /**
   * Map from declared input name to a source file path. The runner copies
   * these into the run's artifacts/ folder at start time so later steps
   * reference them by name rather than by absolute path.
   */
  readonly inputs: Readonly<Record<string, string>>;
}

export interface StepCompleteInput {
  readonly runId: string;
  readonly stepKey: string;
  readonly status: "ok" | "fail";
  readonly summary: string;
  readonly artifact?: string;
  readonly failReason?: string;
}

export interface ResolveGateInput {
  readonly runId: string;
  readonly gateId: string;
  readonly decision: "approved" | "denied";
  readonly note?: string;
  readonly decidedBy: string;                     // "{channelType}:{accountId}"
}
