// Memory-domain types (see apps/daemon/src/memory/).
// Pure type definitions — zero runtime imports.
//
// MEMORY.md is a BOUNDED INDEX: one line per durable fact (`- [date] fact`),
// hard-capped, injected at spawn. Details overflow into descriptively named
// topic files (memory/topics/<slug>.md, read on demand — "names are the
// retrieval"); daily episodic notes live at memory/YYYY-MM-DD.md and are
// written by the daemon's session-end snapshot listener, never injected.
// All of it is user space — the user can edit or delete any of these files;
// the framework only appends or rewrites through the tools with backups.

export type MemoryTarget = { kind: "index" } | { kind: "daily" } | { kind: "topic"; slug: string };

export interface MemoryWriteResult {
  readonly path: string;
  readonly backupId?: string;
  /** §5.5 legacy migration fired during this call. */
  readonly migrated?: boolean;
  /** e.g. threat-scan flags ("entry saved but will be masked at injection"). */
  readonly warnings?: readonly string[];
}

export type MemoryErrorCode =
  | "unknown_agent"
  | "invalid_target"
  | "invalid_entry"
  /** Consolidate-on-overflow: the error carries ALL current entries. */
  | "index_overflow"
  | "no_match"
  | "ambiguous_match";
