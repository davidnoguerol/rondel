// Full-rebuild corpus walk — shared by the worker entrypoint (production)
// and the inline host (tests + fallback), so 100% of the logic is testable
// in-process without mocks.
//
// The whole build runs inside ONE transaction: WAL readers keep seeing the
// previous snapshot until COMMIT — never a half-built index. Malformed JSONL
// lines are skipped (same posture as loadTranscriptTurns).

import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { KbEntryRow, KbRole, KbSessionMode } from "../shared/types/knowledge.js";
import { openKbWrite, beginRebuild, insertEntry, finishRebuild, abortRebuild, KB_SCHEMA_VERSION } from "./kb-store.js";
import { redactText, stripMachineryEnvelope, isIndexableText } from "./kb-redact.js";

export interface AgentRebuildJob {
  readonly kind: "agent";
  readonly agent: string;
  readonly dbPath: string;
  /** state/transcripts/{agent} */
  readonly transcriptsAgentDir: string;
  /** Workspace dir holding MEMORY.md, memory/, knowledge/. */
  readonly agentDir: string;
  /** state/sessions.json — legacy agent-mail detection for gen-0/1 mirrors. */
  readonly sessionsJsonPath: string;
}

export interface OrgRebuildJob {
  readonly kind: "org";
  readonly org: string;
  readonly dbPath: string;
  /** {orgDir}/shared/knowledge */
  readonly sharedKnowledgeDir: string;
}

export type RebuildJob = AgentRebuildJob | OrgRebuildJob;

export interface RebuildStats {
  readonly rows: number;
  readonly sources: number;
  readonly durationMs: number;
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

/** Classify a mirror by header (gen-2 mode field, gen-0/1 heuristics) and
 *  decide whether to skip it entirely (heartbeat churn). */
export function classifySession(
  header: Record<string, unknown> | null,
  fileName: string,
  agentMailSessionIds: ReadonlySet<string>,
): { mode: KbSessionMode; conversationKey: string | null; skip: boolean } {
  const sessionId = fileName.endsWith(".jsonl") ? fileName.slice(0, -".jsonl".length) : fileName;

  // Heartbeat cron sessions are pure discipline churn — never indexed.
  if (sessionId.startsWith("cron_heartbeat")) return { mode: "cron", conversationKey: null, skip: true };

  if (header && header.type === "session_start" && header.version === 2) {
    const mode = (header.mode as KbSessionMode | undefined) ?? "unknown";
    const conversationKey = typeof header.conversationKey === "string" ? header.conversationKey : null;
    return { mode, conversationKey, skip: false };
  }

  // Legacy gen-0/1 heuristics.
  const chatId = header && typeof header.chatId === "string" ? header.chatId : "";
  const agentName = header && typeof header.agentName === "string" ? header.agentName : "";
  if (chatId === "agent-mail" || agentMailSessionIds.has(sessionId)) return { mode: "agent-mail", conversationKey: null, skip: false };
  if (chatId.startsWith("cron:") || sessionId.startsWith("cron_")) return { mode: "cron", conversationKey: null, skip: false };
  if (agentName.endsWith("/subagent") || sessionId.startsWith("sub_")) return { mode: "subagent", conversationKey: null, skip: false };
  return { mode: header ? "main" : "unknown", conversationKey: null, skip: false };
}

interface ExtractedEntry {
  readonly entryIndex: number;
  readonly role: KbRole;
  readonly ts: string | null;
  readonly text: string;
}

/**
 * Extract indexable rows from mirror JSONL lines (all generations).
 * `entryIndex` is the ABSOLUTE line index (header = 0) so provenance maps
 * 1:1 to a mirror line. Indexed: user text (envelope-stripped), assistant
 * text blocks, tool NAMES (v2 tool_use; never inputs), compaction summaries.
 * Not indexed: tool_result payloads, turn rollups, cli_session markers.
 */
export function extractEntries(lines: readonly string[]): ExtractedEntry[] {
  const out: ExtractedEntry[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const ts = typeof entry.timestamp === "string" ? entry.timestamp : null;

    if (entry.type === "user") {
      // gen-1/2 shape: { text }; gen-0 stream-json shape: { message: { content: [...] } }
      let text: string | undefined;
      if (typeof entry.text === "string") text = entry.text;
      else text = joinTextBlocks(entry);
      if (text === undefined) continue;
      text = stripResumeBlock(text);
      const stripped = stripMachineryEnvelope(text);
      if (stripped === null) continue;
      if (!isIndexableText(stripped)) continue;
      out.push({ entryIndex: i, role: "user", ts, text: redactText(stripped) });
      continue;
    }

    if (entry.type === "assistant") {
      const text = joinTextBlocks(entry);
      if (text === undefined || !isIndexableText(text)) continue;
      out.push({ entryIndex: i, role: "assistant", ts, text: redactText(text) });
      continue;
    }

    if (entry.type === "tool_use" && typeof entry.name === "string") {
      out.push({ entryIndex: i, role: "tool", ts, text: entry.name });
      continue;
    }

    if (entry.type === "compaction" && typeof entry.summary === "string" && entry.summary.length > 0) {
      out.push({ entryIndex: i, role: "compaction", ts, text: redactText(entry.summary) });
    }
  }
  return out;
}

/**
 * Strip the D11 resume prefix from first-turn user entries before indexing —
 * it quotes daily-note content that the memory collection already indexes;
 * duplicating it into the sessions corpus degrades recall precision.
 */
function stripResumeBlock(text: string): string {
  if (!text.startsWith("[Resume context loaded by Rondel]")) return text;
  const lastFence = text.lastIndexOf("END_QUOTED_NOTES");
  if (lastFence === -1) return text;
  return text.slice(lastFence + "END_QUOTED_NOTES".length).trimStart();
}

function joinTextBlocks(entry: Record<string, unknown>): string | undefined {
  const message = entry.message as { content?: unknown } | undefined;
  if (!message || !Array.isArray(message.content)) return undefined;
  const parts: string[] = [];
  for (const block of message.content as Array<{ type?: string; text?: string }>) {
    if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}

/** Split markdown into ##-heading sections; whole file when small/headingless. */
export function splitMarkdownSections(content: string): Array<{ index: number; text: string }> {
  if (content.length < 2048 || !/^##\s/m.test(content)) {
    return content.trim().length > 0 ? [{ index: 0, text: content }] : [];
  }
  const sections: Array<{ index: number; text: string }> = [];
  const parts = content.split(/^(?=##\s)/m);
  let index = 0;
  for (const part of parts) {
    if (part.trim().length === 0) continue;
    sections.push({ index: index++, text: part });
  }
  return sections;
}

// ---------------------------------------------------------------------------
// Corpus walk
// ---------------------------------------------------------------------------

export async function runRebuild(job: RebuildJob): Promise<RebuildStats> {
  const started = Date.now();
  // Corrupt-index self-heal (design §4.1): the index is a deletable cache,
  // so ANY failure to open/initialize it (SQLITE_NOTADB, corrupt WAL, stale
  // -shm) is resolved by deleting the file trio and retrying once.
  let db;
  try {
    db = openKbWrite(job.dbPath);
  } catch {
    const { rmSync } = await import("node:fs");
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        rmSync(job.dbPath + suffix, { force: true });
      } catch {
        /* */
      }
    }
    db = openKbWrite(job.dbPath);
  }
  let rows = 0;
  const sources = new Set<string>();
  try {
    beginRebuild(db);

    if (job.kind === "agent") {
      // --- sessions collection ---
      const agentMailIds = await loadAgentMailSessionIds(job.sessionsJsonPath, job.agent);
      const mirrorFiles = await listFiles(job.transcriptsAgentDir, (name) => name.endsWith(".jsonl"));
      for (const fileName of mirrorFiles) {
        const filePath = join(job.transcriptsAgentDir, fileName);
        let lines: string[];
        try {
          lines = (await readFile(filePath, "utf-8")).split("\n");
        } catch {
          continue;
        }
        let header: Record<string, unknown> | null = null;
        try {
          header = JSON.parse(lines[0] ?? "") as Record<string, unknown>;
        } catch {
          header = null;
        }
        const { mode, conversationKey, skip } = classifySession(header, fileName, agentMailIds);
        if (skip) continue;
        const sessionId = fileName.slice(0, -".jsonl".length);
        for (const e of extractEntries(lines)) {
          insertEntry(db, {
            collection: "sessions",
            sourceId: sessionId,
            entryIndex: e.entryIndex,
            agent: job.agent,
            conversationKey,
            mode,
            role: e.role,
            ts: e.ts,
            text: e.text,
          });
          rows++;
          sources.add(sessionId);
        }
      }

      // --- memory collection ---
      rows += await indexMarkdownTree(db, job.agent, "memory", job.agentDir, ["MEMORY.md"], join(job.agentDir, "memory"), sources);

      // --- agent-private collection ---
      rows += await indexMarkdownTree(db, job.agent, "agent-private", job.agentDir, [], join(job.agentDir, "knowledge"), sources);
    } else {
      // --- org-shared collection ---
      rows += await indexMarkdownTree(db, job.org, "org-shared", job.sharedKnowledgeDir, [], job.sharedKnowledgeDir, sources);
    }

    finishRebuild(db, { builtAt: new Date().toISOString(), schemaVersion: KB_SCHEMA_VERSION });
  } catch (err) {
    abortRebuild(db);
    throw err;
  } finally {
    db.close();
  }
  return { rows, sources: sources.size, durationMs: Date.now() - started };
}

async function indexMarkdownTree(
  db: ReturnType<typeof openKbWrite>,
  agent: string,
  collection: "memory" | "agent-private" | "org-shared",
  rootForRelative: string,
  explicitFiles: readonly string[],
  treeDir: string,
  sources: Set<string>,
): Promise<number> {
  let rows = 0;
  const files: string[] = [];
  for (const f of explicitFiles) {
    files.push(join(rootForRelative, f));
  }
  files.push(...(await walkTree(treeDir, (name) => name.endsWith(".md") || name.endsWith(".txt"))));

  for (const filePath of files) {
    let content: string;
    try {
      content = await readFile(filePath, "utf-8");
    } catch {
      continue;
    }
    const sourceId = relative(rootForRelative, filePath) || filePath;
    for (const section of splitMarkdownSections(content)) {
      if (!isIndexableText(section.text)) continue;
      insertEntry(db, {
        collection,
        sourceId,
        entryIndex: section.index,
        agent,
        conversationKey: null,
        mode: "section",
        role: "section",
        ts: null,
        text: redactText(section.text),
      });
      rows++;
      sources.add(sourceId);
    }
  }
  return rows;
}

async function listFiles(dir: string, filter: (name: string) => boolean): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isFile() && filter(e.name)).map((e) => e.name);
  } catch {
    return [];
  }
}

async function walkTree(dir: string, filter: (name: string) => boolean): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith(".")) continue;
      out.push(...(await walkTree(full, filter)));
    } else if (entry.isFile() && filter(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

async function loadAgentMailSessionIds(sessionsJsonPath: string, agent: string): Promise<ReadonlySet<string>> {
  try {
    const raw = JSON.parse(await readFile(sessionsJsonPath, "utf-8")) as Record<string, { sessionId?: string; chatId?: string; agentName?: string }>;
    const ids = new Set<string>();
    for (const entry of Object.values(raw)) {
      if (entry?.agentName === agent && entry.chatId === "agent-mail" && typeof entry.sessionId === "string") {
        ids.add(entry.sessionId);
      }
    }
    return ids;
  } catch {
    return new Set();
  }
}
