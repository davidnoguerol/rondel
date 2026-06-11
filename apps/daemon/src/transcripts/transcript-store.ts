// TranscriptStore — file I/O for the transcripts domain. No business logic,
// no hooks, no cross-domain imports; testable against a tmpdir.
//
// Owns three on-disk artifacts under {transcriptsDir}:
//   {agent}/{sessionId}.jsonl              — append-only mirror (gen 0/1/2)
//   {agent}/archive/{sessionId}.cli.jsonl  — copies of the CLI's own JSONLs
//   {agent}/sessions-index.json            — per-agent conversation genealogy
//
// Write discipline (repo invariant): every mirror append for a given path is
// serialized through one AsyncLock chain, so concurrent large payloads can
// never interleave mid-line. Callers enqueue fire-and-forget; the lock
// preserves enqueue order; the optional onWritten callback fires only after
// the line is durably appended (the service emits its dirty signal there).
// Readers still skip malformed lines as a backstop.

import { appendFile, copyFile, mkdir, readdir, readFile, rename, rm, stat, unlink } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { AsyncLock } from "../shared/async-lock.js";
import { atomicWriteFile } from "../shared/atomic-file.js";
import type { Logger } from "../shared/logger.js";
import type { AgentGenealogy, MirrorEntry, MirrorHeader, SessionLink, TranscriptMode, TranscriptTurn } from "../shared/types/transcripts.js";

/** Bounded metadata extracted from a mirror file without loading it fully. */
export interface MirrorMeta {
  readonly sessionId: string;
  /** Classified mode. Gen-2 headers carry it; gen-0/1 headers are inferred
   *  (chatId "agent-mail" / "cron:*", agentName "*\/subagent", filename
   *  prefix). Undefined = unclassifiable → treated as durable. */
  readonly mode?: TranscriptMode;
  readonly conversationKey?: string;
  readonly cliSessionId?: string;
  readonly cliTranscriptPath?: string;
  /** Spawn cwd recorded by the cli_session entry (derivation fallback). */
  readonly cwd?: string;
  readonly mtimeMs: number;
  readonly sizeBytes: number;
}

export type ArchiveOutcome = "copied" | "fresh" | "source_missing";

// ---------------------------------------------------------------------------
// Path + reader helpers (module-level: also used by the bridge)
// ---------------------------------------------------------------------------

/** Agent names and session ids become file-system path segments — and the
 *  bridge passes both straight from URL params. Reject traversal/separators
 *  outright rather than sanitizing (internal ids are CLI UUIDs, sub_*,
 *  cron_*; anything else is a caller bug or an attack). */
const PATH_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

function safeSegment(value: string, label: string): string {
  if (!PATH_SEGMENT_RE.test(value) || value.includes("..")) {
    throw new Error(`invalid ${label} for transcript path: ${JSON.stringify(value)}`);
  }
  return value;
}

/** Mirror file path: {transcriptsDir}/{agentName}/{sessionId}.jsonl */
export function resolveTranscriptPath(transcriptsDir: string, agentName: string, sessionId: string): string {
  return join(transcriptsDir, safeSegment(agentName, "agent"), `${safeSegment(sessionId, "sessionId")}.jsonl`);
}

/**
 * Parse a mirror JSONL file (any generation) and extract the ordered
 * user/assistant text turns. Malformed lines and non-text entry types
 * (tool_use, turn, …) are skipped.
 *
 * Returns [] when the file does not exist (fresh conversation). Any other
 * read error is rethrown so callers surface a real failure rather than an
 * empty view that looks like a healthy fresh session.
 */
export async function loadTranscriptTurns(transcriptPath: string): Promise<TranscriptTurn[]> {
  let content: string;
  try {
    content = await readFile(transcriptPath, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") return [];
    throw err;
  }

  const turns: TranscriptTurn[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    const ts = typeof entry.timestamp === "string" ? entry.timestamp : undefined;

    if (entry.type === "user" && typeof entry.text === "string") {
      turns.push({ role: "user", text: entry.text, ts });
      continue;
    }

    if (entry.type === "assistant") {
      const message = entry.message as { content?: unknown } | undefined;
      if (!message || !Array.isArray(message.content)) continue;
      const textParts: string[] = [];
      for (const block of message.content as Array<{ type?: string; text?: string }>) {
        if (block?.type === "text" && typeof block.text === "string") {
          textParts.push(block.text);
        }
      }
      if (textParts.length > 0) {
        turns.push({ role: "assistant", text: textParts.join("\n"), ts });
      }
    }
  }

  return turns;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class TranscriptStore {
  private readonly appendLock = new AsyncLock();
  private readonly genealogyLock = new AsyncLock();

  constructor(
    private readonly transcriptsDir: string,
    private readonly log: Logger,
  ) {}

  // --- paths ---

  mirrorPath(agent: string, sessionId: string): string {
    return resolveTranscriptPath(this.transcriptsDir, agent, sessionId);
  }

  archivePath(agent: string, sessionId: string): string {
    return join(this.transcriptsDir, safeSegment(agent, "agent"), "archive", `${safeSegment(sessionId, "sessionId")}.cli.jsonl`);
  }

  genealogyPath(agent: string): string {
    return join(this.transcriptsDir, safeSegment(agent, "agent"), "sessions-index.json");
  }

  // --- mirror writes ---

  /** Write the gen-2 header as the first line. No-ops if the mirror already
   *  exists (resumed session). Serialized on the same per-path chain as
   *  appends, so the header always lands before any entry. */
  async createMirror(agent: string, sessionId: string, header: MirrorHeader): Promise<void> {
    const path = this.mirrorPath(agent, sessionId);
    return this.appendLock.withLock(path, async () => {
      await mkdir(dirname(path), { recursive: true });
      try {
        await stat(path);
        return; // exists — never rewrite an established mirror
      } catch {
        /* fresh file */
      }
      await appendFile(path, JSON.stringify(header) + "\n", "utf-8");
    });
  }

  /** Fire-and-forget append, serialized per path. Errors are logged, never
   *  thrown — capture must not block or crash the agent loop. `onWritten`
   *  fires only after the line is durably on disk. */
  appendEntry(agent: string, sessionId: string, entry: MirrorEntry, onWritten?: () => void): void {
    const path = this.mirrorPath(agent, sessionId);
    const line = JSON.stringify(entry) + "\n";
    void this.appendLock
      .withLock(path, async () => {
        try {
          await appendFile(path, line, "utf-8");
        } catch (err) {
          // Resumed sessions skip createMirror; tolerate a missing dir once.
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
          await mkdir(dirname(path), { recursive: true });
          await appendFile(path, line, "utf-8");
        }
      })
      .then(() => onWritten?.())
      .catch((err) => {
        this.log.warn(`Mirror append failed (${path}): ${err instanceof Error ? err.message : String(err)}`);
      });
  }

  /** Resolves when every append enqueued so far for this mirror has settled.
   *  Test/shutdown aid — production callers never await appends. */
  async flushMirror(agent: string, sessionId: string): Promise<void> {
    await this.appendLock.withLock(this.mirrorPath(agent, sessionId), async () => {});
  }

  /** Resolves when every append + genealogy write enqueued so far (all
   *  sessions) has settled. Shutdown calls this, raced against a short
   *  timeout, so in-flight mirror lines land before the process exits. */
  async settle(): Promise<void> {
    await Promise.all([this.appendLock.settled(), this.genealogyLock.settled()]);
  }

  // --- mirror reads ---

  /**
   * Scan a mirror for its header and latest cli_session entry. Reads the
   * whole file line-by-line but only JSON-parses candidate lines (our own
   * writes serialize `type` first, so a cheap prefix test filters).
   */
  async readMirrorMeta(agent: string, sessionId: string): Promise<MirrorMeta | undefined> {
    const path = this.mirrorPath(agent, sessionId);
    let st;
    try {
      st = await stat(path);
    } catch {
      return undefined;
    }
    let mode: TranscriptMode | undefined;
    let conversationKey: string | undefined;
    let cliSessionId: string | undefined;
    let cliTranscriptPath: string | undefined;
    let cwd: string | undefined;

    const rl = createInterface({ input: createReadStream(path, { encoding: "utf-8" }), crlfDelay: Infinity });
    let first = true;
    try {
      for await (const line of rl) {
        if (first) {
          first = false;
          try {
            const header = JSON.parse(line) as Record<string, unknown>;
            if (header.type === "session_start") {
              if (header.version === 2) {
                mode = header.mode as TranscriptMode | undefined;
                conversationKey = typeof header.conversationKey === "string" ? header.conversationKey : undefined;
              } else {
                mode = classifyLegacyHeader(header, sessionId);
              }
            }
          } catch {
            /* unparseable header — fall through to filename classification */
          }
          if (mode === undefined) mode = classifyByFilename(sessionId);
          continue;
        }
        if (!line.startsWith('{"type":"cli_session"')) continue;
        try {
          const entry = JSON.parse(line) as { cliSessionId?: string; cliTranscriptPath?: string; cwd?: string };
          if (typeof entry.cliSessionId === "string") cliSessionId = entry.cliSessionId;
          if (typeof entry.cliTranscriptPath === "string") cliTranscriptPath = entry.cliTranscriptPath;
          if (typeof entry.cwd === "string") cwd = entry.cwd;
        } catch {
          /* skip malformed */
        }
      }
    } finally {
      rl.close();
    }
    return { sessionId, mode, conversationKey, cliSessionId, cliTranscriptPath, cwd, mtimeMs: st.mtimeMs, sizeBytes: st.size };
  }

  /** Agent directories that exist under the transcripts root. */
  async listAgents(): Promise<string[]> {
    try {
      const entries = await readdir(this.transcriptsDir, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory() && !e.name.startsWith("_") && !e.name.startsWith(".")).map((e) => e.name);
    } catch {
      return [];
    }
  }

  /** Session ids with a mirror file for this agent (newest first by mtime). */
  async listMirrors(agent: string): Promise<string[]> {
    const dir = join(this.transcriptsDir, agent);
    try {
      const entries = await readdir(dir);
      const withTimes = await Promise.all(
        entries
          .filter((name) => name.endsWith(".jsonl"))
          .map(async (name) => {
            const st = await stat(join(dir, name)).catch(() => undefined);
            return { sessionId: name.slice(0, -".jsonl".length), mtimeMs: st?.mtimeMs ?? 0 };
          }),
      );
      return withTimes.sort((a, b) => b.mtimeMs - a.mtimeMs).map((e) => e.sessionId);
    } catch {
      return [];
    }
  }

  /** Remove a session's mirror AND its archive twin (synthetic-TTL prune). */
  async deleteMirror(agent: string, sessionId: string): Promise<void> {
    await unlink(this.mirrorPath(agent, sessionId)).catch(() => {});
    await rm(this.archivePath(agent, sessionId), { force: true }).catch(() => {});
  }

  // --- CLI JSONL archive ---

  /** Copy the CLI's transcript into the archive if the source is newer or
   *  larger than the existing copy. Atomic (temp + rename) and idempotent —
   *  the daily sweep re-invokes this so a truncated copy self-heals. */
  async archiveCliTranscript(agent: string, sessionId: string, sourcePath: string): Promise<ArchiveOutcome> {
    let src;
    try {
      src = await stat(sourcePath);
    } catch {
      return "source_missing";
    }
    const dest = this.archivePath(agent, sessionId);
    try {
      const existing = await stat(dest);
      if (existing.size >= src.size && existing.mtimeMs >= src.mtimeMs) return "fresh";
    } catch {
      /* no archive yet */
    }
    await mkdir(dirname(dest), { recursive: true });
    const tmp = `${dest}.tmp-${process.pid}-${Date.now()}`;
    try {
      await copyFile(sourcePath, tmp);
      await rename(tmp, dest);
    } catch (err) {
      await unlink(tmp).catch(() => {});
      throw err;
    }
    return "copied";
  }

  // --- genealogy ---

  async readGenealogy(agent: string): Promise<AgentGenealogy> {
    try {
      const raw = await readFile(this.genealogyPath(agent), "utf-8");
      const parsed = JSON.parse(raw) as AgentGenealogy;
      return typeof parsed === "object" && parsed !== null ? parsed : {};
    } catch {
      return {};
    }
  }

  /** Append a session link to a conversation's chain. Idempotent: a link
   *  whose sessionId matches the current chain tail is skipped. Persisted
   *  before resolving (persist-before-ack). */
  async appendSessionLink(agent: string, conversationKey: string, link: SessionLink): Promise<void> {
    const path = this.genealogyPath(agent);
    return this.genealogyLock.withLock(path, async () => {
      const genealogy = await this.readGenealogy(agent);
      const chain = genealogy[conversationKey] ?? [];
      if (chain.length > 0 && chain[chain.length - 1]!.sessionId === link.sessionId) return;
      genealogy[conversationKey] = [...chain, link];
      await mkdir(dirname(path), { recursive: true });
      await atomicWriteFile(path, JSON.stringify(genealogy, null, 2));
    });
  }
}

// ---------------------------------------------------------------------------
// Legacy classification (gen-0/1 mirrors predate the mode field)
// ---------------------------------------------------------------------------

function classifyLegacyHeader(header: Record<string, unknown>, sessionId: string): TranscriptMode | undefined {
  const chatId = typeof header.chatId === "string" ? header.chatId : "";
  const agentName = typeof header.agentName === "string" ? header.agentName : "";
  if (chatId === "agent-mail") return "agent-mail";
  if (chatId.startsWith("cron:")) return "cron";
  if (agentName.endsWith("/subagent")) return "subagent";
  return classifyByFilename(sessionId) ?? "main";
}

function classifyByFilename(sessionId: string): TranscriptMode | undefined {
  if (sessionId.startsWith("sub_")) return "subagent";
  if (sessionId.startsWith("cron_")) return "cron";
  return undefined;
}
