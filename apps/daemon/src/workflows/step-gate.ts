/**
 * GateStep executor.
 *
 * Pauses the workflow and waits for a human decision, delivered through
 * an MCP tool call on the gate-channel agent (see the plan: gates are
 * resolved by `rondel_resolve_gate`, not by parsing chat text).
 *
 * The executor:
 *   1. Renders the gate prompt template.
 *   2. Builds a `pending` GateRecord and writes it to disk.
 *   3. Registers a pending promise in the WorkflowManager's registry.
 *   4. Sends a notification message to the originator's conversation,
 *      prefixed with `[WORKFLOW GATE {id}]` so the agent's skill can
 *      recognize it and call rondel_resolve_gate with the user's decision.
 *   5. Awaits the resolution promise.
 *   6. Returns a typed outcome. The manager's resolveGate path is
 *      responsible for writing the resolved record and emitting the
 *      workflow:gate_resolved hook — NOT this executor.
 *
 * Pure DI: all I/O flows through deps so the module is unit-testable
 * without a real router, filesystem, or hooks emitter.
 */

import { randomBytes } from "node:crypto";
import type {
  GateStep,
  GateRecord,
  WorkflowOriginator,
  WorkflowGateWaitingEvent,
} from "../shared/types/index.js";
import { renderTemplate } from "./template-render.js";

// ---------------------------------------------------------------------------
// Dependency contracts
// ---------------------------------------------------------------------------

/**
 * The resolution payload produced by WorkflowManager.resolveGate and
 * passed back to the awaiting step-gate promise.
 */
export interface GateResolution {
  readonly decision: "approved" | "denied";
  readonly decidedBy: string;
  readonly note: string | null;
  readonly decidedAt: string;
}

/**
 * Minimal hook interface used by the executor. The real manager passes a
 * `RondelHooks`; tests pass a tiny spy. Keeping the contract narrow avoids
 * dragging the whole hooks module into unit tests.
 */
export interface GateHookEmitter {
  emit(event: "workflow:gate_waiting", payload: WorkflowGateWaitingEvent): void;
}

export interface GateStepDeps {
  /** Current timestamp — injected for determinism in tests. */
  readonly now: () => Date;
  /** Generate a random suffix for gate ids — injected for determinism. */
  readonly randomSuffix: () => string;
  /** Persist a gate record to disk. */
  readonly writeGate: (record: GateRecord) => Promise<void>;
  /**
   * Register a pending gate and return a promise that resolves when the
   * manager's resolveGate path fires. The manager owns the registry so
   * the HTTP handler can find the pending promise regardless of which
   * runner invoked this executor.
   */
  readonly registerPendingGate: (runId: string, gateId: string) => Promise<GateResolution>;
  /**
   * Deliver the gate notification to the originator's conversation.
   * Non-blocking (router.sendOrQueue). `accountId` pins the delivery to
   * the exact channel account that opened the gate — required for any
   * channel with multiple bound accounts so the notification reaches the
   * correct bot/user pair instead of the agent's primary channel default.
   */
  readonly sendToChannel: (
    agent: string,
    channelType: string,
    accountId: string,
    chatId: string,
    text: string,
  ) => void;
  /** Emit the workflow:gate_waiting hook event. */
  readonly hooks: GateHookEmitter;
}

// ---------------------------------------------------------------------------
// Request and outcome
// ---------------------------------------------------------------------------

export interface ExecuteGateStepRequest {
  readonly runId: string;
  readonly stepKey: string;
  readonly step: GateStep;
  readonly originator: WorkflowOriginator;
  /** Variables available via `{{inputs.x}}` in the gate prompt. */
  readonly templateInputs: Readonly<Record<string, string>>;
  /** Variables available via `{{artifacts.x}}` in the gate prompt. */
  readonly templateArtifacts: Readonly<Record<string, string>>;
}

export type StepGateOutcome =
  | {
      readonly status: "approved" | "denied";
      readonly gateId: string;
      readonly note: string | null;
      readonly decidedBy: string;
      readonly decidedAt: string;
    }
  | {
      /** Something prevented the gate from even opening. No promise to await. */
      readonly status: "failed_to_open";
      readonly gateId: null;
      readonly failReason: string;
    };

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export async function executeGateStep(
  deps: GateStepDeps,
  request: ExecuteGateStepRequest,
): Promise<StepGateOutcome> {
  // 1. Render the prompt template. Authoring mistakes fail the gate to open
  //    so the runner can surface them as a terminal step failure.
  let renderedPrompt: string;
  try {
    renderedPrompt = renderTemplate(request.step.prompt, {
      runId: request.runId,
      stepId: request.step.id,
      inputs: request.templateInputs,
      artifacts: request.templateArtifacts,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: "failed_to_open", gateId: null, failReason: `Template render failed: ${msg}` };
  }

  // 2. Build the pending gate record.
  const now = deps.now();
  const gateId = `gate_${now.getTime()}_${deps.randomSuffix()}`;
  const record: GateRecord = {
    gateId,
    runId: request.runId,
    stepKey: request.stepKey,
    status: "pending",
    prompt: renderedPrompt,
    inputArtifacts: request.step.inputs ?? [],
    notifiedAgent: request.originator.agent,
    notifiedChannelType: request.originator.channelType,
    notifiedAccountId: request.originator.accountId,
    notifiedChatId: request.originator.chatId,
    createdAt: now.toISOString(),
    resolvedAt: null,
    decision: null,
    note: null,
    decidedBy: null,
  };

  // 3. Persist BEFORE notifying — if the notification side-effects (send
  //    Telegram message) and we crash between send and persist, a user
  //    could see a gate message for a gate we have no record of. Write
  //    first keeps the on-disk state authoritative.
  try {
    await deps.writeGate(record);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: "failed_to_open", gateId: null, failReason: `Could not persist gate: ${msg}` };
  }

  // 4. Register the pending promise BEFORE sending the notification so
  //    there's no race where the user resolves instantly and the manager
  //    has nothing registered to resolve.
  const resolutionPromise = deps.registerPendingGate(request.runId, gateId);

  // 5. Emit the waiting hook. LedgerWriter (commit 6) subscribes.
  deps.hooks.emit("workflow:gate_waiting", {
    runId: request.runId,
    originator: request.originator,
    gate: record,
  });

  // 6. Deliver the notification to the human via the originator's channel.
  //    The `[WORKFLOW GATE run=<runId> gate=<gateId>]` prefix is the
  //    contract the gate-channel agent's skill uses to recognize gate
  //    messages and extract both ids for the rondel_resolve_gate call.
  //    Both ids are embedded so the agent doesn't have to correlate via
  //    a separate ledger query — the message is self-sufficient.
  const notification = `[WORKFLOW GATE run=${request.runId} gate=${gateId}]\n${renderedPrompt}`;
  deps.sendToChannel(
    request.originator.agent,
    request.originator.channelType,
    request.originator.accountId,
    request.originator.chatId,
    notification,
  );

  // 7. Await resolution. The promise is fulfilled by the manager's
  //    resolveGate path once rondel_resolve_gate POSTs to the bridge.
  const resolution = await resolutionPromise;

  return {
    status: resolution.decision,
    gateId,
    note: resolution.note,
    decidedBy: resolution.decidedBy,
    decidedAt: resolution.decidedAt,
  };
}

// ---------------------------------------------------------------------------
// Convenience helpers
// ---------------------------------------------------------------------------

/**
 * Default random-suffix generator used by the manager. Six-char lowercase
 * alphanumeric, matching the gate id regex in `bridge/schemas.ts`.
 */
export function defaultGateRandomSuffix(): string {
  return randomBytes(3).toString("hex");
}
