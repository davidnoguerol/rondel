/**
 * File-backed persistence for workflow runs and gate records.
 *
 * On-disk layout (mirrors state/ledger/, state/inboxes/ conventions):
 *
 *   state/workflows/{runId}/
 *     run.json                  — WorkflowRunState (atomic writes)
 *     definition.snapshot.json  — frozen definition at run start
 *     artifacts/                — files referenced by steps (see artifact-store.ts)
 *     gates/{gateId}.json       — GateRecord (atomic writes)
 *
 * Every write is atomic via `shared/atomic-file.ts` so a crash mid-write
 * leaves either the old value or the new value, never a partial. Reads are
 * Zod-validated at the boundary — corrupt files fail loudly with a clear
 * path rather than silently producing malformed state.
 */

import { readFile, readdir, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile } from "../shared/atomic-file.js";
import type { WorkflowRunState, GateRecord } from "../shared/types/index.js";
import { WorkflowRunStateSchema, GateRecordSchema } from "../bridge/schemas.js";

export class WorkflowStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowStorageError";
  }
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** Absolute directory for a workflow run (`state/workflows/{runId}`). */
export function runDirectory(stateDir: string, runId: string): string {
  return join(stateDir, "workflows", runId);
}

/** Absolute artifact folder for a run. */
export function artifactDirectory(stateDir: string, runId: string): string {
  return join(runDirectory(stateDir, runId), "artifacts");
}

/** Absolute gate folder for a run. */
export function gateDirectory(stateDir: string, runId: string): string {
  return join(runDirectory(stateDir, runId), "gates");
}

/** Absolute run.json path. */
export function runStatePath(stateDir: string, runId: string): string {
  return join(runDirectory(stateDir, runId), "run.json");
}

/** Absolute definition snapshot path. */
export function definitionSnapshotPath(stateDir: string, runId: string): string {
  return join(runDirectory(stateDir, runId), "definition.snapshot.json");
}

/** Create artifact/ and gates/ subdirs for a run if they don't exist. */
export async function ensureRunDirectories(stateDir: string, runId: string): Promise<void> {
  await mkdir(artifactDirectory(stateDir, runId), { recursive: true });
  await mkdir(gateDirectory(stateDir, runId), { recursive: true });
}

// ---------------------------------------------------------------------------
// Run state
// ---------------------------------------------------------------------------

/** Persist run state atomically. Creates parent directories if needed. */
export async function writeRunState(stateDir: string, state: WorkflowRunState): Promise<void> {
  await atomicWriteFile(
    runStatePath(stateDir, state.runId),
    JSON.stringify(state, null, 2),
  );
}

/**
 * Load run state from disk.
 *
 * Returns `null` if the file is absent (unknown run id). Throws
 * `WorkflowStorageError` if the file exists but fails Zod validation —
 * corrupt state is louder than silent than recovery-by-guessing.
 */
export async function readRunState(
  stateDir: string,
  runId: string,
): Promise<WorkflowRunState | null> {
  const path = runStatePath(stateDir, runId);
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new WorkflowStorageError(`Corrupt run.json at ${path}: ${msg}`);
  }

  const result = WorkflowRunStateSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; ");
    throw new WorkflowStorageError(`Invalid run.json at ${path}: ${issues}`);
  }
  return result.data as unknown as WorkflowRunState;
}

/** List all known run ids by scanning `state/workflows/`. */
export async function listRunIds(stateDir: string): Promise<string[]> {
  const root = join(stateDir, "workflows");
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Definition snapshot
// ---------------------------------------------------------------------------

/**
 * Freeze a workflow definition alongside its run. Editing the source JSON
 * mid-run must not affect the running execution — same precedent as agent
 * config being cloned at spawn time.
 */
export async function writeDefinitionSnapshot(
  stateDir: string,
  runId: string,
  definition: unknown,
): Promise<void> {
  await atomicWriteFile(
    definitionSnapshotPath(stateDir, runId),
    JSON.stringify(definition, null, 2),
  );
}

export async function readDefinitionSnapshot(
  stateDir: string,
  runId: string,
): Promise<unknown> {
  const path = definitionSnapshotPath(stateDir, runId);
  const raw = await readFile(path, "utf-8");
  return JSON.parse(raw);
}

// ---------------------------------------------------------------------------
// Gate records
// ---------------------------------------------------------------------------

export function gateRecordPath(stateDir: string, runId: string, gateId: string): string {
  return join(gateDirectory(stateDir, runId), `${gateId}.json`);
}

export async function writeGateRecord(stateDir: string, record: GateRecord): Promise<void> {
  await atomicWriteFile(
    gateRecordPath(stateDir, record.runId, record.gateId),
    JSON.stringify(record, null, 2),
  );
}

export async function readGateRecord(
  stateDir: string,
  runId: string,
  gateId: string,
): Promise<GateRecord | null> {
  const path = gateRecordPath(stateDir, runId, gateId);
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new WorkflowStorageError(`Corrupt gate record at ${path}: ${msg}`);
  }

  const result = GateRecordSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; ");
    throw new WorkflowStorageError(`Invalid gate record at ${path}: ${issues}`);
  }
  return result.data as unknown as GateRecord;
}

export async function listGateRecords(
  stateDir: string,
  runId: string,
): Promise<GateRecord[]> {
  const dir = gateDirectory(stateDir, runId);
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const records: GateRecord[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const gateId = entry.name.replace(/\.json$/, "");
    const record = await readGateRecord(stateDir, runId, gateId);
    if (record) records.push(record);
  }
  return records;
}
