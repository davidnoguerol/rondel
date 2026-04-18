# tools — first-class Rondel MCP tools

This directory holds Rondel's own tool implementations. It sits as a
top-level sibling of `bridge/`, `agents/`, `channels/`, etc. — these tools
are a first-class capability surface, not an internal piece of the bridge.
They *call* the bridge over HTTP, but they don't implement IPC themselves.

| Tool                         | Native equivalent (disallowed) | Purpose                                                    |
|------------------------------|--------------------------------|------------------------------------------------------------|
| `rondel_bash`                | Bash                           | Shell execution with a safety classifier + approval gate   |
| `rondel_read_file`           | —                              | Reads and records a sha256 hash for staleness checks       |
| `rondel_write_file`          | Write                          | Atomic write with read-first staleness + secret scan       |
| `rondel_edit_file`           | Edit                           | Single string-replace edit with backup                     |
| `rondel_multi_edit_file`     | MultiEdit                      | Atomic multi-edit with the same invariants as edit         |
| `rondel_ask_user`            | AskUserQuestion                | Structured multiple-choice prompt to the user              |

Each tool runs in the per-agent MCP server process (spawned by Claude
CLI but not Claude's own code), so their `fs`/`child_process` calls
bypass Claude Code's hardcoded protected-path and bash-validation
surfaces. Safety is handled explicitly by the tool code itself —
classification via `shared/safety/`, human escalation via the existing
`ApprovalService` HTTP flow, and observability via a `tool_call` ledger
event emitted after every completion.

## Follow-ups to investigate

The initial HITL-approvals branch left two known concerns. Neither blocks
merge, but both are worth a second look later:

1. **`bridge/bridge.ts` is ~1,750 lines** after this branch added
   approvals + read-state + ledger routes. It's still legible — the
   routing table is flat — but it's approaching god-object territory. If
   it grows further, carve routes into `../bridge/routes/approvals.ts`,
   `../bridge/routes/filesystem.ts`, `../bridge/routes/ledger.ts` and
   keep `bridge.ts` as the server + wiring.
2. **DRY across `write-file.ts` / `edit-file.ts` / `multi-edit-file.ts`.**
   The post-approval TOCTOU re-read block (`readFile` → `contentHash`
   check → error emit) is duplicated three times, and the denial-message
   formatter (timeout / deny / error) four times (also in `bash.ts`).
   Helpers like `formatApprovalDenial(outcome)` and
   `reReadOrAbortOnDrift(ctx, ...)` would belong in `_common.ts`.
   `safeZoneCtx` + `countOccurrences` are also copied across three files
   — either pull into `_common.ts` or into `../shared/safety/`. Leaving
   this for a follow-up because the duplicated blocks have enough
   per-tool wiring (tool name, start time, summary) that a shared helper
   needs careful signature design.

## Pattern

Each file exports one `registerXxxTool(server: McpServer)` function.
The barrel (`index.ts`) re-exports all registrations. New tools are
wired into `../bridge/mcp-server.ts` next to the existing `register*`
calls.

## `_common.ts` shared helpers

Every tool in this directory shares the same bridge contract — env-var
resolution, approval request+poll, ledger emit, sha256 hashing, path
validation. `_common.ts` centralises these so each tool file reads as
straight "what should this tool do" code without wrapping every fetch
in error-handling boilerplate. The filesystem tools all consume it;
`rondel_bash` and `rondel_ask_user` keep their own narrow helpers for
historical reasons and to keep their poll-loop logic readable.

Key exports:

- `resolveBridgeContext(env)` — reads `RONDEL_BRIDGE_URL` +
  `RONDEL_PARENT_*` and returns a `BridgeContext` or undefined.
- `resolveFilesystemContext(env)` — like the above but also demands a
  non-empty `RONDEL_PARENT_SESSION_ID` for read-state keying.
- `contentHash(content)` — sha256 hex of a string.
- `validateAbsolutePath(path)` — rejects relative/UNC/null-byte paths.
- `fetchJson`, `readFileStateGet`, `readFileStateRecord`, `createBackup`,
  `emitToolCall`, `requestApprovalAndWait` — thin typed wrappers over
  the bridge endpoints each tool needs.
- `toolError(message)` / `toolJson(payload, isError?)` — MCP response
  builders that keep the content shape consistent.

## Env-var contract

Tools read the agent's routing context from env vars stamped at MCP
spawn time:

- `RONDEL_BRIDGE_URL` — bridge HTTP base URL (required).
- `RONDEL_PARENT_AGENT` — agent name (required).
- `RONDEL_PARENT_CHANNEL_TYPE` — conversation channel (defaults to
  `internal`).
- `RONDEL_PARENT_CHAT_ID` — conversation chat id (required).
- `RONDEL_PARENT_SESSION_ID` — session id (required for filesystem
  tools; see `resolveFilesystemContext`).

Tools must return a clear `tool_error` (JSON `{error: ...}`) when any
required var is missing. Failing silently would strand the agent with
no way to know the tool is unavailable.

## Approval flow (when classification returns `escalate`)

1. `POST {BRIDGE_URL}/approvals/tool-use` with agent context, tool
   name, input, reason. Returns `{requestId}`.
2. Poll `GET {BRIDGE_URL}/approvals/{id}` every 1s until
   `status === "resolved"` or the 30-minute tool timeout.
3. On `decision: "allow"` proceed with execution. On `deny` or
   timeout, return `isError: true`.

Note: `rondel_ask_user` does **not** use this flow. It's a question, not
an approval gate — it calls `POST /prompts/ask-user` instead and polls
`GET /prompts/ask-user/:id` for the selected option.

## Ledger emit

After every completed execution (success or failure from the command
itself), POST `{BRIDGE_URL}/ledger/tool-call` with the full
`ToolCallEvent` shape. Ledger failures are best-effort — they must
never bubble up into the tool's own error path. Pre-execution failures
(missing env, invalid arguments, approval denied) do NOT emit a ledger
event — the approval service already records `approval_request` and
`approval_decision` for denials, and arg-validation failures are the
caller's bug.
