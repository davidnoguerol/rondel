/**
 * Disk-backed store for inbound channel attachments.
 *
 * Files staged here belong to a single conversation — keyed by
 * `(agent, chatId)` — and live under
 *   `<state>/attachments/<agent>/<chatId>/<messageId>-<rand>.<ext>`
 *
 * Per-conversation isolation is a Rondel invariant: each agent process
 * is spawned with `--add-dir <state>/attachments/<agent>/<chatId>`, so
 * the agent can `Read` files staged for *its* conversation and only
 * those.
 *
 * Retention: `cleanup(olderThanMs)` prunes files older than the cutoff.
 * Called at startup, on the daily cleanup interval (see daemon index
 * wiring), and opportunistically on every save so a busy chat doesn't
 * grow unboundedly between daily passes.
 *
 * The store deliberately mirrors the shape and idioms of
 * `FileHistoryStore` (`filesystem/file-history-store.ts`) — same
 * cleanup recipe, same graceful missing-dir handling, same per-agent
 * subtree layout. The two stores never share data; the parallel
 * structure just keeps the codebase coherent.
 */

import { randomBytes } from "node:crypto";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "../shared/logger.js";

/** Default retention: 24 h. Configurable per `cleanup()` call. */
export const DEFAULT_ATTACHMENT_RETENTION_MS = 24 * 60 * 60 * 1000;

export interface StagedAttachment {
  /** Absolute path on disk. */
  readonly path: string;
  /** Size in bytes. */
  readonly bytes: number;
}

export interface SaveOptions {
  /**
   * Telegram message id (or equivalent) — used as the filename stem so
   * a staged file is traceable back to the inbound update that produced
   * it during debugging.
   */
  readonly messageId: number | string;
  /**
   * Optional file extension *with* leading dot, e.g. `.jpg`. Empty
   * string or undefined means no extension. Sniffed-then-mapped MIME is
   * the natural source — the AttachmentService handles that.
   */
  readonly extension?: string;
}

export class AttachmentStore {
  private readonly log: Logger;

  constructor(
    /** Absolute path to `<state>/attachments`. */
    private readonly rootDir: string,
    log: Logger,
  ) {
    this.log = log.child("attachments");
  }

  /**
   * Absolute path of the per-conversation directory. Does NOT create
   * the directory — callers use `ensureConversationDir` when they need
   * the directory to exist (notably before `--add-dir`).
   */
  conversationDir(agent: string, chatId: string): string {
    return join(this.rootDir, sanitize(agent), sanitize(chatId));
  }

  /**
   * Make sure the per-conversation directory exists and return its
   * absolute path. Called at agent-process spawn so `--add-dir` points
   * at a real directory even before the first attachment lands.
   */
  async ensureConversationDir(agent: string, chatId: string): Promise<string> {
    const dir = this.conversationDir(agent, chatId);
    await mkdir(dir, { recursive: true });
    return dir;
  }

  /**
   * Persist `bytes` for a conversation. Returns the absolute path of
   * the staged file along with the byte length.
   *
   * Opportunistically prunes stale files (older than the default TTL)
   * on every save — same idea as OpenClaw's media store, scoped here to
   * the conversation directory only so the call is cheap.
   */
  async save(
    agent: string,
    chatId: string,
    bytes: Buffer,
    options: SaveOptions,
  ): Promise<StagedAttachment> {
    const dir = await this.ensureConversationDir(agent, chatId);
    const ext = normaliseExt(options.extension);
    const rand = randomBytes(4).toString("hex");
    const filename = `${String(options.messageId)}-${rand}${ext}`;
    const absPath = join(dir, filename);
    await writeFile(absPath, bytes);
    // Opportunistic local prune — bounded cost, no daemon-wide scan.
    void this.pruneConversation(agent, chatId, DEFAULT_ATTACHMENT_RETENTION_MS).catch(() => {});
    return { path: absPath, bytes: bytes.length };
  }

  /**
   * Remove files older than `olderThanMs` in a single conversation
   * subtree. Used by `save()` as a cheap rolling cleanup; the full
   * daemon-wide pass goes through `cleanup()`.
   */
  async pruneConversation(agent: string, chatId: string, olderThanMs: number): Promise<number> {
    const dir = this.conversationDir(agent, chatId);
    return await pruneDir(dir, olderThanMs);
  }

  /**
   * Remove staged files older than `olderThanMs` across every
   * `(agent, chatId)` subtree. Returns the count removed. Missing
   * parent dir → 0 (first-run safe).
   */
  async cleanup(olderThanMs: number = DEFAULT_ATTACHMENT_RETENTION_MS): Promise<number> {
    let agents: string[];
    try {
      agents = await readdir(this.rootDir);
    } catch {
      return 0;
    }
    let removed = 0;
    for (const agent of agents) {
      const agentDir = join(this.rootDir, agent);
      let chats: string[];
      try {
        chats = await readdir(agentDir);
      } catch {
        continue;
      }
      for (const chat of chats) {
        removed += await pruneDir(join(agentDir, chat), olderThanMs);
      }
    }
    if (removed > 0) {
      this.log.info(`Pruned ${removed} attachment(s) older than ${olderThanMs}ms`);
    }
    return removed;
  }

  /** Best-effort listing of staged files in a conversation — for tests / debug. */
  async list(agent: string, chatId: string): Promise<StagedAttachment[]> {
    const dir = this.conversationDir(agent, chatId);
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      return [];
    }
    const out: StagedAttachment[] = [];
    for (const name of files) {
      const abs = join(dir, name);
      try {
        const s = await stat(abs);
        if (s.isFile()) out.push({ path: abs, bytes: s.size });
      } catch {
        // Vanished between readdir and stat — ignore.
      }
    }
    return out;
  }
}

/**
 * Sanitise a path segment so a misbehaving agent name or chat id
 * cannot escape the attachments root via `..` or absolute paths.
 * Telegram chat ids are integer strings in practice, but the same gate
 * applies uniformly across channels.
 */
function sanitize(segment: string): string {
  return segment.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function normaliseExt(ext: string | undefined): string {
  if (!ext) return "";
  const trimmed = ext.trim();
  if (!trimmed) return "";
  return trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
}

async function pruneDir(dir: string, olderThanMs: number): Promise<number> {
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return 0;
  }
  const cutoff = Date.now() - olderThanMs;
  let removed = 0;
  for (const name of files) {
    const abs = join(dir, name);
    try {
      const s = await stat(abs);
      if (!s.isFile()) continue;
      if (s.mtimeMs < cutoff) {
        await rm(abs, { force: true });
        removed++;
      }
    } catch {
      // Race with another cleaner or external delete — skip.
    }
  }
  return removed;
}
