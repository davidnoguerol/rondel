import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { Logger } from "./logger.js";

/**
 * Append-only JSONL transcript writer.
 *
 * Captures full conversation history to disk — user messages, assistant
 * responses (with tool calls and tool results), costs, errors. Raw
 * stream-json events are written as-is for maximum fidelity.
 *
 * Follows OpenClaw's pattern: first line is a session header,
 * subsequent lines are events. Files are append-only, never rewritten.
 */

/**
 * Resolve the transcript file path for a given agent and session.
 * Format: {transcriptsDir}/{agentName}/{sessionId}.jsonl
 */
export function resolveTranscriptPath(
  transcriptsDir: string,
  agentName: string,
  sessionId: string,
): string {
  return join(transcriptsDir, agentName, `${sessionId}.jsonl`);
}

/**
 * Create a new transcript file and write the session header as the first line.
 * Creates parent directories if they don't exist.
 */
export async function createTranscript(
  transcriptPath: string,
  header: Record<string, unknown>,
  log: Logger,
): Promise<void> {
  await mkdir(dirname(transcriptPath), { recursive: true });
  const line = JSON.stringify(header) + "\n";
  await appendFile(transcriptPath, line, "utf-8");
  log.info(`Transcript created: ${transcriptPath}`);
}

/**
 * Append an entry to an existing transcript file.
 *
 * Fire-and-forget: errors are logged but never thrown.
 * This ensures transcript writes never block or crash the agent.
 */
export function appendTranscriptEntry(
  transcriptPath: string,
  entry: Record<string, unknown>,
  log: Logger,
): void {
  const line = JSON.stringify(entry) + "\n";
  appendFile(transcriptPath, line, "utf-8").catch((err) => {
    log.warn(`Transcript write failed: ${err instanceof Error ? err.message : String(err)}`);
  });
}

/**
 * Ordered user/assistant turn extracted from a transcript.
 * Used by bridge endpoints that replay a conversation for the web UI.
 */
export interface TranscriptTurn {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly ts?: string;
}

/**
 * Parse a transcript JSONL file and extract the ordered user/assistant text
 * turns. Malformed lines are skipped. The transcript wire format mirrors what
 * `createTranscript` and `appendTranscriptEntry` write — the same schema is
 * documented in CLAUDE.md and docs/CLI-REFERENCE.md.
 *
 * Returns an empty array when the transcript file does not exist (a fresh
 * conversation with no recorded turns). Any other read error — permission
 * denied, I/O failure, disk going away — is rethrown so callers can surface
 * a real 500 rather than silently returning an empty view that looks like a
 * healthy fresh session.
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
