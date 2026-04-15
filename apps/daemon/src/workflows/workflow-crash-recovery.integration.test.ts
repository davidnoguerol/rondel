/**
 * Integration tests for recoverInterruptedRuns.
 *
 * The manager-level integration test covers the happy path via
 * WorkflowManager.initialize; this file drives the pure function
 * directly so every branch of its contract is pinned:
 *
 *   - non-terminal runs → flipped to "interrupted" + hook emitted
 *   - terminal runs (completed/failed) → untouched
 *   - corrupt run.json → skipped, not fatal
 *   - empty state/workflows/ → scanned=0
 */

import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { recoverInterruptedRuns } from "./workflow-crash-recovery.js";
import {
  writeRunState,
  readRunState,
  runDirectory,
  runStatePath,
} from "./workflow-storage.js";
import { withTmpRondel } from "../../../../tests/helpers/tmp.js";
import { createCapturingLogger } from "../../../../tests/helpers/logger.js";
import { createHooks, type RondelHooks } from "../shared/hooks.js";
import type { WorkflowRunState, WorkflowRunStatus } from "../shared/types/index.js";

/**
 * Filter `workflow:interrupted` events off a real hooks instance. We
 * don't use `createRecordingHooks` from tests/helpers/hooks.ts because
 * this test only cares about one event kind — subscribing directly is
 * clearer than scanning through an all-events array.
 */
interface HookRecord {
  readonly event: string;
  readonly payload: unknown;
}
function captureInterrupted(hooks: RondelHooks): HookRecord[] {
  const records: HookRecord[] = [];
  hooks.on("workflow:interrupted", (payload) =>
    records.push({ event: "workflow:interrupted", payload }),
  );
  return records;
}

const FIXED_NOW = new Date("2026-04-15T12:00:00.000Z");

function makeRun(runId: string, status: WorkflowRunStatus): WorkflowRunState {
  return {
    runId,
    workflowId: "demo",
    workflowVersion: 1,
    status,
    startedAt: "2026-04-15T00:00:00.000Z",
    updatedAt: "2026-04-15T00:00:00.000Z",
    completedAt: null,
    originator: {
      agent: "pm",
      channelType: "telegram",
      accountId: "pm-bot",
      chatId: "12345",
    },
    inputs: {},
    currentStepKey: "architecture",
    stepStates: {},
    failReason: null,
  };
}

function makeDeps(tmpStateDir: string) {
  const hooks = createHooks();
  const records = captureInterrupted(hooks);
  const log = createCapturingLogger();
  return {
    deps: { stateDir: tmpStateDir, hooks, log, now: () => FIXED_NOW },
    records,
    log,
  };
}

describe("recoverInterruptedRuns", () => {
  it("returns zero counts when state/workflows/ does not exist", async () => {
    const tmp = withTmpRondel();
    const { deps, records } = makeDeps(tmp.stateDir);

    const result = await recoverInterruptedRuns(deps);

    expect(result).toEqual({ scanned: 0, interrupted: 0, interruptedIds: [] });
    expect(records).toHaveLength(0);
  });

  it("flips a running run to interrupted and emits workflow:interrupted", async () => {
    const tmp = withTmpRondel();
    await writeRunState(tmp.stateDir, makeRun("run_1700000000000_aaa111", "running"));
    const { deps, records } = makeDeps(tmp.stateDir);

    const result = await recoverInterruptedRuns(deps);

    expect(result.scanned).toBe(1);
    expect(result.interrupted).toBe(1);
    expect(result.interruptedIds).toEqual(["run_1700000000000_aaa111"]);

    // Disk side-effects
    const updated = await readRunState(tmp.stateDir, "run_1700000000000_aaa111");
    expect(updated?.status).toBe("interrupted");
    expect(updated?.failReason).toBe("Daemon restart while run was running");
    expect(updated?.completedAt).toBe(FIXED_NOW.toISOString());
    expect(updated?.updatedAt).toBe(FIXED_NOW.toISOString());
    expect(updated?.currentStepKey).toBeNull();

    // Hook side-effect
    const interruptedEvents = records.filter((r) => r.event === "workflow:interrupted");
    expect(interruptedEvents).toHaveLength(1);
    expect((interruptedEvents[0]!.payload as { runId: string }).runId).toBe(
      "run_1700000000000_aaa111",
    );
    expect((interruptedEvents[0]!.payload as { reason: string }).reason).toBe(
      "Daemon restart while run was running",
    );
  });

  it("flips a waiting-gate run to interrupted with the correct reason", async () => {
    const tmp = withTmpRondel();
    await writeRunState(
      tmp.stateDir,
      makeRun("run_1700000000000_bbb222", "waiting-gate"),
    );
    const { deps } = makeDeps(tmp.stateDir);

    await recoverInterruptedRuns(deps);

    const updated = await readRunState(tmp.stateDir, "run_1700000000000_bbb222");
    expect(updated?.status).toBe("interrupted");
    expect(updated?.failReason).toBe("Daemon restart while run was waiting-gate");
  });

  it("leaves terminal runs (completed / failed / interrupted) untouched", async () => {
    const tmp = withTmpRondel();
    await writeRunState(tmp.stateDir, makeRun("run_1700000000000_ccc333", "completed"));
    await writeRunState(tmp.stateDir, makeRun("run_1700000000001_ddd444", "failed"));
    await writeRunState(
      tmp.stateDir,
      makeRun("run_1700000000002_eee555", "interrupted"),
    );
    const { deps, records } = makeDeps(tmp.stateDir);

    const result = await recoverInterruptedRuns(deps);

    expect(result.scanned).toBe(3);
    expect(result.interrupted).toBe(0);
    expect(result.interruptedIds).toEqual([]);
    expect(records.filter((r) => r.event === "workflow:interrupted")).toHaveLength(0);

    // Files on disk should still match their original status.
    expect((await readRunState(tmp.stateDir, "run_1700000000000_ccc333"))?.status).toBe(
      "completed",
    );
    expect((await readRunState(tmp.stateDir, "run_1700000000001_ddd444"))?.status).toBe(
      "failed",
    );
    expect((await readRunState(tmp.stateDir, "run_1700000000002_eee555"))?.status).toBe(
      "interrupted",
    );
  });

  it("skips a corrupt run.json without throwing, processing the rest", async () => {
    const tmp = withTmpRondel();
    // One valid running run...
    await writeRunState(tmp.stateDir, makeRun("run_1700000000000_fff666", "running"));
    // ...and one corrupt run directory.
    mkdirSync(runDirectory(tmp.stateDir, "run_1700000000001_ggg777"), { recursive: true });
    writeFileSync(runStatePath(tmp.stateDir, "run_1700000000001_ggg777"), "{not json");

    const { deps, records } = makeDeps(tmp.stateDir);

    const result = await recoverInterruptedRuns(deps);

    // scanned counts both directories; only the valid one is interrupted.
    expect(result.scanned).toBe(2);
    expect(result.interrupted).toBe(1);
    expect(result.interruptedIds).toEqual(["run_1700000000000_fff666"]);

    // And we emitted exactly one interrupted event.
    expect(records.filter((r) => r.event === "workflow:interrupted")).toHaveLength(1);
  });

  it("mixes terminal and non-terminal runs and only touches the non-terminal ones", async () => {
    const tmp = withTmpRondel();
    await writeRunState(tmp.stateDir, makeRun("run_1700000000000_hhh888", "running"));
    await writeRunState(tmp.stateDir, makeRun("run_1700000000001_iii999", "completed"));
    await writeRunState(
      tmp.stateDir,
      makeRun("run_1700000000002_jjj000", "waiting-gate"),
    );
    const { deps } = makeDeps(tmp.stateDir);

    const result = await recoverInterruptedRuns(deps);

    expect(result.scanned).toBe(3);
    expect(result.interrupted).toBe(2);
    expect(result.interruptedIds.sort()).toEqual(
      ["run_1700000000000_hhh888", "run_1700000000002_jjj000"].sort(),
    );
  });
});
