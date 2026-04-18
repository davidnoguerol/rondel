/**
 * Disk-backed backup store for the first-class filesystem tool suite.
 *
 * Every successful `rondel_write_file`, `rondel_edit_file`, and
 * `rondel_multi_edit_file` that overwrites an existing file first captures
 * the pre-image here. Backups live under
 *   `<state>/file-history/<agent>/<pathHash>-<ts>.pre`
 * with a sidecar `<backupId>.meta.json` recording the original absolute
 * path. The sidecar avoids having to reverse the hash in `list()`.
 *
 * Retention: `cleanup(olderThanMs)` prunes backups older than the cutoff.
 * Called at startup and then on a daily interval (see daemon index wiring).
 *
 * The store is intentionally minimal — it exists to recover from a bad
 * agent edit, not to be a general-purpose history system.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile } from "../shared/atomic-file.js";
import type { Logger } from "../shared/logger.js";

export interface BackupEntry {
  /** Filename stem (no extension). Used as the public id. */
  readonly backupId: string;
  /** Absolute path of the file this backup was taken from. */
  readonly originalPath: string;
  /** ISO 8601 timestamp taken at backup time. */
  readonly createdAt: string;
  /** Size of the backup (pre-image) in bytes. */
  readonly sizeBytes: number;
}

/** Default retention: 7 days. */
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export class FileHistoryStore {
  private readonly log: Logger;

  constructor(private readonly stateDir: string, log: Logger) {
    this.log = log.child("file-history");
  }

  private agentDir(agent: string): string {
    return join(this.stateDir, "file-history", agent);
  }

  /**
   * Short, stable hash of an absolute path. First 16 hex chars is ample —
   * we only need uniqueness per-agent, and collisions produce at worst
   * redundant entries in `list()` (still correct via the meta sidecar).
   */
  private pathHash(originalPath: string): string {
    return createHash("sha256").update(originalPath).digest("hex").slice(0, 16);
  }

  private backupFilename(originalPath: string, ts: string): string {
    // ISO timestamps contain `:` which is fine on POSIX but a dedicated
    // footgun on Windows and some tooling. Replace with `-` up front.
    const safeTs = ts.replace(/:/g, "-");
    return `${this.pathHash(originalPath)}-${safeTs}.pre`;
  }

  /**
   * Back up `oldContent` for `originalPath` under the given agent. Writes
   * both the pre-image and a `<backupId>.meta.json` sidecar. Returns the
   * backup id.
   */
  async backup(agent: string, originalPath: string, oldContent: string): Promise<string> {
    const ts = new Date().toISOString();
    const name = this.backupFilename(originalPath, ts);
    const backupId = name.replace(/\.pre$/, "");
    const dir = this.agentDir(agent);
    await mkdir(dir, { recursive: true });
    await atomicWriteFile(join(dir, name), oldContent);
    await atomicWriteFile(
      join(dir, `${backupId}.meta.json`),
      JSON.stringify({ originalPath, createdAt: ts }, null, 2) + "\n",
    );
    return backupId;
  }

  /**
   * List backups for an agent, newest first. Optionally filter by
   * `originalPath`. Orphan backups (missing meta sidecar) are silently
   * skipped — they can't be restored anyway.
   */
  async list(agent: string, originalPath?: string): Promise<BackupEntry[]> {
    const dir = this.agentDir(agent);
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      return [];
    }
    const entries: BackupEntry[] = [];
    const targetHash = originalPath ? this.pathHash(originalPath) : undefined;
    for (const file of files) {
      if (!file.endsWith(".pre")) continue;
      const backupId = file.replace(/\.pre$/, "");
      if (targetHash && !backupId.startsWith(`${targetHash}-`)) continue;
      const metaPath = join(dir, `${backupId}.meta.json`);
      let meta: { originalPath: string; createdAt: string } | null = null;
      try {
        meta = JSON.parse(await readFile(metaPath, "utf-8")) as {
          originalPath: string;
          createdAt: string;
        };
      } catch {
        continue; // orphan backup, skip
      }
      const s = await stat(join(dir, file));
      entries.push({
        backupId,
        originalPath: meta.originalPath,
        createdAt: meta.createdAt,
        sizeBytes: s.size,
      });
    }
    // Sort by createdAt descending (newest first). String compare on ISO
    // timestamps is correct.
    return entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * Read a backup back out. Returns the recorded originalPath and the
   * pre-image content. Callers are responsible for any rewrite — the
   * store never modifies live files.
   */
  async restore(agent: string, backupId: string): Promise<{ originalPath: string; content: string }> {
    const dir = this.agentDir(agent);
    const metaRaw = await readFile(join(dir, `${backupId}.meta.json`), "utf-8");
    const meta = JSON.parse(metaRaw) as { originalPath: string; createdAt: string };
    const content = await readFile(join(dir, `${backupId}.pre`), "utf-8");
    return { originalPath: meta.originalPath, content };
  }

  /**
   * Remove backups older than `olderThanMs`. Iterates every agent's
   * history folder. Returns the count removed. Missing parent dir → 0.
   */
  async cleanup(olderThanMs: number = DEFAULT_RETENTION_MS): Promise<number> {
    const root = join(this.stateDir, "file-history");
    let agents: string[];
    try {
      agents = await readdir(root);
    } catch {
      return 0;
    }
    const cutoff = Date.now() - olderThanMs;
    let removed = 0;
    for (const agent of agents) {
      const entries = await this.list(agent);
      for (const e of entries) {
        if (new Date(e.createdAt).getTime() < cutoff) {
          await rm(join(this.agentDir(agent), `${e.backupId}.pre`), { force: true });
          await rm(join(this.agentDir(agent), `${e.backupId}.meta.json`), { force: true });
          removed++;
        }
      }
    }
    if (removed > 0) {
      this.log.info(`Pruned ${removed} backup(s) older than ${olderThanMs}ms`);
    }
    return removed;
  }
}
