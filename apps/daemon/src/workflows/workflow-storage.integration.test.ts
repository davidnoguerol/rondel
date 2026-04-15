/**
 * Integration tests for workflow-storage — the atomic file-backed
 * persistence layer for workflow runs and gate records.
 *
 * Covers the round-trips (write → read) and the corrupt/missing-file
 * error branches that the runner and crash-recovery rely on.
 */

import { describe, it, expect } from "vitest";
import { writeFileSync, mkdirSync } from "node:fs";
import {
  writeRunState,
  readRunState,
  listRunIds,
  writeGateRecord,
  readGateRecord,
  listGateRecords,
  writeDefinitionSnapshot,
  readDefinitionSnapshot,
  runStatePath,
  gateRecordPath,
  gateDirectory,
  runDirectory,
  ensureRunDirectories,
  WorkflowStorageError,
} from "./workflow-storage.js";
import { withTmpRondel } from "../../../../tests/helpers/tmp.js";
import type { WorkflowRunState, GateRecord } from "../shared/types/index.js";

const RUN_ID = "run_1700000000000_abc123";
const OTHER_RUN_ID = "run_1700000000001_def456";

function makeRunState(overrides: Partial<WorkflowRunState> = {}): WorkflowRunState {
  return {
    runId: RUN_ID,
    workflowId: "demo",
    workflowVersion: 1,
    status: "running",
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
    ...overrides,
  };
}

function makeGateRecord(overrides: Partial<GateRecord> = {}): GateRecord {
  return {
    gateId: "gate_1700000000000_xyz789",
    runId: RUN_ID,
    stepKey: "approve-plan",
    status: "pending",
    prompt: "please approve",
    inputArtifacts: [],
    notifiedAgent: "pm",
    notifiedChannelType: "telegram",
    notifiedAccountId: "pm-bot",
    notifiedChatId: "12345",
    createdAt: "2026-04-15T00:00:00.000Z",
    resolvedAt: null,
    decision: null,
    note: null,
    decidedBy: null,
    ...overrides,
  };
}

describe("writeRunState / readRunState", () => {
  it("round-trips a valid run state", async () => {
    const tmp = withTmpRondel();
    const state = makeRunState();
    await writeRunState(tmp.stateDir, state);
    const read = await readRunState(tmp.stateDir, state.runId);
    expect(read).toEqual(state);
  });

  it("returns null when the run does not exist on disk", async () => {
    const tmp = withTmpRondel();
    expect(await readRunState(tmp.stateDir, RUN_ID)).toBeNull();
  });

  it("creates the parent directory on first write", async () => {
    const tmp = withTmpRondel();
    // No mkdir ahead of time — writeRunState must create state/workflows/{runId}/.
    await writeRunState(tmp.stateDir, makeRunState());
    expect(await readRunState(tmp.stateDir, RUN_ID)).not.toBeNull();
  });

  it("throws WorkflowStorageError on unparseable JSON", async () => {
    const tmp = withTmpRondel();
    mkdirSync(runDirectory(tmp.stateDir, RUN_ID), { recursive: true });
    writeFileSync(runStatePath(tmp.stateDir, RUN_ID), "{not json");

    await expect(readRunState(tmp.stateDir, RUN_ID)).rejects.toThrow(WorkflowStorageError);
    await expect(readRunState(tmp.stateDir, RUN_ID)).rejects.toThrow(/Corrupt run\.json/);
  });

  it("throws WorkflowStorageError on Zod-invalid JSON with field path in message", async () => {
    const tmp = withTmpRondel();
    mkdirSync(runDirectory(tmp.stateDir, RUN_ID), { recursive: true });
    writeFileSync(
      runStatePath(tmp.stateDir, RUN_ID),
      JSON.stringify({ runId: "not-a-valid-run-id", wrong: "shape" }),
    );

    await expect(readRunState(tmp.stateDir, RUN_ID)).rejects.toThrow(WorkflowStorageError);
    await expect(readRunState(tmp.stateDir, RUN_ID)).rejects.toThrow(/Invalid run\.json/);
  });
});

describe("listRunIds", () => {
  it("returns an empty array when state/workflows/ does not exist", async () => {
    const tmp = withTmpRondel();
    expect(await listRunIds(tmp.stateDir)).toEqual([]);
  });

  it("lists every run subdirectory by id", async () => {
    const tmp = withTmpRondel();
    await writeRunState(tmp.stateDir, makeRunState({ runId: RUN_ID }));
    await writeRunState(tmp.stateDir, makeRunState({ runId: OTHER_RUN_ID }));

    const ids = await listRunIds(tmp.stateDir);
    expect(ids.sort()).toEqual([RUN_ID, OTHER_RUN_ID].sort());
  });
});

describe("writeDefinitionSnapshot / readDefinitionSnapshot", () => {
  it("round-trips the frozen workflow definition", async () => {
    const tmp = withTmpRondel();
    // ensureRunDirectories first so the parent exists — matches runner usage.
    await ensureRunDirectories(tmp.stateDir, RUN_ID);
    const definition = {
      id: "demo",
      version: 1,
      inputs: {},
      steps: [{ id: "only", kind: "agent", agent: "writer", task: "do it" }],
    };
    await writeDefinitionSnapshot(tmp.stateDir, RUN_ID, definition);

    const read = await readDefinitionSnapshot(tmp.stateDir, RUN_ID);
    expect(read).toEqual(definition);
  });
});

describe("writeGateRecord / readGateRecord", () => {
  it("round-trips a pending gate record", async () => {
    const tmp = withTmpRondel();
    await ensureRunDirectories(tmp.stateDir, RUN_ID);
    const record = makeGateRecord();
    await writeGateRecord(tmp.stateDir, record);
    const read = await readGateRecord(tmp.stateDir, RUN_ID, record.gateId);
    expect(read).toEqual(record);
  });

  it("returns null when the gate record does not exist", async () => {
    const tmp = withTmpRondel();
    expect(await readGateRecord(tmp.stateDir, RUN_ID, "gate_0_missing")).toBeNull();
  });

  it("throws WorkflowStorageError on corrupt JSON", async () => {
    const tmp = withTmpRondel();
    mkdirSync(gateDirectory(tmp.stateDir, RUN_ID), { recursive: true });
    writeFileSync(gateRecordPath(tmp.stateDir, RUN_ID, "gate_1700000000000_xyz789"), "{broken");

    await expect(
      readGateRecord(tmp.stateDir, RUN_ID, "gate_1700000000000_xyz789"),
    ).rejects.toThrow(WorkflowStorageError);
  });
});

describe("listGateRecords", () => {
  it("returns an empty array when the gates directory is missing", async () => {
    const tmp = withTmpRondel();
    expect(await listGateRecords(tmp.stateDir, RUN_ID)).toEqual([]);
  });

  it("returns every gate record under a run, ignoring non-.json files", async () => {
    const tmp = withTmpRondel();
    await ensureRunDirectories(tmp.stateDir, RUN_ID);
    await writeGateRecord(
      tmp.stateDir,
      makeGateRecord({ gateId: "gate_1700000000000_xyz789" }),
    );
    await writeGateRecord(
      tmp.stateDir,
      makeGateRecord({ gateId: "gate_1700000000001_abc123" }),
    );
    // Non-JSON noise should be ignored.
    writeFileSync(`${gateDirectory(tmp.stateDir, RUN_ID)}/README.md`, "# notes");

    const records = await listGateRecords(tmp.stateDir, RUN_ID);
    expect(records.map((r) => r.gateId).sort()).toEqual(
      ["gate_1700000000000_xyz789", "gate_1700000000001_abc123"].sort(),
    );
  });
});
