/**
 * File-based store for heartbeat records.
 *
 * One JSON file per agent at `state/heartbeats/{agentName}.json`, fully
 * overwritten on each write. No history — the ledger is the append-only
 * log; this store answers "what is the agent's current state?"
 *
 * Mirrors the approval-store pattern:
 *   - `atomicWriteFile` for every write (temp + rename)
 *   - strict agent-name regex (defense-in-depth against path traversal
 *     if a bug ever lets a crafted name through the bridge boundary)
 *   - malformed records are logged and skipped, not thrown
 */

import { readFile, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile } from "../shared/atomic-file.js";
import { HeartbeatRecordSchema } from "../bridge/schemas.js";
import type { HeartbeatRecord } from "../shared/types/heartbeats.js";
import type { Logger } from "../shared/logger.js";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export interface HeartbeatPaths {
  readonly dir: string;
}

/**
 * Matches the agentName rule in `bridge/schemas.ts` (`^[a-zA-Z0-9][a-zA-Z0-9_-]*$`).
 * Anything that isn't a valid agent name never reaches disk — prevents
 * path traversal via crafted names and makes malformed filenames
 * impossible to commit.
 */
const AGENT_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

function assertAgentName(agent: string): void {
  if (!AGENT_NAME_RE.test(agent)) {
    throw new Error(`Invalid agent name: ${agent}`);
  }
}

function recordPath(paths: HeartbeatPaths, agent: string): string {
  assertAgentName(agent);
  return join(paths.dir, `${agent}.json`);
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

export async function writeHeartbeat(paths: HeartbeatPaths, record: HeartbeatRecord): Promise<void> {
  await atomicWriteFile(recordPath(paths, record.agent), JSON.stringify(record, null, 2) + "\n");
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

async function readJsonFile(path: string, log?: Logger): Promise<HeartbeatRecord | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch {
    return undefined;
  }
  try {
    const json: unknown = JSON.parse(raw);
    const result = HeartbeatRecordSchema.safeParse(json);
    if (!result.success) {
      (log ?? console).error(`[heartbeats] invalid record at ${path}: ${result.error.message}`);
      return undefined;
    }
    return result.data as HeartbeatRecord;
  } catch {
    (log ?? console).error(`[heartbeats] malformed JSON at ${path}`);
    return undefined;
  }
}

export async function readHeartbeat(paths: HeartbeatPaths, agent: string, log?: Logger): Promise<HeartbeatRecord | undefined> {
  return readJsonFile(recordPath(paths, agent), log);
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

/**
 * Read every record in the heartbeats directory. Missing directory
 * is treated as empty — the service creates it at init() but reads
 * shouldn't assume init ran first.
 */
export async function listHeartbeats(paths: HeartbeatPaths, log?: Logger): Promise<HeartbeatRecord[]> {
  let files: string[];
  try {
    files = await readdir(paths.dir);
  } catch {
    return [];
  }

  const records: HeartbeatRecord[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const record = await readJsonFile(join(paths.dir, file), log);
    if (record) records.push(record);
  }
  return records;
}

// ---------------------------------------------------------------------------
// Remove
// ---------------------------------------------------------------------------

/**
 * Delete an agent's heartbeat record. Idempotent — missing file is
 * treated as success. Called from the admin delete-agent flow.
 */
export async function removeHeartbeat(paths: HeartbeatPaths, agent: string): Promise<void> {
  try {
    await unlink(recordPath(paths, agent));
  } catch {
    // Already gone — fine.
  }
}
