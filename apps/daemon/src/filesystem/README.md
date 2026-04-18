# filesystem — daemon-side state for first-class file tools

This directory owns the two stores that back Rondel's first-class
filesystem tool suite (`rondel_read_file`, `rondel_write_file`,
`rondel_edit_file`, `rondel_multi_edit_file` — see
[../tools/](../tools/)):

- **`ReadFileStateStore`** — in-memory session-scoped map of
  `(agent, sessionId, path) → { contentHash, readAt }`. Recorded after
  every successful non-truncated `rondel_read_file`. Consulted by
  write/edit/multi-edit before overwriting: no record or hash drift
  against on-disk content escalates to human approval with reason
  `write_without_read`. Keyed on sessionId (not chatId) so `/new`
  invalidates previous reads — the invariant is "you must have read
  the current version *in this session*."

- **`FileHistoryStore`** — disk-backed pre-image backups at
  `state/file-history/{agent}/{pathHash}-{ts}.pre` with a
  `{backupId}.meta.json` sidecar recording the original path. Captured
  **before every overwrite of an existing file** — zero exceptions,
  even for tiny changes. Retention: 7 days, pruned at startup + once
  every 24 h via the `cleanup()` method (scheduled from
  `apps/daemon/src/index.ts`).

## Endpoint surface

The bridge exposes these as HTTP endpoints so the MCP tool
implementations (which run in the per-agent MCP server process)
can consult shared daemon state without sharing memory:

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/filesystem/read-state/{agent}` | Record a successful read (body: `RecordReadSchema`) |
| `GET` | `/filesystem/read-state/{agent}?sessionId=X&path=Y` | Return `{contentHash, readAt}` or 404 |
| `POST` | `/filesystem/history/{agent}/backup` | Capture a pre-image (body: `BackupCreateSchema`) — returns `{backupId}` |
| `GET` | `/filesystem/history/{agent}?path=P` | List backups, newest first, optionally filtered by original path |
| `GET` | `/filesystem/history/{agent}/{backupId}` | Return `{originalPath, content}` for manual recovery |

All endpoints gate on `agentManager.getAgentNames()` → 404 on unknown
agent, and 503 if the store is unavailable (store injection is
optional on the bridge, to keep unit tests light).

## Session lifecycle + read-state

`ReadFileStateStore` subscribes to `session:crash` and `session:halt`
on first use and purges records for the failing `(agent, sessionId)`.
`session:reset` is a soft no-op — records keyed on the old sessionId
become unreachable once the fresh sessionId is issued, which is the
correct "agent must re-read first" behaviour. Daemon restart drops
the whole map, which is also correct: the invariant must hold within
a single session's live memory.

## Cleanup

`FileHistoryStore.cleanup(olderThanMs = 7 days)` walks every agent
subdirectory and removes `.pre` + `.meta.json` pairs older than the
cutoff. Called at daemon startup (awaited best-effort, logged on
failure) and then on a 24-hour `setInterval` with `.unref()` so the
timer doesn't keep the daemon alive past normal shutdown.
