/**
 * Ledger reader.
 *
 * Reads and filters per-agent JSONL ledger files for the bridge
 * query endpoint and MCP tool. Supports filtering by agent, time
 * range, event kinds, and result limit.
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { LedgerEvent, LedgerEventKind } from "./ledger-types.js";
import { LEDGER_EVENT_KINDS } from "./ledger-types.js";

// ---------------------------------------------------------------------------
// Query interface
// ---------------------------------------------------------------------------

export interface LedgerQueryOptions {
  /** Filter by agent name. Omit to query all agents. */
  readonly agent?: string;
  /** Only events after this time. ISO 8601 or relative: "6h", "1d", "30m". */
  readonly since?: string;
  /** Filter by event kinds. */
  readonly kinds?: readonly string[];
  /** Max events to return (default 50, max 500). */
  readonly limit?: number;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

/**
 * Query the ledger. Returns events newest-first.
 */
export async function queryLedger(
  stateDir: string,
  options: LedgerQueryOptions,
): Promise<LedgerEvent[]> {
  const ledgerDir = join(stateDir, "ledger");
  const limit = Math.min(Math.max(options.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const sinceMs = options.since ? parseSince(options.since) : undefined;
  const kindSet = options.kinds?.length
    ? new Set(options.kinds.filter((k) => (LEDGER_EVENT_KINDS as readonly string[]).includes(k)))
    : undefined;

  // Determine which files to read
  const files = options.agent
    ? [`${options.agent}.jsonl`]
    : await listLedgerFiles(ledgerDir);

  // Read and parse all matching events
  const allEvents: LedgerEvent[] = [];

  for (const file of files) {
    const filePath = join(ledgerDir, file);
    const events = await readLedgerFile(filePath);

    for (const event of events) {
      if (sinceMs !== undefined && new Date(event.ts).getTime() < sinceMs) continue;
      if (kindSet && !kindSet.has(event.kind)) continue;
      allEvents.push(event);
    }
  }

  // Sort newest-first and apply limit
  allEvents.sort((a, b) => b.ts.localeCompare(a.ts));
  return allEvents.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function listLedgerFiles(ledgerDir: string): Promise<string[]> {
  try {
    const entries = await readdir(ledgerDir);
    return entries.filter((f) => f.endsWith(".jsonl"));
  } catch {
    return []; // directory doesn't exist yet
  }
}

async function readLedgerFile(filePath: string): Promise<LedgerEvent[]> {
  try {
    const content = await readFile(filePath, "utf-8");
    const events: LedgerEvent[] = [];
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line) as LedgerEvent);
      } catch {
        // skip malformed lines
      }
    }
    return events;
  } catch {
    return []; // file doesn't exist or is unreadable
  }
}

// ---------------------------------------------------------------------------
// Time parsing
// ---------------------------------------------------------------------------

/** Relative time units for "since" parameter. */
const RELATIVE_UNITS: Record<string, number> = {
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
};

/**
 * Parse a "since" value into a Unix timestamp (ms).
 * Accepts relative ("6h", "30m", "1d") or ISO 8601.
 */
function parseSince(since: string): number {
  const relativeMatch = /^(\d+)([mhd])$/.exec(since);
  if (relativeMatch) {
    const value = parseInt(relativeMatch[1], 10);
    const unit = relativeMatch[2];
    return Date.now() - value * RELATIVE_UNITS[unit];
  }
  // Try ISO 8601
  const ms = new Date(since).getTime();
  if (Number.isNaN(ms)) {
    throw new Error(`Invalid "since" value: ${since}. Use relative (6h, 1d) or ISO 8601.`);
  }
  return ms;
}
