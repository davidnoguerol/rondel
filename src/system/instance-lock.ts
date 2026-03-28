/**
 * Singleton instance guard.
 *
 * Prevents two FlowClaw processes from running on the same project
 * simultaneously. Two instances would double-poll Telegram (duplicate
 * messages), race on session index writes (corruption), and spawn
 * duplicate conversation processes.
 *
 * Uses a PID lockfile at ~/.flowclaw/state/flowclaw.lock.
 * On startup, checks if the PID in the lockfile is still alive.
 * If alive → abort with clear error. If dead → stale lock, overwrite.
 */

import { readFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile } from "../shared/atomic-file.js";
import type { Logger } from "../shared/logger.js";

export interface LockData {
  pid: number;
  startedAt: number;
  bridgeUrl: string;
  logPath: string;
}

function lockPath(stateDir: string): string {
  return join(stateDir, "flowclaw.lock");
}

/**
 * Read and parse the instance lock file.
 * Returns null if the file doesn't exist, is invalid, or the PID is dead (stale).
 */
export function readInstanceLock(stateDir: string): LockData | null {
  const path = lockPath(stateDir);
  try {
    const raw = readFileSync(path, "utf-8");
    const data = JSON.parse(raw) as LockData;
    if (!data.pid || !data.startedAt) return null;

    // Check if process is alive
    try {
      process.kill(data.pid, 0);
      return data; // Process exists
    } catch {
      return null; // PID dead — stale lock
    }
  } catch {
    return null; // File doesn't exist or is invalid
  }
}

/**
 * Acquire the project-level instance lock.
 * Throws if another FlowClaw instance is already running for this project.
 */
export async function acquireInstanceLock(stateDir: string, log: Logger, logPath?: string): Promise<void> {
  const path = lockPath(stateDir);

  if (existsSync(path)) {
    try {
      const existing = JSON.parse(readFileSync(path, "utf-8"));
      const pid = existing.pid as number;

      // Check if the process is still alive (signal 0 = existence check only)
      try {
        process.kill(pid, 0);
        // Process exists — another instance is running
        log.error(`FlowClaw is already running for this project (PID ${pid}). Stop it first with: flowclaw stop`);
        process.exit(1);
      } catch {
        // process.kill threw — PID doesn't exist. Stale lock, safe to overwrite.
        log.warn(`Stale lock file found (PID ${pid} is not running) — overwriting`);
      }
    } catch {
      // Lock file exists but is invalid/unreadable — overwrite it
      log.warn("Invalid lock file — overwriting");
    }
  }

  // Write our PID to the lock file
  const lockData: LockData = {
    pid: process.pid,
    startedAt: Date.now(),
    bridgeUrl: "",
    logPath: logPath ?? "",
  };
  await atomicWriteFile(path, JSON.stringify(lockData, null, 2));
  log.info(`Instance lock acquired (PID ${process.pid})`);
}

/**
 * Update the bridge URL in the lock file.
 * Called after the bridge starts so `flowclaw status` can find it.
 */
export async function updateLockBridgeUrl(stateDir: string, bridgeUrl: string): Promise<void> {
  const path = lockPath(stateDir);
  try {
    const raw = readFileSync(path, "utf-8");
    const data = JSON.parse(raw);
    if (data.pid !== process.pid) return; // Not our lock
    data.bridgeUrl = bridgeUrl;
    await atomicWriteFile(path, JSON.stringify(data, null, 2));
  } catch {
    // Best-effort — lock might not exist yet
  }
}

/**
 * Release the instance lock.
 * Synchronous — safe to call from signal handlers where async may not complete.
 * Only deletes the lock if it still belongs to us (guards against race conditions).
 */
export function releaseInstanceLock(stateDir: string, log: Logger): void {
  const path = lockPath(stateDir);
  try {
    if (!existsSync(path)) return;

    const existing = JSON.parse(readFileSync(path, "utf-8"));
    if (existing.pid !== process.pid) return; // Not our lock — don't delete

    unlinkSync(path);
    log.info("Instance lock released");
  } catch {
    // Best-effort cleanup — if it fails, the stale-lock detection handles it on next startup
  }
}
