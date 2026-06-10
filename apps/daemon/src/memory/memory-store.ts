// MemoryStore — file I/O for the memory domain. No business logic, no hooks,
// no cross-domain imports; testable against a tmpdir.
//
// Layout (ALL USER SPACE, under the agent's workspace dir — the user can
// edit or delete any of it; the framework never silently rewrites):
//   MEMORY.md                — bounded index, one `- <fact>` line per entry
//   memory/YYYY-MM-DD.md     — daily episodic notes (append-only)
//   memory/topics/<slug>.md  — overflow detail files (append-only)
//
// The index is always REWRITTEN whole via atomicWriteFile so the on-disk
// form stays canonical; topic/daily files are append-only (a pre-image is
// always a strict prefix, so appends never need a backup).

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { atomicWriteFile } from "../shared/atomic-file.js";

export const TOPIC_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const MEMORY_INDEX_MAX_BYTES_DEFAULT = 8 * 1024;
export const MEMORY_ENTRY_MAX_CHARS = 500;

// --- paths ---

export function indexPath(agentDir: string): string {
  return join(agentDir, "MEMORY.md");
}

export function memoryDir(agentDir: string): string {
  return join(agentDir, "memory");
}

export function topicsDir(agentDir: string): string {
  return join(agentDir, "memory", "topics");
}

export function topicPath(agentDir: string, slug: string): string {
  if (!TOPIC_SLUG_RE.test(slug)) throw new Error(`invalid topic slug: ${JSON.stringify(slug)}`);
  return join(topicsDir(agentDir), `${slug}.md`);
}

export function dailyPath(agentDir: string, date: string): string {
  if (!DATE_RE.test(date)) throw new Error(`invalid date: ${JSON.stringify(date)}`);
  return join(memoryDir(agentDir), `${date}.md`);
}

// --- index entry codec (one line per fact) ---
// Canonical form: zero or more `- <text>` lines. Blank lines are tolerated on
// read, dropped on write. ANYTHING else (headings, prose, indented
// continuations) makes the file non-canonical → legacy migration path.

export interface ParsedIndex {
  readonly entries: readonly string[];
}

/** Returns null when the content does not round-trip (legacy/foreign format). */
export function parseIndex(content: string): ParsedIndex | null {
  const entries: string[] = [];
  for (const line of content.split("\n")) {
    if (line.trim().length === 0) continue;
    const m = /^- (.+)$/.exec(line);
    if (!m) return null;
    entries.push(m[1]!);
  }
  return { entries };
}

export function serializeIndex(entries: readonly string[]): string {
  return entries.length === 0 ? "" : entries.map((e) => `- ${e}`).join("\n") + "\n";
}

export function roundTrips(content: string): boolean {
  return parseIndex(content) !== null;
}

// --- reads ---

export async function readIndexFile(agentDir: string): Promise<string | null> {
  try {
    return await readFile(indexPath(agentDir), "utf-8");
  } catch {
    return null;
  }
}

export async function readDailyFile(agentDir: string, date: string): Promise<string | null> {
  try {
    return await readFile(dailyPath(agentDir, date), "utf-8");
  } catch {
    return null;
  }
}

// --- writes ---

export async function writeIndexFile(agentDir: string, content: string): Promise<void> {
  await mkdir(agentDir, { recursive: true });
  await atomicWriteFile(indexPath(agentDir), content);
}

export async function appendTopicFile(agentDir: string, slug: string, block: string): Promise<string> {
  const path = topicPath(agentDir, slug);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, block, "utf-8");
  return path;
}

export async function appendDailyFile(agentDir: string, date: string, block: string): Promise<string> {
  const path = dailyPath(agentDir, date);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, block, "utf-8");
  return path;
}
