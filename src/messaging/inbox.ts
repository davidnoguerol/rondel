/**
 * File-based inbox for inter-agent message persistence.
 *
 * Each agent gets a JSON file at `state/inboxes/{agentName}.json` containing
 * an array of pending (undelivered) messages. The inbox is the source of truth
 * for delivery — push via sendOrQueue is an optimization for speed.
 *
 * Lifecycle:
 * 1. Send: appendToInbox() writes message to disk (atomic)
 * 2. Deliver: push via router.deliverAgentMail() (immediate)
 * 3. Confirm: removeFromInbox() removes after successful delivery
 * 4. Recovery: readAllInboxes() on startup delivers anything left pending
 *
 * Concurrency: every read-modify-write on a given inbox file goes through
 * `withInboxLock`, a per-file promise chain. This is defence in depth — the
 * Bridge already serializes most writes, but the invariant is load-bearing
 * (a lost message breaks inter-agent messaging silently) and the lock is
 * cheap, so we enforce it at the module boundary.
 *
 * Crash safety: atomic writes (write-to-temp + rename) prevent corruption
 * on crash. Corrupted files (from an older crash, manual edit, or disk
 * fault) are quarantined to `{file}.corrupted.{timestamp}` on first read
 * so they don't get silently overwritten by the next append.
 */

import { readFile, readdir, mkdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile } from "../shared/atomic-file.js";
import type { InterAgentMessage } from "../shared/types/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function inboxDir(stateDir: string): string {
  return join(stateDir, "inboxes");
}

function inboxPath(stateDir: string, agentName: string): string {
  return join(inboxDir(stateDir), `${agentName}.json`);
}

/**
 * Per-inbox serial lock. Chains reads/writes to the same file so concurrent
 * appendToInbox / removeFromInbox calls can't interleave and lose data.
 *
 * The Map is keyed by absolute path, grows with unique agent names (bounded),
 * and entries are just promise chains — no held data. No eviction needed.
 */
const inboxLocks = new Map<string, Promise<unknown>>();

async function withInboxLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const prev = inboxLocks.get(path) ?? Promise.resolve();
  // .then(fn, fn) runs `fn` whether the previous operation resolved OR
  // rejected — a prior failure must not deadlock later writes.
  const next = prev.then(fn, fn);
  // Store a rejection-swallowed view so the chain never propagates errors
  // to subsequent callers (they only see their own fn's errors).
  inboxLocks.set(path, next.catch(() => undefined));
  return next;
}

/**
 * Quarantine a corrupted inbox file so the next `appendToInbox` doesn't
 * silently overwrite it with `[]`. Renames to `{path}.corrupted.{ts}`.
 * Best-effort: if the rename fails (e.g., file vanished), we log and move
 * on — the next read will simply see an empty inbox.
 */
async function quarantineCorruptedInbox(path: string, reason: string): Promise<void> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const quarantinePath = `${path}.corrupted.${timestamp}`;
  try {
    await rename(path, quarantinePath);
    console.error(`[inbox] quarantined corrupted file: ${path} → ${quarantinePath} (${reason})`);
  } catch {
    // File already gone, or rename failed — fine, next read returns [].
  }
}

async function readInboxFile(path: string): Promise<InterAgentMessage[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch {
    return []; // file doesn't exist — fresh inbox
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    await quarantineCorruptedInbox(path, "parse-error");
    return [];
  }

  if (!Array.isArray(parsed)) {
    await quarantineCorruptedInbox(path, "not-an-array");
    return [];
  }

  return parsed as InterAgentMessage[];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Ensure the inboxes directory exists. Called once at startup.
 */
export async function ensureInboxDir(stateDir: string): Promise<void> {
  await mkdir(inboxDir(stateDir), { recursive: true });
}

/**
 * Append a message to an agent's inbox file.
 * Creates the file if it doesn't exist.
 */
export async function appendToInbox(stateDir: string, message: InterAgentMessage): Promise<void> {
  const path = inboxPath(stateDir, message.to);
  return withInboxLock(path, async () => {
    const messages = await readInboxFile(path);
    messages.push(message);
    await atomicWriteFile(path, JSON.stringify(messages, null, 2) + "\n");
  });
}

/**
 * Remove a delivered message from an agent's inbox file.
 * No-op if the message isn't found (idempotent).
 */
export async function removeFromInbox(stateDir: string, agentName: string, messageId: string): Promise<void> {
  const path = inboxPath(stateDir, agentName);
  return withInboxLock(path, async () => {
    const messages = await readInboxFile(path);
    const filtered = messages.filter((m) => m.id !== messageId);

    if (filtered.length === messages.length) return; // not found — no-op

    if (filtered.length === 0) {
      // Clean up empty inbox file
      try {
        await unlink(path);
      } catch {
        // Already gone — fine
      }
    } else {
      await atomicWriteFile(path, JSON.stringify(filtered, null, 2) + "\n");
    }
  });
}

/**
 * Read all pending messages across all agent inboxes.
 * Used at startup to recover undelivered messages.
 */
export async function readAllInboxes(stateDir: string): Promise<InterAgentMessage[]> {
  const dir = inboxDir(stateDir);
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return []; // directory doesn't exist yet
  }

  const all: InterAgentMessage[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const messages = await readInboxFile(join(dir, file));
    all.push(...messages);
  }

  return all;
}
