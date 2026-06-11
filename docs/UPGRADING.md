# Upgrading

Operator-facing release notes for changes that need a manual step. Newest
first. (Routine upgrades — `git pull`, `pnpm install`, restart the daemon —
need no entry here.)

## Memory & transcripts substrate (feature/memory-transcripts)

This release replaces whole-file memory writes and ad-hoc conversation
recall with the structured memory ops + knowledge-base retrieval system
(design: `docs/phase-2/00-memory-architecture-design.md`).

### Required: Claude CLI ≥ 2.1.170

The daemon logs an error at startup below this version. Older CLIs can
silently lose transcripts when the daemon was started from a shell that
inherited `CLAUDE*` environment variables, and lack the PostCompact /
auto-memory controls the substrate depends on. Upgrade with your usual
CLI install method, then restart the daemon.

### Required: Node ≥ 22.13.0

The knowledge index uses `node:sqlite` (FTS5). The daemon's `engines`
field now enforces this.

### Removed MCP tools: `rondel_memory_save`, `rondel_recall_user_conversation`

- `rondel_memory_save` (whole-file MEMORY.md overwrite) → replaced by the
  structured ops `rondel_memory_append` / `rondel_memory_replace` /
  `rondel_memory_remove`. Appends are blind-write-safe; a full index
  returns every entry so the agent consolidates on its own.
- `rondel_recall_user_conversation` → replaced by `rondel_kb_query`
  (browse shape, or a targeted full-text query).

Scaffold templates shipped with the daemon are already updated, but
**user-space agent files are yours and are not rewritten by the
framework**. Find stale references in your install with:

```sh
grep -rl 'rondel_memory_save\|rondel_recall_user_conversation' ~/.rondel/workspaces
```

Edit each hit (typically `AGENT.md`) to reference the replacements:

- "save to memory with `rondel_memory_save`" → "append durable facts with
  `rondel_memory_append`; edit with `rondel_memory_replace` /
  `rondel_memory_remove`"
- "recall the conversation with `rondel_recall_user_conversation`" →
  "search past sessions with `rondel_kb_query`"

### Automatic, no action needed (listed so nothing surprises you)

- **Legacy MEMORY.md migration**: the first structured write on a
  free-prose MEMORY.md snapshots it to file history and moves the prose
  to `memory/topics/legacy.md`, seeding the index with a pointer entry.
  No content is lost; agents distill it organically during heartbeats.
- **CLI auto-memory harvest-then-disable**: any content the CLI's native
  auto-memory accumulated is harvested into `memory/topics/` once, then
  auto-memory is disabled per spawn (`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`).
- **Knowledge index**: built automatically shortly after startup under
  `state/knowledge/`. It is a derived cache — safe to delete; it rebuilds.
- **Synthetic transcript retention**: cron / subagent / agent-mail
  session mirrors now age out after 30 days (live conversation tails are
  kept). Main conversations remain durable forever.
