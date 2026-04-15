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

import type {
  GateRecord,
  WorkflowOriginator,
  WorkflowGateResolvedEvent,
} from "../shared/types/index.js";
import type { RondelHooks } from "../shared/hooks.js";
import type { Logger } from "../shared/logger.js";
import {
  readGateRecord,
  writeGateRecord,
} from "./workflow-storage.js";
import type { GateResolution } from "./step-gate.js";

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

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export interface WorkflowManagerDeps {
  readonly stateDir: string;
  readonly hooks: RondelHooks;
  readonly log: Logger;
  /**
   * Deliver a text message to an agent's conversation. Abstracts
   * Router.sendOrQueue so tests don't need a real router.
   */
  readonly sendToChannel: (
    agent: string,
    channelType: string,
    chatId: string,
    text: string,
  ) => void;
}

// ---------------------------------------------------------------------------
// Pending gate registry
// ---------------------------------------------------------------------------

interface PendingGateEntry {
  readonly runId: string;
  readonly resolve: (resolution: GateResolution) => void;
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export class WorkflowManager {
  private readonly pendingGates = new Map<string, PendingGateEntry>();
  private readonly log: Logger;

  constructor(private readonly deps: WorkflowManagerDeps) {
    this.log = deps.log.child("workflows");
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
  // Placeholders filled in by commit 5
  // -------------------------------------------------------------------------

  /** Called from apps/daemon/src/index.ts at startup. Commit 5 fills it in. */
  async initialize(): Promise<void> {
    // Commit 5: crash-recovery scan of state/workflows/
  }

  /** Shutdown hook. Drops all pending gate waiters so they can be GC'd. */
  shutdown(): void {
    this.pendingGates.clear();
  }
}
