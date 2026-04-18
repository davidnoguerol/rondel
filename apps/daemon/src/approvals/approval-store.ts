/**
 * File-based store for approval records.
 *
 * Pending and resolved approvals live in two sibling directories
 * under `state/approvals/`. An approval lives in `pending/` until
 * it's resolved, then the pending file is unlinked and a new file
 * is written to `resolved/`. This mirrors the inbox store pattern
 * at `apps/daemon/src/messaging/inbox.ts` — file-based state,
 * atomic writes, debuggable from the command line.
 *
 * Concurrency note: Rondel serialises approval resolution through
 * `ApprovalService.resolve` (single in-process owner), so we don't
 * need the per-file lock the inbox module uses. If we ever get
 * multiple writers on the same record, add a lock mirrored after
 * `withInboxLock`.
 */

import { readFile, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile } from "../shared/atomic-file.js";
import { ApprovalRecordSchema } from "../bridge/schemas.js";
import type { ApprovalRecord } from "../shared/types/approvals.js";
import type { Logger } from "../shared/logger.js";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export interface ApprovalPaths {
  readonly pendingDir: string;
  readonly resolvedDir: string;
}

/**
 * Validate that a requestId matches the expected format (`appr_<epoch>_<hex>`).
 * Prevents path traversal via crafted IDs in bridge HTTP endpoints.
 */
const REQUEST_ID_RE = /^appr_\d+_[a-f0-9]+$/;

function assertRequestId(requestId: string): void {
  if (!REQUEST_ID_RE.test(requestId)) {
    throw new Error(`Invalid requestId format: ${requestId}`);
  }
}

function pendingPath(paths: ApprovalPaths, requestId: string): string {
  assertRequestId(requestId);
  return join(paths.pendingDir, `${requestId}.json`);
}

function resolvedPath(paths: ApprovalPaths, requestId: string): string {
  assertRequestId(requestId);
  return join(paths.resolvedDir, `${requestId}.json`);
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

export async function writePending(paths: ApprovalPaths, record: ApprovalRecord): Promise<void> {
  await atomicWriteFile(pendingPath(paths, record.requestId), JSON.stringify(record, null, 2) + "\n");
}

export async function writeResolved(paths: ApprovalPaths, record: ApprovalRecord): Promise<void> {
  await atomicWriteFile(resolvedPath(paths, record.requestId), JSON.stringify(record, null, 2) + "\n");
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

async function readJsonFile(path: string, log?: Logger): Promise<ApprovalRecord | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch {
    return undefined;
  }
  try {
    const json: unknown = JSON.parse(raw);
    const result = ApprovalRecordSchema.safeParse(json);
    if (!result.success) {
      // Quarantined by swallowing — the file is malformed but we don't want
      // to crash the bridge on a single bad record. Log and move on.
      // TODO(hitl-future): match inbox.ts and rename to .corrupted.<ts>.
      (log ?? console).error(`[approvals] invalid record at ${path}: ${result.error.message}`);
      return undefined;
    }
    return result.data as ApprovalRecord;
  } catch {
    (log ?? console).error(`[approvals] malformed JSON at ${path}`);
    return undefined;
  }
}

export async function readPending(paths: ApprovalPaths, requestId: string, log?: Logger): Promise<ApprovalRecord | undefined> {
  return readJsonFile(pendingPath(paths, requestId), log);
}

export async function readResolved(paths: ApprovalPaths, requestId: string, log?: Logger): Promise<ApprovalRecord | undefined> {
  return readJsonFile(resolvedPath(paths, requestId), log);
}

/** Read either pending OR resolved, whichever exists. Resolved wins on a tie. */
export async function readAny(paths: ApprovalPaths, requestId: string, log?: Logger): Promise<ApprovalRecord | undefined> {
  const resolved = await readResolved(paths, requestId, log);
  if (resolved) return resolved;
  return readPending(paths, requestId, log);
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

async function listDir(dir: string, log?: Logger): Promise<ApprovalRecord[]> {
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return []; // directory missing = empty
  }

  const records: ApprovalRecord[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const record = await readJsonFile(join(dir, file), log);
    if (record) records.push(record);
  }
  return records.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function listPending(paths: ApprovalPaths, log?: Logger): Promise<ApprovalRecord[]> {
  return listDir(paths.pendingDir, log);
}

export async function listResolved(paths: ApprovalPaths, limit?: number, log?: Logger): Promise<ApprovalRecord[]> {
  const all = await listDir(paths.resolvedDir, log);
  // listDir sorts ascending — reverse to newest-first for the UI.
  const sorted = all.reverse();
  return limit !== undefined ? sorted.slice(0, limit) : sorted;
}

// ---------------------------------------------------------------------------
// Remove
// ---------------------------------------------------------------------------

export async function removePending(paths: ApprovalPaths, requestId: string): Promise<void> {
  try {
    await unlink(pendingPath(paths, requestId));
  } catch {
    // Already gone — fine.
  }
}
