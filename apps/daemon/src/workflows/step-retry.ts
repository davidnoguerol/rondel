/**
 * Pure helpers for retry-block execution.
 *
 * The runner walks retry bodies repeatedly. Per-attempt step identity is
 * encoded as a path-joined key so the flat `stepStates` record on
 * `WorkflowRunState` can hold every iteration without collision.
 *
 * Separate module so the logic is unit-testable without any daemon state.
 */

import type { Step, RetryStep, StepRunState } from "../shared/types/index.js";

/**
 * Whether a step should run on this attempt of its enclosing retry block.
 *
 * - `when: "always"` (default) runs on every attempt.
 * - `when: "on-retry"` is skipped on attempt 1 and runs on attempt >= 2.
 *
 * Steps outside a retry block always have attempt 1 and therefore
 * `when: "on-retry"` skips them — which is intentional: it's a
 * configuration error to use `on-retry` outside a retry block.
 */
export function shouldRunInAttempt(step: Step, attempt: number): boolean {
  const when = step.when ?? "always";
  if (when === "always") return true;
  if (when === "on-retry") return attempt > 1;
  return true;
}

/**
 * Build the flat `stepKey` for a step running inside a retry block at a
 * specific attempt. The format is deterministic and parseable — tests
 * and crash recovery rely on it.
 *
 *   buildRetryStepKey("dev-qa-loop", 2, "qa") // "dev-qa-loop/attempt:2/qa"
 */
export function buildRetryStepKey(
  retryStepId: string,
  attempt: number,
  innerStepId: string,
): string {
  return `${retryStepId}/attempt:${attempt}/${innerStepId}`;
}

/**
 * Evaluate whether a retry block's `succeedsWhen` condition has been met
 * at the end of an attempt.
 *
 * Returns:
 *   `true`  — target step completed successfully → exit the retry loop.
 *   `false` — target step failed or was skipped → re-enter the loop.
 *   `null`  — target step has no recorded state yet (attempt in progress
 *             or state dict out of sync) → caller should not act yet.
 *
 * Only `statusIs: "ok"` is supported in v0. The shape is reserved for
 * future richer predicates.
 */
export function evaluateSucceedsWhen(
  retry: RetryStep,
  attempt: number,
  stepStates: Readonly<Record<string, StepRunState>>,
): boolean | null {
  const targetKey = buildRetryStepKey(retry.id, attempt, retry.succeedsWhen.stepId);
  const state = stepStates[targetKey];
  if (!state) return null;
  if (state.status === "completed") return true;
  if (state.status === "failed" || state.status === "skipped") return false;
  return null;
}

/**
 * Validate that the retry block's `succeedsWhen.stepId` references a step
 * that actually exists inside the body. Called by the loader to catch
 * authoring mistakes before any run starts.
 */
export function validateRetryTarget(retry: RetryStep): void {
  const found = retry.body.some((s) => s.id === retry.succeedsWhen.stepId);
  if (!found) {
    throw new Error(
      `RetryStep "${retry.id}" succeedsWhen.stepId "${retry.succeedsWhen.stepId}" ` +
      `does not reference a step inside body`,
    );
  }
}
