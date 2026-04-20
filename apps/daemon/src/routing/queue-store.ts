/**
 * File-based per-conversation queue persistence.
 *
 * Each conversation gets a JSON file at `state/queues/{encoded-key}.json`
 * containing an array of pending `QueuedMessage`s. Disk is the source of
 * truth — the Router's in-memory `Map<ConversationKey, QueuedMessage[]>`
 * is a cache that must be reconciled from disk on startup.
 *
 * Lifecycle (matches the inbox pattern — see `messaging/inbox.ts`):
 * 1. Enqueue: `append()` writes message to disk (atomic), then Router
 *    pushes to in-memory.
 * 2. Drain: Router shifts in-memory, dispatches to the agent process,
 *    then `removeFirst()` removes from disk. At-least-once — a crash
 *    between dispatch and disk-remove replays on recovery.
 * 3. Recovery: `readAll()` on startup rebuilds the in-memory map.
 * 4. Clear: `/stop`, `/restart`, `/new` each wipe both caches.
 *
 * Concurrency: every read-modify-write goes through a per-path `AsyncLock`
 * chain. The Router also holds a per-conversation lock around enqueue and
 * drain, so the disk write is already serialized from that direction —
 * this store's own lock is defence in depth and protects against direct
 * callers (tests, future admin tools) that bypass the Router.
 *
 * Crash safety: `atomicWriteFile` (temp + rename) prevents partial writes.
 * Corrupted files (parse error, wrong shape) are quarantined to
 * `{file}.corrupted.{timestamp}` rather than silently overwritten.
 *
 * Filename encoding: conversation keys contain `:` which is invalid on
 * some filesystems. We `encodeURIComponent` the key for the filename and
 * decode on read.
 */

import { readFile, readdir, mkdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile } from "../shared/atomic-file.js";
import { AsyncLock } from "../shared/async-lock.js";
import type { QueuedMessage, ConversationKey } from "../shared/types/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function queueDir(stateDir: string): string {
  return join(stateDir, "queues");
}

function encodeKey(key: ConversationKey): string {
  return encodeURIComponent(key);
}

/**
 * Decode a filename back into a conversation key. Validates shape (at least
 * two colons after decoding). Returns null for malformed filenames so
 * recovery can skip them without crashing.
 */
function decodeKey(fileBase: string): ConversationKey | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(fileBase);
  } catch {
    return null;
  }
  const first = decoded.indexOf(":");
  if (first < 0) return null;
  const second = decoded.indexOf(":", first + 1);
  if (second < 0) return null;
  return decoded as ConversationKey;
}

function queuePath(stateDir: string, key: ConversationKey): string {
  return join(queueDir(stateDir), `${encodeKey(key)}.json`);
}

/**
 * Per-file serial lock. Shared across all QueueStore instances (keyed by
 * absolute path) so tests that construct multiple stores against the same
 * tmpdir don't race each other.
 */
const queueLock = new AsyncLock();

async function quarantineCorruptedQueue(path: string, reason: string): Promise<void> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const quarantinePath = `${path}.corrupted.${timestamp}`;
  try {
    await rename(path, quarantinePath);
    console.error(`[queue-store] quarantined corrupted file: ${path} → ${quarantinePath} (${reason})`);
  } catch {
    // File already gone, or rename failed — fine, next read returns [].
  }
}

async function readQueueFile(path: string): Promise<QueuedMessage[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch {
    return []; // file doesn't exist — fresh queue
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    await quarantineCorruptedQueue(path, "parse-error");
    return [];
  }

  if (!Array.isArray(parsed)) {
    await quarantineCorruptedQueue(path, "not-an-array");
    return [];
  }

  return parsed as QueuedMessage[];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export class QueueStore {
  constructor(private readonly stateDir: string) {}

  /** Ensure the queues directory exists. Called once at startup. */
  async ensureDir(): Promise<void> {
    await mkdir(queueDir(this.stateDir), { recursive: true });
  }

  /**
   * Read every persisted queue. Used on startup to rebuild the Router's
   * in-memory view. Skips files with malformed names or invalid payloads
   * (both are quarantined on next read).
   */
  async readAll(): Promise<Map<ConversationKey, QueuedMessage[]>> {
    const dir = queueDir(this.stateDir);
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      return new Map();
    }

    const out = new Map<ConversationKey, QueuedMessage[]>();
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const base = file.slice(0, -".json".length);
      const key = decodeKey(base);
      if (!key) continue;
      const messages = await readQueueFile(queuePath(this.stateDir, key));
      if (messages.length > 0) out.set(key, messages);
    }
    return out;
  }

  /**
   * Append a message to a conversation's queue file.
   * Caller is responsible for enforcing any upstream size cap — the
   * store writes whatever it's given.
   */
  async append(key: ConversationKey, msg: QueuedMessage): Promise<void> {
    const path = queuePath(this.stateDir, key);
    return queueLock.withLock(path, async () => {
      const messages = await readQueueFile(path);
      messages.push(msg);
      await atomicWriteFile(path, JSON.stringify(messages, null, 2) + "\n");
    });
  }

  /**
   * Remove and return the first message from a conversation's queue.
   * Deletes the file when the queue empties (mirrors the inbox pattern).
   */
  async removeFirst(key: ConversationKey): Promise<QueuedMessage | undefined> {
    const path = queuePath(this.stateDir, key);
    return queueLock.withLock(path, async () => {
      const messages = await readQueueFile(path);
      if (messages.length === 0) return undefined;
      const first = messages.shift();
      if (messages.length === 0) {
        await unlink(path).catch(() => {});
      } else {
        await atomicWriteFile(path, JSON.stringify(messages, null, 2) + "\n");
      }
      return first;
    });
  }

  /**
   * Remove all messages for a conversation. Used by `/stop`, `/restart`,
   * `/new` — the user explicitly asks for a clean slate. Idempotent: no
   * error if the file never existed.
   */
  async clear(key: ConversationKey): Promise<void> {
    const path = queuePath(this.stateDir, key);
    return queueLock.withLock(path, async () => {
      await unlink(path).catch(() => {});
    });
  }
}
