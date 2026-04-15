/**
 * Crash recovery — bring dangling workflow runs into a safe terminal state
 * on daemon startup.
 *
 * v0 policy is conservative: any run whose status is `pending`, `running`,
 * or `waiting-gate` when the daemon starts up is marked `interrupted`. No
 * auto-resume. `pending` is included to cover the narrow window where
 * startRun crashes between persisting the initial state and invoking
 * runner.run() — such a run would otherwise stay pending forever.
 *
 * Why conservative? Resuming an agent step means re-spawning a subagent
 * that may already have had external side effects (committed code,
 * deployed, sent an email). Without a durable record of what happened
 * inside each step, we'd double-execute. A future enhancement adds an
 * `idempotent: true` flag on AgentStep that opts a step into auto-respawn.
 *
 * Resuming a waiting-gate run is safe in principle — gates have no side
 * effects — but the runner v0 does not have re-entry from a mid-run
 * state. Interrupted gates are therefore treated the same way; the user
 * can restart the workflow if needed. Commit 5+ will add re-entry.
 */

import type { RondelHooks } from "../shared/hooks.js";
import type { Logger } from "../shared/logger.js";
import { listRunIds, readRunState, writeRunState } from "./workflow-storage.js";
import type { WorkflowRunState } from "../shared/types/index.js";

export interface CrashRecoveryDeps {
  readonly stateDir: string;
  readonly hooks: RondelHooks;
  readonly log: Logger;
  readonly now: () => Date;
}

export interface CrashRecoveryResult {
  readonly scanned: number;
  readonly interrupted: number;
  readonly interruptedIds: readonly string[];
}

/**
 * Scan state/workflows/ and mark any non-terminal run as interrupted.
 * Returns counts for logging. Never throws — errors reading individual
 * runs are logged and skipped.
 */
export async function recoverInterruptedRuns(
  deps: CrashRecoveryDeps,
): Promise<CrashRecoveryResult> {
  const runIds = await listRunIds(deps.stateDir);
  let interrupted = 0;
  const interruptedIds: string[] = [];

  for (const runId of runIds) {
    let state: WorkflowRunState | null;
    try {
      state = await readRunState(deps.stateDir, runId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      deps.log.warn(`Crash recovery skipped ${runId}: ${msg}`);
      continue;
    }
    if (!state) continue;
    if (
      state.status !== "pending" &&
      state.status !== "running" &&
      state.status !== "waiting-gate"
    ) {
      continue;
    }

    const reason = `Daemon restart while run was ${state.status}`;
    const now = deps.now().toISOString();
    const updated: WorkflowRunState = {
      ...state,
      status: "interrupted",
      failReason: reason,
      completedAt: now,
      updatedAt: now,
      currentStepKey: null,
    };

    try {
      await writeRunState(deps.stateDir, updated);
      deps.hooks.emit("workflow:interrupted", {
        runId,
        originator: state.originator,
        reason,
      });
      deps.log.warn(`Workflow run ${runId} marked interrupted on startup`);
      interrupted++;
      interruptedIds.push(runId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      deps.log.error(`Failed to mark ${runId} as interrupted: ${msg}`);
    }
  }

  return { scanned: runIds.length, interrupted, interruptedIds };
}
