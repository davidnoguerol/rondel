/**
 * Atomic file write utility.
 *
 * State files (sessions.json, cron-state.json, lockfile) must survive
 * crashes mid-write. A direct writeFile() that's interrupted leaves a
 * truncated or empty file — on next startup, JSON.parse() fails and
 * the data is lost.
 *
 * This module writes to a temporary file in the same directory, then
 * renames it over the target. rename() is atomic on POSIX when source
 * and destination are on the same filesystem (guaranteed here since the
 * temp file is a sibling of the target).
 */

import { writeFile, rename, unlink, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Write data to filePath atomically via write-to-temp + rename.
 * Creates parent directories if they don't exist.
 */
export async function atomicWriteFile(filePath: string, data: string): Promise<void> {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });

  const tmpPath = `${filePath}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(tmpPath, data, "utf-8");
    await rename(tmpPath, filePath);
  } catch (err) {
    // Clean up the temp file if rename failed (e.g. permissions)
    await unlink(tmpPath).catch(() => {});
    throw err;
  }
}
