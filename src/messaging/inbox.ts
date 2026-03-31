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
 * No locking needed — all writes go through the Bridge (single process).
 * Atomic writes (write-to-temp + rename) prevent corruption on crash.
 */

import { readFile, readdir, mkdir } from "node:fs/promises";
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

async function readInboxFile(path: string): Promise<InterAgentMessage[]> {
  try {
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as InterAgentMessage[];
  } catch {
    // File doesn't exist or is invalid — treat as empty inbox
    return [];
  }
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
  const messages = await readInboxFile(path);
  messages.push(message);
  await atomicWriteFile(path, JSON.stringify(messages, null, 2) + "\n");
}

/**
 * Remove a delivered message from an agent's inbox file.
 * No-op if the message isn't found (idempotent).
 */
export async function removeFromInbox(stateDir: string, agentName: string, messageId: string): Promise<void> {
  const path = inboxPath(stateDir, agentName);
  const messages = await readInboxFile(path);
  const filtered = messages.filter((m) => m.id !== messageId);

  if (filtered.length === messages.length) return; // not found — no-op

  if (filtered.length === 0) {
    // Clean up empty inbox file
    try {
      const { unlink } = await import("node:fs/promises");
      await unlink(path);
    } catch {
      // Already gone — fine
    }
  } else {
    await atomicWriteFile(path, JSON.stringify(filtered, null, 2) + "\n");
  }
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
