import { appendFile, mkdir } from "node:fs/promises";
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
