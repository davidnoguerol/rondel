/**
 * File-based store for task records, claim lockfiles, and audit logs.
 *
 * On-disk layout (per org):
 *   {rootDir}/{org}/task_<epoch>_<hex>.json          ← mutable record
 *   {rootDir}/{org}/.claims/task_<epoch>_<hex>.claim ← O_EXCL lockfile
 *   {rootDir}/{org}/audit/task_<epoch>_<hex>.jsonl   ← append-only log
 *   {rootDir}/{org}/.pending-approvals.json          ← owned by pending-approval-store
 *
 * Pure file I/O — no business logic, no hook emission. The service
 * (`task-service.ts`) calls in for primitives and owns everything else.
 *
 * Concurrency: the ONLY contested operation is `tryClaim`, which uses
 * `writeFile(..., {flag: "wx"})` — POSIX `O_WRONLY | O_CREAT | O_EXCL`.
 * First caller wins, everyone else gets `EEXIST`. Same idiomatic
 * primitive CortexOS uses; Rondel introduces it here (if a second
 * domain needs it, promote to `shared/`).
 *
 * Mirrors the `approvals/approval-store.ts` defence-in-depth:
 *   - Task-id regex gate on every path derivation.
 *   - Malformed records logged + returned as `undefined` (not thrown).
 */

import { appendFile, mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile } from "../shared/atomic-file.js";
import {
  TaskAuditEntrySchema,
  TaskRecordSchema,
} from "../bridge/schemas.js";
import type { TaskAuditEntry, TaskRecord } from "../shared/types/tasks.js";
import type { Logger } from "../shared/logger.js";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export interface TaskPaths {
  readonly rootDir: string;
}

/**
 * Matches the format produced by `newTaskId()` in `task-service.ts`.
 * Gatekeeps every path derivation so a crafted id can never escape the
 * org directory.
 */
const TASK_ID_RE = /^task_\d+_[a-f0-9]+$/;

/**
 * Same regex as `agentName` in `bridge/schemas.ts`. Used by `orgDir()`
 * to reject crafted org names before they reach disk. "global" is a
 * valid org by these rules, as is any registered org name.
 */
const ORG_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

export function assertTaskId(id: string): void {
  if (!TASK_ID_RE.test(id)) {
    throw new Error(`Invalid task id: ${id}`);
  }
}

export function assertOrgName(org: string): void {
  if (!ORG_NAME_RE.test(org)) {
    throw new Error(`Invalid org name: ${org}`);
  }
}

export function orgDir(paths: TaskPaths, org: string): string {
  assertOrgName(org);
  return join(paths.rootDir, org);
}

export function claimsDir(paths: TaskPaths, org: string): string {
  return join(orgDir(paths, org), ".claims");
}

export function auditDir(paths: TaskPaths, org: string): string {
  return join(orgDir(paths, org), "audit");
}

export function pendingApprovalsPath(paths: TaskPaths, org: string): string {
  return join(orgDir(paths, org), ".pending-approvals.json");
}

function taskPath(paths: TaskPaths, org: string, id: string): string {
  assertTaskId(id);
  return join(orgDir(paths, org), `${id}.json`);
}

function claimPath(paths: TaskPaths, org: string, id: string): string {
  assertTaskId(id);
  return join(claimsDir(paths, org), `${id}.claim`);
}

function auditPath(paths: TaskPaths, org: string, id: string): string {
  assertTaskId(id);
  return join(auditDir(paths, org), `${id}.jsonl`);
}

// ---------------------------------------------------------------------------
// Directory init
// ---------------------------------------------------------------------------

/**
 * Create the per-org directories idempotently. Safe to call on every
 * service entrypoint that could be the first writer for a new org.
 */
export async function ensureOrgDirs(paths: TaskPaths, org: string): Promise<void> {
  await mkdir(orgDir(paths, org), { recursive: true });
  await mkdir(claimsDir(paths, org), { recursive: true });
  await mkdir(auditDir(paths, org), { recursive: true });
}

/**
 * Enumerate org subdirectories under rootDir. Skips files. Missing
 * rootDir → empty list.
 */
export async function listOrgs(paths: TaskPaths): Promise<readonly string[]> {
  try {
    const entries = await readdir(paths.rootDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && ORG_NAME_RE.test(e.name))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Task record — write / read / list / remove
// ---------------------------------------------------------------------------

export async function writeTask(paths: TaskPaths, record: TaskRecord): Promise<void> {
  await ensureOrgDirs(paths, record.org);
  await atomicWriteFile(taskPath(paths, record.org, record.id), JSON.stringify(record, null, 2) + "\n");
}

async function readTaskFile(
  path: string,
  log?: Logger,
): Promise<TaskRecord | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch {
    return undefined;
  }
  try {
    const json: unknown = JSON.parse(raw);
    const result = TaskRecordSchema.safeParse(json);
    if (!result.success) {
      (log ?? console).error(`[tasks] invalid record at ${path}: ${result.error.message}`);
      return undefined;
    }
    return result.data as TaskRecord;
  } catch {
    (log ?? console).error(`[tasks] malformed JSON at ${path}`);
    return undefined;
  }
}

export async function readTask(
  paths: TaskPaths,
  org: string,
  id: string,
  log?: Logger,
): Promise<TaskRecord | undefined> {
  return readTaskFile(taskPath(paths, org, id), log);
}

/**
 * Read every task record in an org directory. Missing dir → empty. The
 * service layer filters and orders; the store only returns the raw set.
 */
export async function listTasks(
  paths: TaskPaths,
  org: string,
  log?: Logger,
): Promise<readonly TaskRecord[]> {
  const dir = orgDir(paths, org);
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }
  const records: TaskRecord[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    if (!TASK_ID_RE.test(file.slice(0, -".json".length))) continue;
    const record = await readTaskFile(join(dir, file), log);
    if (record) records.push(record);
  }
  return records;
}

/**
 * List every task across every org. Used by `TaskService.init()` to
 * reconcile pending-approval entries and by `onAgentDeleted` cleanup.
 */
export async function listAllTasks(
  paths: TaskPaths,
  log?: Logger,
): Promise<readonly TaskRecord[]> {
  const orgs = await listOrgs(paths);
  const all: TaskRecord[] = [];
  for (const org of orgs) {
    const records = await listTasks(paths, org, log);
    all.push(...records);
  }
  return all;
}

export async function removeTask(paths: TaskPaths, org: string, id: string): Promise<void> {
  try {
    await unlink(taskPath(paths, org, id));
  } catch {
    // Already gone — fine.
  }
}

// ---------------------------------------------------------------------------
// Claim lockfile — atomic O_EXCL
// ---------------------------------------------------------------------------

export interface ClaimResult {
  readonly claimed: boolean;
  readonly holderAgent?: string;
  readonly holderAt?: string;
}

/**
 * Attempt to claim `id` for `agent`. Atomic: the first caller creates
 * the lockfile via `O_EXCL`; every subsequent caller gets `EEXIST` and
 * reads the existing holder from the file body.
 *
 * Idempotent for the same-agent re-claim: if the lockfile already
 * records the requesting agent, return `{claimed: true}` without
 * re-writing.
 */
export async function tryClaim(
  paths: TaskPaths,
  org: string,
  id: string,
  agent: string,
): Promise<ClaimResult> {
  await ensureOrgDirs(paths, org);
  const lockPath = claimPath(paths, org, id);
  const ts = new Date().toISOString();
  const body = `${agent}\t${ts}\n`;
  try {
    // `wx` = O_WRONLY | O_CREAT | O_EXCL. Rejects with EEXIST if the
    // file already exists. This is the whole concurrency primitive.
    await writeFile(lockPath, body, { flag: "wx" });
    return { claimed: true };
  } catch (err) {
    if (isEexistError(err)) {
      const existing = await readClaimFile(lockPath);
      if (existing && existing.agent === agent) {
        // Same agent already holds the claim — treat as success.
        return { claimed: true };
      }
      return {
        claimed: false,
        holderAgent: existing?.agent,
        holderAt: existing?.ts,
      };
    }
    throw err;
  }
}

export async function releaseClaim(paths: TaskPaths, org: string, id: string): Promise<void> {
  try {
    await unlink(claimPath(paths, org, id));
  } catch {
    // Already gone — fine.
  }
}

/**
 * Return the current holder of the claim lock, or `undefined` if the
 * task isn't claimed.
 */
export async function readClaim(
  paths: TaskPaths,
  org: string,
  id: string,
): Promise<{ agent: string; ts: string } | undefined> {
  return readClaimFile(claimPath(paths, org, id));
}

async function readClaimFile(path: string): Promise<{ agent: string; ts: string } | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch {
    return undefined;
  }
  const line = raw.split("\n", 1)[0] ?? "";
  const tab = line.indexOf("\t");
  if (tab <= 0) return undefined;
  return { agent: line.slice(0, tab), ts: line.slice(tab + 1) };
}

function isEexistError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "EEXIST"
  );
}

// ---------------------------------------------------------------------------
// Audit log — append-only JSONL
// ---------------------------------------------------------------------------

export async function appendAudit(
  paths: TaskPaths,
  org: string,
  id: string,
  entry: TaskAuditEntry,
): Promise<void> {
  await ensureOrgDirs(paths, org);
  const line = JSON.stringify(entry) + "\n";
  await appendFile(auditPath(paths, org, id), line);
}

/**
 * Read a task's audit log. Malformed lines are logged and skipped; the
 * good lines are returned in order. Missing file → empty list.
 */
export async function readAudit(
  paths: TaskPaths,
  org: string,
  id: string,
  log?: Logger,
): Promise<readonly TaskAuditEntry[]> {
  const path = auditPath(paths, org, id);
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch {
    return [];
  }
  const entries: TaskAuditEntry[] = [];
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    try {
      const json: unknown = JSON.parse(line);
      const result = TaskAuditEntrySchema.safeParse(json);
      if (!result.success) {
        (log ?? console).error(`[tasks] invalid audit line in ${path}: ${result.error.message}`);
        continue;
      }
      entries.push(result.data as TaskAuditEntry);
    } catch {
      (log ?? console).error(`[tasks] malformed audit line in ${path}`);
    }
  }
  return entries;
}
