# Rondel Architecture (as built)

> Current state of the codebase as of the HITL approvals work (April 2026). Only documents what exists in code — not planned features.

---

## 1. System Overview

Rondel is a single-installation system at `~/.rondel/` (overridable via `RONDEL_HOME`) that bridges Telegram bots to Claude CLI processes via the `stream-json` protocol. It runs as an OS-managed background service (launchd on macOS, systemd on Linux) that auto-starts on login and auto-restarts on crash. Organizations and agents are discovered automatically by scanning `workspaces/` for directories containing `org.json` and `agent.json` respectively. Organizations group agents and provide shared context; agents within an org get org-specific context injected between global and per-agent context. Each agent is a template (config + system prompt). No Claude processes run at startup — they spawn lazily when a user sends the first message to a bot. Each unique chat gets its own isolated Claude process with its own session. The MCP protocol injects tools (Telegram messaging, agent queries, org management, inter-agent messaging, first-class shell/filesystem, structured ask-user prompts) into each agent process. An internal HTTP bridge allows MCP server processes to query Rondel core state. Agent-facing shell and filesystem work flows through first-class `rondel_*` MCP tools — each tool owns its own safety classifier, human-approval escalation, and ledger emission. Native `Bash`/`Write`/`Edit`/`MultiEdit` are hard-disallowed at spawn time; there is no PreToolUse hook. A CLI (`rondel init`, `add agent`, `add org`, `stop`, `logs`, `service`, etc.) handles setup and lifecycle management.

```
                       Telegram Bot API
                       ┌──────────────┐
                       │  Bot A       │  Bot B
                       └──┬───────┬───┘
                    poll  │       │  poll
               ┌──────────┘       └──────────┐
               │                              │
        TelegramAccount               TelegramAccount
               │                              │
               └──────────┐       ┌───────────┘
                          ▼       ▼
                     TelegramAdapter
                   (ChannelAdapter impl)
                          │
                    ChannelMessage
                          │
                          ▼
                       Router
                 (routing + queuing)
                          │
              ┌───────────┼───────────┐
              ▼           ▼           ▼
         AgentProcess AgentProcess AgentProcess
         (chat 101)   (chat 102)   (chat 201)
              │           │           │
              ▼           ▼           ▼
          claude CLI  claude CLI  claude CLI
         stream-json  stream-json stream-json
              │           │           │
         ┌────┘           │           └────┐
         ▼                ▼                ▼
     MCP Server       MCP Server       MCP Server
    (rondel +       (rondel +      (rondel +
    user servers)     user servers)    user servers)
         │  │             │  │             │  │
         │  ▼             │  ▼             │  ▼
         │  Bridge ◄──────┤──Bridge ◄──────┤──Bridge
         │  (HTTP)        │  (HTTP)        │  (HTTP)
         │  │             │  │             │  │
         │  ▼             │  ▼             │  ▼
         │  AgentManager  │  AgentManager  │  AgentManager
         │  (in-process)  │  (in-process)  │  (in-process)
         ▼                ▼                ▼
     Telegram API     Telegram API     Telegram API
     (direct calls)   (direct calls)   (direct calls)
```

---

## 2. Component Map

### Source files (~55 files, ~10000 lines, 2 runtime dependencies)

| File | Lines | Responsibility | Depends on |
|------|-------|---------------|------------|
| [index.ts](apps/daemon/src/index.ts) | 240 | Orchestrator entry point. Exports `startOrchestrator(rondelHome?)`. Loads .env, sets up daemon logging, loads config, discovers orgs+agents via `discoverAll()`, creates hooks, wires LedgerWriter, initializes AgentManager (with orgs), wires hook listeners, constructs ApprovalService (with channel registry + accountId resolver), recovers orphaned pending approvals, wires interactive-callback handler for Telegram inline-keyboard taps (Approve/Deny), starts scheduler/bridge/router/polling. Also runnable directly for daemon mode and backward compat | env-loader, config, agent-manager, router, bridge, scheduler, hooks, ledger, approvals, channels/core, instance-lock, logger |
| **CLI** | | | |
| [cli/index.ts](apps/daemon/src/cli/index.ts) | 125 | CLI entry point (`bin` field). Parses commands (init, add agent, add org, stop, restart, logs, status, doctor, service), routes to handlers | cli/* |
| [cli/init.ts](apps/daemon/src/cli/init.ts) | 160 | `rondel init` — creates `~/.rondel/` structure, config, .env, scaffolds first agent with BOOTSTRAP.md. Offers OS service installation at the end | config, scaffold, prompt, service |
| [cli/add-agent.ts](apps/daemon/src/cli/add-agent.ts) | 75 | `rondel add agent` — scaffolds new agent directory with config + context files | config, scaffold, prompt |
| [cli/add-org.ts](apps/daemon/src/cli/add-org.ts) | 85 | `rondel add org` — scaffolds new organization directory with org.json + shared context structure. Validates name format and uniqueness | config, scaffold, prompt |
| [cli/stop.ts](apps/daemon/src/cli/stop.ts) | 70 | `rondel stop` — service-aware: uses launchctl/systemctl/taskkill if service is installed, raw SIGTERM otherwise. Polls for process exit, escalates to SIGKILL | instance-lock, service, prompt |
| [cli/restart.ts](apps/daemon/src/cli/restart.ts) | 40 | `rondel restart` — restarts the OS service (requires installed service) | service, prompt |
| [cli/logs.ts](apps/daemon/src/cli/logs.ts) | 50 | `rondel logs` — tail the daemon log file. `--follow`/`-f` for real-time, `--lines N`/`-n N` for line count | instance-lock, config |
| [cli/service.ts](apps/daemon/src/cli/service.ts) | 100 | `rondel service [install\|uninstall\|status]` — manages OS service registration via the service module | service, config, prompt |
| [cli/status.ts](apps/daemon/src/cli/status.ts) | 95 | `rondel status` — shows service status, PID, uptime, log path, queries /agents endpoint for conversation states | instance-lock, service, config, prompt |
| [cli/doctor.ts](apps/daemon/src/cli/doctor.ts) | 195 | `rondel doctor` — 10 expandable diagnostic checks (init, config, CLI, orgs, agents, configs, tokens, state, service, skills) | config, service, prompt |
| [cli/prompt.ts](apps/daemon/src/cli/prompt.ts) | 55 | Interactive prompt helpers (readline-based, no deps). ask(), confirm(), styled output | (none) |
| [cli/scaffold.ts](apps/daemon/src/cli/scaffold.ts) | 110 | Agent + org directory scaffolding. `scaffoldAgent()` creates agent.json + context files + `.claude/skills/`. `scaffoldOrg()` creates org.json + `shared/CONTEXT.md` + `agents/` dir. Loads templates from `templates/context/` with `{{agentName}}`/`{{orgName}}` substitution. Used by CLI and bridge admin endpoints | (none) |
| **Ledger** | | | |
| [ledger/ledger-types.ts](apps/daemon/src/ledger/ledger-types.ts) | 83 | `LedgerEvent`, `LedgerEventKind` type definitions (including `approval_request`, `approval_decision`) + `LedgerQuerySchema` Zod schema for MCP tool input validation. Pure types + one Zod import | zod |
| [ledger/ledger-writer.ts](apps/daemon/src/ledger/ledger-writer.ts) | 295 | `LedgerWriter` class. Subscribes to all RondelHooks events (including `approval:requested` → `approval_request` and `approval:resolved` → `approval_decision`), transforms each into a `LedgerEvent`, appends JSONL to `state/ledger/{agentName}.jsonl`. Fire-and-forget writes, lazy directory creation | hooks, ledger-types |
| [ledger/ledger-reader.ts](apps/daemon/src/ledger/ledger-reader.ts) | 130 | `queryLedger()` function. Reads per-agent JSONL files, filters by time range / event kinds / limit, returns newest-first. Supports relative time ("6h", "1d") and ISO 8601 | ledger-types |
| [ledger/index.ts](apps/daemon/src/ledger/index.ts) | 5 | Barrel exports for ledger module | ledger-writer, ledger-reader, ledger-types |
| **Approvals (HITL)** | | | |
| [approvals/types.ts](apps/daemon/src/approvals/types.ts) | 85 | Pure types for the HITL approval system. One record shape (`ToolUseApprovalRecord`). `ApprovalDecision` (allow/deny), `ApprovalReason` (danger heuristic categories). No runtime imports | (none) |
| [approvals/approval-store.ts](apps/daemon/src/approvals/approval-store.ts) | 130 | File-based store for approval records. Pending and resolved in sibling directories under `state/approvals/`. Atomic writes via `atomicWriteFile`, no locking (single in-process writer). Mirrors the inbox store pattern | atomic-file, types |
| [approvals/approval-service.ts](apps/daemon/src/approvals/approval-service.ts) | 345 | Central owner of HITL approval state. `requestToolUse()` persists a pending record + dispatches interactive card via channel adapter + sets up in-memory resolver with timeout. `resolve()` flips records pending→resolved. `recoverPending()` at startup auto-denies orphaned records from previous runs. 30-minute timeout (configurable via `RONDEL_APPROVAL_TIMEOUT_MS`) | approval-store, tool-summary, hooks, channels/core, logger |
| [approvals/tool-summary.ts](apps/daemon/src/approvals/tool-summary.ts) | 87 | Pure helper: one-line human-readable summary of a tool call. Tool-specific formatting (Bash→command, Write→path+size, Edit→path, etc.). Used in Telegram approval cards and ledger events | (none) |
| [approvals/index.ts](apps/daemon/src/approvals/index.ts) | 37 | Barrel exports for approvals module | approval-service, approval-store, tool-summary, types |
| **Filesystem (first-class tools)** | | | |
| [filesystem/read-state-store.ts](apps/daemon/src/filesystem/read-state-store.ts) | 110 | `ReadFileStateStore` — in-memory `(agent, sessionId, path) → {contentHash, readAt}` map. Populated by `rondel_read_file` (non-truncated reads only); consulted by write/edit/multi-edit for the read-first staleness check. Lazy-subscribes to `session:crash` and `session:halt` on first use to purge records for failed sessions. `/new` is a soft no-op — the fresh sessionId renders old records unreachable | hooks |
| [filesystem/file-history-store.ts](apps/daemon/src/filesystem/file-history-store.ts) | 170 | `FileHistoryStore` — disk-backed pre-image backups at `state/file-history/{agent}/{pathHash}-{ts}.pre` with a `{backupId}.meta.json` sidecar. Captured before every overwrite (write/edit/multi-edit). `backup()` / `list()` / `restore()` / `cleanup()`. Retention: 7 days, pruned at startup + once every 24 h (scheduled from index.ts with unref'd timer) | atomic-file, logger |
| [filesystem/index.ts](apps/daemon/src/filesystem/index.ts) | 15 | Barrel exports for filesystem module | read-state-store, file-history-store |
| **First-class MCP tools** | | | |
| [tools/_common.ts](apps/daemon/src/tools/_common.ts) | 335 | Shared helpers used by every first-class tool: bridge-context env resolution (`resolveBridgeContext` / `resolveFilesystemContext`), `contentHash` (sha256 hex), `validateAbsolutePath`, bridge HTTP wrappers (`readFileStateGet/Record`, `createBackup`), `emitToolCall` (fire-and-forget, best-effort), `requestApprovalAndWait` (POST + poll), and MCP result helpers (`toolError`, `toolJson`) | (none runtime; type import from node:crypto / node:path) |
| [tools/bash.ts](apps/daemon/src/tools/bash.ts) | 505 | `rondel_bash` — first-class shell tool. `classifyBash` → approve/escalate; `spawn("bash", ["-c", ...])` with hard timeout + SIGKILL; stdout/stderr truncated at 100 000 chars; emits `tool_call` on every completion | safety, approvals/tool-summary |
| [tools/read-file.ts](apps/daemon/src/tools/read-file.ts) | 160 | `rondel_read_file` — reads UTF-8 content, hashes with sha256. Non-truncated reads register the staleness anchor (`POST /filesystem/read-state/:agent`); truncated reads do NOT register (forces a re-read with larger `max_bytes` before any write/edit). Emits `tool_call` | _common, safety (via types), approvals/tool-summary |
| [tools/write-file.ts](apps/daemon/src/tools/write-file.ts) | 220 | `rondel_write_file` — new file creation proceeds unconditionally; overwriting an existing file requires a matching recorded read (else escalate `write_without_read`). Secret scanner + safe-zone escalation too. Backup → `atomicWriteFile` → re-record new hash | _common, safety (`scanForSecrets`, `isPathInSafeZone`), atomic-file, approvals/tool-summary |
| [tools/edit-file.ts](apps/daemon/src/tools/edit-file.ts) | 240 | `rondel_edit_file` — single-pattern replace. Hard requirement: prior read in this session (tool_error, no escalation). Drift from recorded hash escalates. Occurrence-count validation (exactly-1 or ≥1 with `replace_all`) before any write | _common, safety, atomic-file, approvals/tool-summary |
| [tools/multi-edit-file.ts](apps/daemon/src/tools/multi-edit-file.ts) | 240 | `rondel_multi_edit_file` — apply N edits against an in-memory buffer in order. All-or-nothing: any edit whose match count is wrong aborts the whole operation with `{editIndex}`. One backup + one `tool_call` emit per operation | _common, safety, atomic-file, approvals/tool-summary |
| [tools/index.ts](apps/daemon/src/tools/index.ts) | 15 | Barrel re-exports all `registerXxxTool` functions | bash, read-file, write-file, edit-file, multi-edit-file |
| **Core** | | | |
| [hooks.ts](apps/daemon/src/shared/hooks.ts) | 200 | Typed EventEmitter for lifecycle hooks. Conversation events (`message_in`, `response`, `response_delta`) + session lifecycle (`start`, `resumed`, `reset`, `crash`, `halt`) + subagent events + cron events + inter-agent messaging events + HITL approval events (`approval:requested`, `approval:resolved`) | types (including shared/types/approvals) |
| [types/](apps/daemon/src/shared/types/) | ~260 | Domain-aligned type definitions split across 8 files: `config.ts` (RondelConfig, AgentConfig, OrgConfig, discovery types), `agents.ts` (AgentState, AgentEvent, stream-json protocol), `subagents.ts` (SubagentSpawnRequest, SubagentState, SubagentInfo), `scheduling.ts` (CronJob, CronSchedule, CronJobState), `sessions.ts` (ConversationKey branded type + constructor/parser, SessionEntry, SessionIndex), `routing.ts` (QueuedMessage with optional AgentMailReplyTo), `transcripts.ts` (TranscriptSessionHeader, TranscriptUserEntry), `messaging.ts` (InterAgentMessage, AgentMailReplyTo, hook event types). Barrel `index.ts` re-exports all. Each file has zero runtime imports — pure types only, safe to import anywhere | (none, except `config.ts` imports type from `scheduling.ts`, `routing.ts` imports type from `messaging.ts`) |
| [env-loader.ts](apps/daemon/src/config/env-loader.ts) | 30 | Minimal .env parser. Loads `KEY=VALUE` lines into `process.env` (doesn't overwrite existing vars). Critical for service context where shell profile isn't loaded | (none) |
| [config.ts](apps/daemon/src/config/config.ts) | 270 | `resolveRondelHome()`, `rondelPaths()`, load config from `~/.rondel/config.json`, recursive org+agent discovery from `workspaces/` via `discoverAll()`, `loadOrgConfig()`, `discoverSingleAgent()` / `discoverSingleOrg()` for hot-add, `${ENV_VAR}` substitution, validation. Nested org detection, disabled org subtree skipping | types |
| [context-assembler.ts](apps/daemon/src/config/context-assembler.ts) | 160 | Assemble agent context from bootstrap files with `# filename` heading prefixes. Layer order: global/CONTEXT.md → {org}/shared/CONTEXT.md (if org) → AGENT.md + SOUL.md + IDENTITY.md + USER.md + MEMORY.md + BOOTSTRAP.md. USER.md fallback chain: agent → org/shared → global. Falls back to legacy SYSTEM.md. Ephemeral mode strips MEMORY.md + USER.md + BOOTSTRAP.md. Also handles template context assembly | config, logger |
| [channels/core/channel.ts](apps/daemon/src/channels/core/channel.ts) | 150 | `ChannelAdapter` interface + `ChannelMessage` + `ChannelCredentials` + `InteractiveButton` + `InteractiveCallback` types. `supportsInteractive` flag + `sendInteractive()` + `onInteractiveCallback()` methods for inline-keyboard / button flows. Core types every adapter depends on — no adapter-specific knowledge | (none) |
| [channels/core/registry.ts](apps/daemon/src/channels/core/registry.ts) | 155 | `ChannelRegistry` class. Central adapter lookup + dispatch. `onInteractiveCallback()` replays handlers across all adapters (same semantics as `onMessage`). `startAll`/`stopAll` wrap per-adapter errors (one bad adapter cannot halt startup/shutdown) | channel, logger |
| [channels/telegram/adapter.ts](apps/daemon/src/channels/telegram/adapter.ts) | 470 | `TelegramAdapter` implementing `ChannelAdapter`. Multi-account, long-polling (`allowed_updates: ["message", "callback_query"]`), send text with Markdown + chunking, typing indicator lifecycle (start/stop with 4s refresh loop — Telegram expires after ~5s). `supportsInteractive: true` — `sendInteractive()` for inline keyboards, `answerCallbackQuery()` to ack taps, `editMessageText()` for cosmetic card updates. `startAccount()` for hot-adding agents at runtime | channels/core, logger |
| [channels/telegram/mcp-tools.ts](apps/daemon/src/channels/telegram/mcp-tools.ts) | 170 | `registerTelegramTools(server)` — registers `rondel_send_telegram` + `rondel_send_telegram_photo` MCP tools on a passed-in server. No-op if `RONDEL_CHANNEL_TELEGRAM_TOKEN` is not set for the agent | @modelcontextprotocol/sdk |
| [channels/web/adapter.ts](apps/daemon/src/channels/web/adapter.ts) | 300 | `WebChannelAdapter` implementing `ChannelAdapter`. `supportsInteractive: false` — approval cards route to Telegram only; web resolves via the `/approvals` page instead. Loopback-only, in-process channel driven by bridge endpoints — no polling, no external credentials. One synthetic account per agent (accountId === agentName), registered automatically at startup by `AgentManager.registerChannelBindings()` and torn down symmetrically in `unregisterAgent`. `ingestUserMessage()` normalizes HTTP requests into `ChannelMessage` and dispatches through the same handler pipeline Telegram uses. `sendText()` / typing indicators fan out to per-conversation subscribers via `subscribeConversation()`. Each conversation has a 20-frame ring buffer (`getRingBuffer()`) so tabs that open mid-stream replay recent frames before attaching live | channels/core, logger |
| [channels/web/index.ts](apps/daemon/src/channels/web/index.ts) | 5 | Barrel exports — `WebChannelAdapter`, `WebChannelFrame` | channels/web/adapter |
| [agent-manager.ts](apps/daemon/src/agents/agent-manager.ts) | 470 | Agent template registry + org registry + account mapping + facade. Takes `rondelHome` + `DiscoveredAgent[]` + `DiscoveredOrg[]`, assembles system prompts (with orgDir for context layering), creates focused managers. Stores `agentDirs`, `agentOrgs`, and `orgRegistry`. Delegates lifecycle to ConversationManager, SubagentManager, CronRunner. `registerAgent()` / `registerOrg()` for hot-add, `getOrgs()` / `getOrgByName()` / `getAgentOrg()` for queries, `getSystemStatus()` includes org info | conversation-manager, subagent-manager, cron-runner, telegram, config, context-assembler, hooks, types, logger |
| [conversation-manager.ts](apps/daemon/src/agents/conversation-manager.ts) | 310 | Per-conversation process lifecycle + session persistence. Owns the `conversations` map (`ConversationKey` → AgentProcess) and the session index (sessions.json). Uses branded `ConversationKey` type from `shared/types/sessions.ts`. Spawns processes with `--session-id` (new) or `--resume` (existing). Handles session reset (`/new`), resume failure detection, transcript creation. Emits session lifecycle hooks (`session:start`, `session:resumed`, `session:reset`, `session:crash`, `session:halt`) by translating AgentProcess `stateChange` events into RondelHooks | agent-process, transcript, hooks, types (ConversationKey), logger |
| [subagent-manager.ts](apps/daemon/src/agents/subagent-manager.ts) | 289 | Ephemeral subagent spawning, tracking, and garbage collection. Resolves templates, builds MCP configs, emits lifecycle hooks (subagent:spawning/completed/failed). Background timer prunes completed results after 1 hour | subagent-process, agent-process (McpConfigMap), config, context-assembler, transcript, hooks, types, logger |
| [cron-runner.ts](apps/daemon/src/scheduling/cron-runner.ts) | 138 | Cron job execution engine. Two modes: `runIsolated()` spawns a fresh SubagentProcess (with ephemeral context — no MEMORY.md/USER.md), `getOrSpawnNamedSession()` delegates to ConversationManager for persistent sessions. Owns transcript creation for cron runs | subagent-process, agent-process (McpConfigMap), context-assembler, conversation-manager, transcript, types, logger |
| [agent-process.ts](apps/daemon/src/agents/agent-process.ts) | 485 | Single persistent Claude CLI process. Spawn with `stream-json`, parse events, send messages, manage state, crash recovery, MCP config file lifecycle. Session-aware: `--session-id` for new sessions, `--resume` for crash recovery. `FRAMEWORK_DISALLOWED_TOOLS` blocks seven native tools (`Agent`, `ExitPlanMode`, `AskUserQuestion`, `Bash`, `Write`, `Edit`, `MultiEdit`) — the shell/filesystem quartet is replaced by first-class `rondel_*` MCP tools. Passes `--dangerously-skip-permissions` (stream-json has no interactive permission surface) together with the disallow list so native Bash/Write/Edit/MultiEdit are still refused. No PreToolUse hook, no runtime-dir stamping, no per-agent `permissionMode` field. cwd is the user-configured `workingDirectory` or inherited. Passes `--add-dir` for per-agent and framework skill discovery. Transcript capture: appends all stream-json events to JSONL | types, transcript, paths, logger |
| [subagent-process.ts](apps/daemon/src/agents/subagent-process.ts) | 310 | Ephemeral Claude CLI process for task execution. Single task in, result out, exit. Timeout, MCP config, structured result parsing. Passes `--add-dir` for framework skill discovery. Transcript capture: appends all stream-json events to JSONL | types, transcript, agent-process (McpConfigMap type), logger |
| [transcript.ts](apps/daemon/src/shared/transcript.ts) | 125 | Append-only JSONL transcript writer + reader. Creates transcript files, appends entries (fire-and-forget, never blocks the agent). `loadTranscriptTurns()` parses a JSONL transcript into ordered `{role, text, ts?}` turns for the web UI's conversation history endpoint — returns `[]` on ENOENT only; any other I/O error is rethrown so the bridge surfaces a real 500 rather than a silent empty view | logger |
| [messaging/inbox.ts](apps/daemon/src/messaging/inbox.ts) | 114 | File-based inbox for inter-agent message persistence. `appendToInbox()` writes before delivery, `removeFromInbox()` clears after. `readAllInboxes()` recovers pending messages on startup. Each agent gets `state/inboxes/{agentName}.json`. No locking needed — single writer (Bridge process), atomic file writes | atomic-file, types (InterAgentMessage) |
| [router.ts](apps/daemon/src/routing/router.ts) | 410 | Inbound message routing: account → agent resolution, message queuing per conversation (using branded `ConversationKey`), system commands, response dispatch back to Telegram. Emits `conversation:message_in` (on user message) and `conversation:response` (on agent reply). Inter-agent messaging: `deliverAgentMail()` spawns agent-mail conversations, `wireAgentMailProcess()` buffers responses and routes replies back to senders. Emits `message:reply` hook. | agent-manager, agent-process, channel, hooks, types (ConversationKey, AgentMailReplyTo), logger |
| [bridge.ts](apps/daemon/src/bridge/bridge.ts) | 1125 | Internal HTTP server (localhost, random port). Owns HTTP routing, read-only endpoints (agents, conversations, subagents, memory, orgs, ledger query, `/version`), SSE endpoints (`/ledger/tail[/:agent]`, `/agents/state/tail`, `/approvals/tail`, `/conversations/{agent}/{channelType}/{chatId}/tail`) delegated to `handleSseRequest`, web-chat endpoints (`POST /web/messages/send` + `GET /conversations/{agent}/{channelType}/{chatId}/history`), HITL approval endpoints (`POST /approvals/tool-use`, `GET /approvals/:id`, `GET /approvals`, `POST /approvals/:id/resolve`), ask-user prompts (`POST /prompts/ask-user`, `GET /prompts/ask-user/:id` — in-memory store, no persistence), subagent spawn/kill, inter-agent messaging (`POST /messages/send`, `GET /messages/teammates`), org isolation enforcement, and body parsing. Resolves the `WebChannelAdapter` locally via `channelRegistry.get("web") instanceof WebChannelAdapter` so AgentManager doesn't leak a concrete channel class. Pre-validates `resolveAgentByChannel("web", agentName)` before injecting — returns 503 with a concrete reason if the synthetic account is missing. `isKnownChannelType()` rejects unknown `channelType` values in history/tail URLs with 400 (includes synthetic `"internal"` for agent-mail). Admin mutation endpoints are delegated to AdminApi. Async-safe readBody | http (node built-in), admin-api, schemas, approvals, ledger, streams, channels/web, shared/transcript, agent-manager, router, hooks, atomic-file, types (InterAgentMessage), logger |
| [admin-api.ts](apps/daemon/src/bridge/admin-api.ts) | 280 | Admin mutation logic extracted from bridge. Methods return `{ status, data }` — HTTP-framework-agnostic. Handles add/update/delete agent, add org, reload, set env, system status. Uses Zod schemas for request validation | schemas, config, scaffold, agent-manager, atomic-file, logger |
| [schemas.ts](apps/daemon/src/bridge/schemas.ts) | 360 | Zod validation schemas for admin, messaging, web-chat, HITL approval, tool-call ledger, filesystem-tool, and ask-user endpoints: `AddAgentSchema`, `UpdateAgentSchema`, `AddOrgSchema`, `SetEnvSchema`, `SendMessageSchema`, web schemas (`WebSendRequestSchema`, `ConversationTurnSchema`, `ConversationHistoryResponseSchema`, `ConversationStreamFrameDataSchema`), approval schemas (`ToolUseApprovalCreateSchema`, `ApprovalResolveSchema`, `ToolUseApprovalRecordSchema` / `ApprovalRecordSchema`, `ApprovalListResponseSchema`), tool-call + filesystem schemas, and ask-user schemas (`AskUserOptionSchema`, `AskUserCreateSchema`, `AskUserResultSchema`). `BRIDGE_API_VERSION` pinned here (currently `12`). Includes `validateBody()` helper that returns structured errors | zod |
| **Streams (SSE)** | | | |
| [streams/sse-types.ts](apps/daemon/src/streams/sse-types.ts) | 75 | `SseFrame<T>` + `StreamSource<T>` interface. Protocol-agnostic fan-out contract: `subscribe(send)`, optional `snapshot()`, `dispose()`. One source instance per stream type, N clients fan out from it | (none) |
| [streams/sse-handler.ts](apps/daemon/src/streams/sse-handler.ts) | 215 | Generic HTTP handler — the only place that knows the SSE wire format. Sets headers, subscribes FIRST (buffers deltas), runs optional `replay` + `snapshot`, flushes buffer in order, switches to direct-write live mode, 25s heartbeats, `req.close` + `res.error` cleanup | sse-types |
| [streams/ledger-stream.ts](apps/daemon/src/streams/ledger-stream.ts) | 72 | `LedgerStreamSource` — subscribes once to `LedgerWriter.onAppended` and fans each append out to N clients. Filtering (per-agent) applied at the handler boundary, not in the source | ledger-writer, ledger-types, sse-types |
| [streams/agent-state-stream.ts](apps/daemon/src/streams/agent-state-stream.ts) | 92 | `AgentStateStreamSource` — subscribes to `ConversationManager.onStateChange` and emits `agent_state.delta` frames. Implements `snapshot()` returning every active conversation's current state as a single `agent_state.snapshot` frame on connect | conversation-manager, agents types, sse-types |
| [streams/conversation-stream.ts](apps/daemon/src/streams/conversation-stream.ts) | 270 | `ConversationStreamSource` — per-request, per-conversation stream source. Unlike `LedgerStreamSource` / `AgentStateStreamSource` (singletons constructed once in `index.ts`), a new instance is constructed by the bridge on each `GET /conversations/.../tail` request and disposed when the SSE handler cleans up. Taps `RondelHooks` for user messages, agent responses, and session lifecycle events, filtered to the target `(agentName, chatId)`. For `channelType === "web"` only, it ALSO subscribes to the `WebChannelAdapter`'s per-conversation fan-out to surface typing indicators. `replayRingBuffer()` drains the web adapter's ring buffer as a `replay` callback so freshly-opened tabs see recent context before going live. Frame type is a discriminated union (`user_message`, `agent_response`, `typing_start`, `typing_stop`, `session`) mirrored by `ConversationStreamFrameDataSchema` in `bridge/schemas.ts` | hooks, channels/web, sse-types |
| [streams/approval-stream.ts](apps/daemon/src/streams/approval-stream.ts) | 80 | `ApprovalStreamSource` — subscribes once to the `approval:requested` / `approval:resolved` hook events and fans each out to N clients as `approval.requested` / `approval.resolved` SSE frames. No snapshot (initial list comes from `GET /approvals`). Mirrors `LedgerStreamSource` | hooks, approvals types, sse-types |
| [streams/index.ts](apps/daemon/src/streams/index.ts) | 20 | Barrel — `handleSseRequest`, `LedgerStreamSource`, `AgentStateStreamSource`, `ApprovalStreamSource`, `ConversationStreamSource`, `SseFrame`, `StreamSource` | streams/* |
| [mcp-server.ts](apps/daemon/src/bridge/mcp-server.ts) | 825 | Standalone MCP server process. Exposes Telegram tools + bridge query tools + subagent tools + inter-agent messaging tools (`rondel_send_message`, `rondel_list_teammates`) + ledger query tool (`rondel_ledger_query`) + memory tools + org tools (`rondel_list_orgs`, `rondel_org_details` — all agents) + first-class Rondel tools (`rondel_bash`, `rondel_read_file`, `rondel_write_file`, `rondel_edit_file`, `rondel_multi_edit_file`, `rondel_ask_user`) + system status (all agents) + admin tools (gated by `RONDEL_AGENT_ADMIN`: add_agent with `org` param, create_org, update_agent, delete_agent, reload, set_env). Calls Telegram API directly and Rondel bridge via HTTP | `@modelcontextprotocol/sdk`, zod, tools |
| [scheduler.ts](apps/daemon/src/scheduling/scheduler.ts) | 581 | Timer-driven cron job runner. Reads `crons` from agent configs, manages timers, delegates execution to CronRunner (isolated) or CronRunner + ConversationManager (named sessions), delivers results via Telegram or log. State persistence, backoff, missed job recovery | agent-manager, cron-runner, telegram, hooks, types, logger |
| [atomic-file.ts](apps/daemon/src/shared/atomic-file.ts) | 36 | Atomic file write utility. Write-to-temp + rename pattern for state files (sessions.json, cron-state.json, lockfile). Prevents data corruption on crash mid-write | (none) |
| [paths.ts](apps/daemon/src/shared/paths.ts) | 13 | Template path resolution. `resolveFrameworkSkillsDir()` relative to the daemon package's `templates/` directory | (none) |

| [instance-lock.ts](apps/daemon/src/system/instance-lock.ts) | 115 | Singleton instance guard. PID lockfile at `~/.rondel/state/rondel.lock` prevents two Rondel instances. Stale lock detection via PID liveness check. Records bridge URL and log path. Exports `readInstanceLock()` for CLI commands and `LockData` interface | atomic-file, logger |
| [service.ts](apps/daemon/src/system/service.ts) | 250 | Platform-aware OS service management. `getServiceBackend()` returns launchd (macOS) or systemd (Linux) backend. Handles install, uninstall, stop, status. Generates plist/unit files with correct PATH (including claude CLI location), env vars, log redirection. `buildServiceConfig()` resolves all paths from current environment | config |
| [logger.ts](apps/daemon/src/shared/logger.ts) | 95 | Dual-transport logger. Console output with ANSI colors (TTY only) + file output via `initLogFile()` (daemon mode). Simple size-based log rotation (10MB → .log.1). `[LEVEL] [component]` prefix, hierarchical via `.child()` | (none) |

### Dependency graph

```
cli/index.ts (CLI entry point)
  ├── cli/init.ts ──── config.ts, scaffold.ts, prompt.ts, service.ts (dynamic import)
  ├── cli/add-agent.ts ──── config.ts, scaffold.ts, prompt.ts
  ├── cli/add-org.ts ──── config.ts, scaffold.ts, prompt.ts
  ├── cli/stop.ts ──── config.ts, instance-lock.ts, service.ts, prompt.ts
  ├── cli/restart.ts ──── service.ts, prompt.ts
  ├── cli/logs.ts ──── config.ts, instance-lock.ts, prompt.ts
  ├── cli/service.ts ──── service.ts, config.ts, prompt.ts
  ├── cli/status.ts ──── config.ts, instance-lock.ts, service.ts, prompt.ts
  └── cli/doctor.ts ──── config.ts, service.ts (dynamic import), prompt.ts

index.ts (startOrchestrator)
  ├── env-loader.ts ──── (none)
  ├── config.ts ──── types.ts
  ├── logger.ts ──── (none, module-level state for file transport)
  ├── instance-lock.ts ──── atomic-file.ts, logger.ts
  ├── ledger/ ──── hooks.ts, ledger-types.ts (zod)
  ├── approvals/ ──── approval-store.ts (atomic-file), tool-summary.ts, hooks.ts, channels/core
  ├── streams/ ──── ledger/ (LedgerWriter), agent-manager → conversation-manager, shared/types (AgentStateEvent)
  ├── agent-manager.ts (facade)
  │     ├── conversation-manager.ts ──── atomic-file.ts, agent-process.ts, transcript.ts, hooks.ts, types.ts
  │     ├── subagent-manager.ts
  │     │     ├── subagent-process.ts ──── types.ts, transcript.ts, agent-process.ts (McpConfigMap + FRAMEWORK_DISALLOWED_TOOLS)
  │     │     ├── config.ts, context-assembler.ts
  │     │     ├── transcript.ts
  │     │     └── hooks.ts ──── types.ts
  │     ├── cron-runner.ts
  │     │     ├── subagent-process.ts
  │     │     ├── conversation-manager.ts
  │     │     └── transcript.ts
  │     ├── telegram.ts ──── channel.ts, logger.ts
  │     ├── config.ts, context-assembler.ts
  │     └── types.ts
  ├── scheduler.ts ──── agent-manager.ts, cron-runner.ts, atomic-file.ts, telegram.ts, hooks.ts, types.ts, logger.ts
  ├── bridge.ts ──── admin-api.ts, schemas.ts, ledger/, streams/, agent-manager.ts, router.ts, hooks.ts, atomic-file.ts, types.ts, logger.ts
  │     └── admin-api.ts ──── schemas.ts, config.ts, scaffold.ts, agent-manager.ts, atomic-file.ts, logger.ts
  ├── router.ts
  │     ├── agent-manager.ts
  │     ├── agent-process.ts
  │     ├── channel.ts
  │     ├── types.ts
  │     └── logger.ts
  └── logger.ts

mcp-server.ts (separate process — not imported by anything above)
  ├── @modelcontextprotocol/sdk, zod
  └── HTTP → bridge.ts (via RONDEL_BRIDGE_URL env var)
```

---

## 3. Message Flow

### Inbound: Telegram message -> agent response -> Telegram reply

1. `TelegramAccount.pollLoop()` calls `getUpdates()` with long-polling ([telegram/adapter.ts](apps/daemon/src/channels/telegram/adapter.ts))
2. Each update is filtered by `allowedUsers` set ([telegram/adapter.ts](apps/daemon/src/channels/telegram/adapter.ts))
3. Valid messages are normalized to `ChannelMessage` and dispatched to handlers ([telegram/adapter.ts](apps/daemon/src/channels/telegram/adapter.ts))
4. `Router.handleInboundMessage()` receives it ([router.ts:85](apps/daemon/src/routing/router.ts#L85))
5. `agentManager.resolveAgentByAccount(accountId)` maps bot -> agent name ([agent-manager.ts:90](apps/daemon/src/agents/agent-manager.ts#L90))
6. System commands (`/status`, `/restart`, `/cancel`, `/help`, `/start`) are intercepted and handled by the Router, not forwarded to the agent ([router.ts:95](apps/daemon/src/routing/router.ts#L95))
7. `agentManager.getOrSpawnConversation(agentName, chatId)` returns existing process or spawns new ([agent-manager.ts:104](apps/daemon/src/agents/agent-manager.ts#L104))
8. If agent is idle: `process.sendMessage(text)` writes JSON to Claude's stdin ([agent-process.ts:127](apps/daemon/src/agents/agent-process.ts#L127))
9. If agent is busy: message is pushed to per-conversation queue ([router.ts:119](apps/daemon/src/routing/router.ts#L119))
10. Claude responds via stdout. `handleStdoutLine()` parses newline-delimited JSON ([agent-process.ts:169](apps/daemon/src/agents/agent-process.ts#L169))
11. `assistant` events buffer text blocks. `result` event flushes buffer and emits `"response"` ([agent-process.ts:203](apps/daemon/src/agents/agent-process.ts#L203))
12. Router's wired handler sends response text back via `telegram.sendText(accountId, chatId, text)` ([router.ts:59](apps/daemon/src/routing/router.ts#L59))
13. On state change to `idle`, queue is drained — next queued message is sent to the process ([router.ts:67](apps/daemon/src/routing/router.ts#L67))

### Outbound: Agent-initiated message via MCP tool

1. Agent decides to call `rondel_send_telegram` tool during its turn
2. Claude CLI spawns the MCP server process (via `--mcp-config` temp file) and calls the tool over stdio
3. `mcp-server.ts` receives the tool call with `chat_id` and `text` params ([mcp-server.ts:114](apps/daemon/src/bridge/mcp-server.ts#L114))
4. `sendTelegramText()` calls Telegram Bot API directly using `RONDEL_BOT_TOKEN` from env ([mcp-server.ts:39](apps/daemon/src/bridge/mcp-server.ts#L39))
5. Message appears in Telegram without any Rondel core involvement
6. Tool result is returned to Claude, which continues its turn

---

## 4. Process Model

### Per-conversation, not per-agent

Agent config is a **template** — identity, model, tools, bot token. No processes exist at startup. Each unique `(agentName, chatId)` pair gets its own Claude CLI process ([agent-manager.ts:104](apps/daemon/src/agents/agent-manager.ts#L104)). Three users messaging the same bot = three independent Claude instances with isolated sessions.

Conversation key: `"${agentName}:${chatId}"` ([agent-manager.ts:183](apps/daemon/src/agents/agent-manager.ts#L183))

### Spawn

```bash
claude -p \
  --input-format stream-json --output-format stream-json \
  --verbose --model <model> \
  --system-prompt "<assembled context>" \
  --dangerously-skip-permissions \      # disables CLI permission UI (no surface in headless mode)
  --allowedTools <tool list> \
  --disallowedTools <FRAMEWORK_DISALLOWED_TOOLS + user disallowed> \
  --mcp-config <temp-file-path> \
  --add-dir <agentDir> \               # per-agent skill discovery
  --add-dir <framework-skills-dir>     # framework skill discovery
```

Built at [agent-process.ts](apps/daemon/src/agents/agent-process.ts). `cwd` is the user-configured `agentConfig.workingDirectory` when set, otherwise inherited from the daemon. There is no framework-owned runtime dir, no PreToolUse hook, no `.claude/settings.json` stamping, no `permissionMode` field. `--dangerously-skip-permissions` is always passed — it only suppresses the Claude CLI's own interactive permission UI (which has nowhere to render in headless stream-json mode), while `FRAMEWORK_DISALLOWED_TOOLS` ensures native Bash/Write/Edit/MultiEdit are refused before any handler runs. Safety classification lives per-tool inside the first-class `rondel_*` MCP tools under `apps/daemon/src/tools/`.

### Framework-disallowed tools

Rondel always adds these built-in Claude CLI tools to `--disallowedTools`. User-configured disallowed tools from `agent.json` merge on top.

| Built-in tool   | Rondel replacement        | Why |
|-----------------|---------------------------|-----|
| `Agent`         | `rondel_spawn_subagent`   | Rondel owns delegation — it needs to track, kill, and budget subagent lifecycles. The built-in Agent tool is a black box. |
| `ExitPlanMode`  | *(none)*                  | TTY-only Claude Code tool for the plan-mode approve/reject flow. No UI surface in headless `stream-json` mode and no use case for plan mode in long-running agents. |
| `AskUserQuestion` | `rondel_ask_user`       | TTY-only interactive prompt — no UI surface in headless `stream-json` mode. Replaced by `rondel_ask_user`, which renders a multiple-choice prompt through the active channel (Telegram inline keyboard, web buttons) and returns the selected option. For free-text questions agents simply ask in prose. |
| `Bash`          | `rondel_bash`             | Rondel owns the bash safety classifier, human-approval escalation for dangerous patterns, timeout + SIGKILL, output truncation, and `tool_call` ledger emission. |
| `Write`         | `rondel_write_file`       | Read-first staleness check, pre-write backup via `FileHistoryStore`, secret scanner, and safe-zone enforcement live in the Rondel tool. |
| `Edit`          | `rondel_edit_file`        | Requires a prior `rondel_read_file` in the same session (staleness anchor); backup + secret scan + safe-zone checks mirror `rondel_write_file`. |
| `MultiEdit`     | `rondel_multi_edit_file`  | Atomic multi-edit with the same invariants as `rondel_edit_file` — all edits apply or none do. |

Defined in `FRAMEWORK_DISALLOWED_TOOLS` at [agent-process.ts](apps/daemon/src/agents/agent-process.ts). This is a framework invariant, not a per-agent config choice.

### State machine

```
stopped → starting → idle ⇄ busy
                       ↓       ↓
                    crashed → (auto-restart after 5s) → starting
                       ↓
                    halted  (after 5 crashes/day — manual /restart required)
```

States defined as: `"starting" | "idle" | "busy" | "crashed" | "halted" | "stopped"` ([agents.ts](apps/daemon/src/shared/types/agents.ts))

### Block streaming

Text blocks are emitted immediately as they arrive in `assistant` events — not buffered until turn end. Each text block fires a `response` event, which the Router sends to Telegram. The user sees intermediate messages (e.g., "Creating the agent now...") while tools run, then the result after.

### Session resilience

New session entries only persist to `sessions.json` after Claude CLI confirms via the `sessionEstablished` event. This prevents stale entries from processes that crash before the first turn. Resume failure detection catches stale sessions within 10 seconds (regardless of exit code — Claude CLI exits 0 even on errors) and falls back to a fresh session.

### Crash recovery

On process exit ([agent-process.ts:221](apps/daemon/src/agents/agent-process.ts#L221)):
- Daily crash counter resets at midnight
- If < 5 crashes today: wait with escalating backoff (5s → 15s → 30s → 60s → 2m), auto-restart
- If >= 5: set state to `"halted"`, notify user via Telegram, stop restarting
- Router notifies the chat on crash/halt ([router.ts:77](apps/daemon/src/routing/router.ts#L77))
- Resume failure: if process exits within 10s of `--resume` spawn, falls back to fresh session

### Subagent processes

Subagents are ephemeral Claude CLI processes spawned for a single task. Unlike top-level agent processes (persistent, bidirectional stream-json), subagents:

- Receive a single task, run to completion, and exit
- Use stream-json for structured result parsing (cost, error status) but only receive one message
- Have a configurable timeout (default 5 minutes) — killed if exceeded
- No crash recovery — they either complete, fail, or time out
- No channel binding — results are delivered back to the parent automatically

### Subagent lifecycle (async, push-based)

Follows OpenClaw's model: spawn returns immediately, results delivered as messages.

```
1. Parent agent calls rondel_spawn_subagent
     ↓ MCP tool → bridge POST /subagents/spawn
   AgentManager.spawnSubagent() returns immediately with { id, state: "running" }
     ↓ hooks emit "subagent:spawning"
   Listener sends Telegram notification: "Delegating to researcher subagent..."
     ↓ MCP tool returns subagent ID to parent
   Parent's turn ends. Parent tells user it delegated the task.

2. Subagent runs in background
     ↓ SubagentProcess watches via done promise

3. Subagent finishes
     ↓ hooks emit "subagent:completed" (or "subagent:failed")
   Listener delivers result to parent as a user message via sendMessage()
   Listener sends Telegram notification: "Subagent completed ($X.XX)"
     ↓
   Parent agent processes the result in a new turn
   Parent summarizes findings for the user
```

The parent does NOT poll. Results arrive as messages — the framework owns delivery.

Subagent state: `"running" | "completed" | "failed" | "killed" | "timeout"`

Templates live in `templates/` at the project root. Each template has `agent.json` (model, tools, MCP servers) and `SYSTEM.md` (system prompt). Templates are loaded on demand — not at startup. If no template is specified, the parent provides an inline `system_prompt`.

---

## 5. Lifecycle Hooks

Typed EventEmitter for cross-cutting concerns ([hooks.ts](apps/daemon/src/shared/hooks.ts)). Modules emit events when significant things happen; other modules subscribe to react. The emitter doesn't know what the listeners do — this keeps concerns decoupled.

Created once in `index.ts`, injected into `AgentManager` via constructor.

| Hook | Fired by | When | Default listeners |
|------|----------|------|-------------------|
| `conversation:message_in` | Router | User sends a message (idle or queued) | LedgerWriter → `user_message` |
| `conversation:response` | Router | Agent emits a text block (block streaming) | LedgerWriter → `agent_response` |
| `session:start` | ConversationManager | New session created (fresh UUID) | LedgerWriter → `session_start` |
| `session:resumed` | ConversationManager | Existing session resumed via `--resume` | LedgerWriter → `session_resumed` |
| `session:reset` | ConversationManager | User triggers `/new` | LedgerWriter → `session_reset` |
| `session:crash` | ConversationManager | AgentProcess enters `crashed` state | LedgerWriter → `crash` |
| `session:halt` | ConversationManager | AgentProcess enters `halted` state | LedgerWriter → `halt` |
| `subagent:spawning` | AgentManager | Before subagent process starts | LedgerWriter + Telegram notification |
| `subagent:completed` | AgentManager | Subagent finished successfully | LedgerWriter + deliver result to parent + Telegram notification |
| `subagent:failed` | AgentManager | Subagent errored/timed out/killed | LedgerWriter + inform parent + Telegram notification |
| `cron:completed` | Scheduler | Cron job finished successfully | LedgerWriter + log completion |
| `cron:failed` | Scheduler | Cron job errored/timed out | LedgerWriter + log failure + Telegram notification if announce delivery configured |
| `message:sent` | Bridge | Agent sends inter-agent message (after validation, before delivery) | LedgerWriter (`inter_agent_sent`) + console log |
| `message:delivered` | Bridge | Message delivered to recipient's agent-mail conversation | LedgerWriter (`inter_agent_received`) |
| `message:reply` | Router | Agent-mail response routed back to sender | LedgerWriter (`inter_agent_received` on sender's ledger) + console log |
| `approval:requested` | ApprovalService | Pending tool-use approval record created | LedgerWriter → `approval_request` |
| `approval:resolved` | ApprovalService | Approval resolved (allow/deny) | LedgerWriter → `approval_decision` |
| `tool:call` | Bridge (`POST /ledger/tool-call`) | First-class Rondel tool (`rondel_bash`, future filesystem suite) completed — success or error | LedgerWriter → `tool_call` |
| `thread:completed` | *(Layer 4 seam — not yet wired)* | Ping-pong thread finishes | *(none yet)* |

Listeners are wired in [index.ts](apps/daemon/src/index.ts). The LedgerWriter subscribes to all hooks and writes structured JSONL events to `state/ledger/{agentName}.jsonl`. The `subagent:completed` listener also delivers the result to the parent agent by calling `sendMessage()` on the parent's conversation process — this triggers a new turn where the parent summarizes the findings for the user.

---

## 5b. Inter-Agent Messaging (Layer 2)

Agents can send async messages to each other via MCP tools. Messages are delivered to a synthetic "agent-mail" conversation per recipient, isolated from user conversations. Responses are automatically routed back to the sender.

### Design decisions

- **All async**: Inter-agent messages are always async. Subagents handle the "I need an answer now" case (ephemeral process, blocks on MCP tool call).
- **1-turn request-response**: Agent A sends → Agent B responds → reply delivered back to A. No multi-turn ping-pong (future Layer 4 concern).
- **Agent decides visibility**: No framework-level notifications to users. The agent's natural language response communicates collaboration status.
- **Org isolation**: Global agents are unrestricted. Same-org is allowed. Cross-org is blocked. Enforced at the bridge layer.
- **No disk-based message store**: Messages flow synchronously through bridge → router → `sendOrQueue`. The Claude CLI session IS the durable store (persisted via `--resume`). Messages sent while Rondel is down are lost — acceptable for v1.

### Message flow

```
1. Agent A calls rondel_send_message(to="agent-b", content="...")
     ↓ MCP tool → bridge POST /messages/send
   Bridge validates, checks org isolation, builds InterAgentMessage envelope
     ↓ hooks emit "message:sent" (→ ledger + console log)
   Bridge calls router.deliverAgentMail("agent-b", wrappedContent, replyTo)
     ↓
   Router calls getOrSpawnConversation("agent-b", "agent-mail") — lazy spawn
   Router calls sendOrQueue("agent-b", "agent-mail", wrappedContent)
     ↓ hooks emit "message:delivered"
   MCP tool returns { ok: true, message_id } to A

2. Agent B's agent-mail process receives the wrapped message
   B processes it and responds naturally
     ↓ Router buffers response text (not sent to Telegram)

3. Agent B goes idle
     ↓ Router flushes buffered response
   Wraps as "[Reply from agent-b — {id}]\n...\n[End of reply]"
   Calls sendOrQueue(A, originalChatId, wrappedReply)
     ↓
   Agent A receives reply in its original conversation
   A incorporates the information in its response to the user
```

### The agent-mail conversation

Each agent gets at most one agent-mail conversation — a separate Claude CLI process (keyed as `agentName:agent-mail`) that handles all incoming inter-agent messages. It is completely isolated from user conversations:

- **Same system prompt** as user conversations (same identity, memory, skills)
- **No Telegram binding** — responses are buffered by the Router, not sent to Telegram
- **No typing indicators** — silent processing
- **Reply routing** — the Router tracks which agent sent each message and automatically routes the first response back to the sender's original conversation
- **Serial processing** — messages queue (max 50) and process one at a time, each with its own reply-to tracking

### Org isolation

Three rules, enforced in `Bridge.checkOrgIsolation()`:

1. Global agent (no org) → can message any agent
2. Any agent → can message a global agent
3. Same-org → allowed; cross-org → blocked (HTTP 403)

The `rondel_list_teammates` tool pre-filters the list so agents only see reachable teammates.

### MCP tools

| Tool | Parameters | Description | Available to |
|------|-----------|-------------|--------------|
| `rondel_send_message` | `to: string`, `content: string` | Send async message to another agent. `from` and `reply_to_chat_id` injected from env vars. | All agents |
| `rondel_list_teammates` | (none) | List agents reachable from the caller (org-isolation-filtered). | All agents |

### Edge cases

- **Agent-mail process crashes**: Same crash recovery as user conversations. Reply-to info is lost (in-memory), but the message is in the agent's context — it can still send a response via `rondel_send_message`.
- **Sender's conversation gone by reply time**: `sendOrQueue` returns silently (existing behavior).
- **Multiple messages to same agent-mail**: Queue serially (max 50). Each carries its own `AgentMailReplyTo`. Processed one at a time.
- **Self-send**: Blocked at bridge validation (HTTP 400).

### Future considerations

- **Agent-mail idle timeout**: Agent-mail processes persist indefinitely once spawned. With 20+ agents, this means up to 20+ idle Node processes consuming OS memory. A future improvement: kill agent-mail processes after N minutes of idle, and re-spawn with `--resume` on the next incoming message (context preserved via Claude CLI session persistence). This is a ConversationManager concern — add an idle timer that calls `stop()` on the process and lets `getOrSpawn()` handle the `--resume` on next delivery.
- **Cross-org allowlists**: Currently cross-org messaging is blocked entirely. A future `allowedPairs` config in `config.json` would enable selective cross-org communication (e.g., a shared billing agent accessible to multiple client orgs).
- **Shared drive management**: Large artifacts are passed between agents via shared drive folders (`{org}/shared/drive/`). Currently a convention taught via skills — no framework-level cleanup, versioning, or access control. May need retention policies as usage grows.

---

## 5c. HITL Approvals (Per-tool Safety)

Agents run headless and Claude CLI has nowhere to surface a tool-use permission prompt. Rondel closes that gap by owning the primitives: `Bash`, `Write`, `Edit`, and `MultiEdit` are all on `FRAMEWORK_DISALLOWED_TOOLS`. All shell and filesystem work goes through first-class `rondel_*` MCP tools in [apps/daemon/src/tools/](apps/daemon/src/tools/). Each tool is responsible for its own safety classifier, human-approval escalation, and `tool_call` ledger emission — there is no single "safety net" choke point anymore.

The classification logic (what counts as dangerous) lives in [apps/daemon/src/shared/safety/](apps/daemon/src/shared/safety/) as pure TypeScript with zero runtime dependencies, shared by every `rondel_*` tool that needs it.

See [apps/daemon/src/approvals/](apps/daemon/src/approvals/) for the `ApprovalService`, Telegram approval-card rendering, and web `/approvals` endpoints.

### Philosophy

"AI employee, not gated intern." The default answer for every tool call is **allow**. Each `rondel_*` tool only asks a human when its own classifier flags the call — e.g., `rondel_bash` escalates destructive patterns (`rm -rf /`, `dd`, `mkfs`, `curl|sh`, fork bombs, system-path redirects), and the filesystem tools escalate writes outside the agent's safe zones (`RONDEL_AGENT_DIR`, `~/.rondel/workspaces`, `/tmp`) or content that looks like a leaked secret. Mirrors OpenClaw's model (broad capability with a narrow audit surface around `exec`).

### Per-tool approval flow

```
1. Agent calls rondel_<tool>(...)  [inside the MCP server process]
2. Tool-specific classifier runs locally
   - allow    → proceed with the primitive (spawn/read/write)
   - escalate → POST /approvals/tool-use  → { requestId }
                Poll GET /approvals/:id every 1s (max 30 min)
3. ApprovalService.requestToolUse() persists pending/<id>.json,
   emits "approval:requested" hook (→ LedgerWriter),
   calls Telegram adapter sendInteractive(chat, text, [Approve, Deny])
4. User taps button OR resolves via /approvals web page
   → ApprovalService.resolve(id, decision, "telegram:<uid>" | "web")
   → move pending/<id>.json → resolved/<id>.json
   → emit "approval:resolved" hook (→ LedgerWriter)
   → unblock in-process resolver
5. Tool resumes: deny → returns tool_error to the agent; allow → runs
   the primitive. Either way, POST /ledger/tool-call records the
   outcome (success, error, denied).
```

### No external hook

There is no PreToolUse hook and no external deny-and-explain redirector. Native `Bash` / `Write` / `Edit` / `MultiEdit` / `AskUserQuestion` are refused at `--disallowedTools` level before any handler runs; all shell, filesystem, and structured-prompt operations go through first-class `rondel_*` MCP tools. `AgentConfig.permissionMode` has been removed — safety classification is per-tool, not per-agent.

### Key invariants

1. **Tool-owned safety.** Each `rondel_*` tool's classifier runs in the MCP server process, synchronous with the tool call. No hook hop, no 1 Hz polling.
2. **Approvals route to the *originating* conversation.** The MCP server process knows its conversation via env vars (`RONDEL_PARENT_CHANNEL_TYPE`, `RONDEL_PARENT_CHAT_ID`, `RONDEL_PARENT_AGENT`) injected at spawn time. No global "activity channel".
3. **Pending records are auto-denied on restart.** The in-memory resolver map cannot survive a daemon restart, so `recoverPending()` walks the pending directory at startup and moves every orphan to resolved with reason `"daemon-restart"` before agents spawn.

### Web UI fallback

`GET /approvals` returns pending + recent resolved records. `GET /approvals/tail` streams `approval.requested` / `approval.resolved` frames over SSE so the web `/approvals` page reflects new escalations in real time (no polling). Operators Approve/Deny directly via `POST /approvals/:id/resolve`. Same backend, same resolver — Telegram and web resolutions are interchangeable.

### Deferred work — grep `TODO(hitl-future):`

- Agent-initiated approvals via a `rondel_request_approval` MCP tool
- Org-level activity channel fallback for cron-triggered or subagent requests
- Config-driven danger heuristics (hot-reloadable, per-agent overrides)
- Reply-based approvals for text-only channels
- Approval request batching

---

## 5d. First-class Rondel tools

Phase 4 completes the migration: native `Bash` / `Write` / `Edit` / `MultiEdit` are disallowed, and every shell or filesystem operation goes through a first-class MCP tool implemented directly in Rondel's MCP server process — [apps/daemon/src/tools/](apps/daemon/src/tools/). These tools run in a Node process spawned by Claude CLI (but not *Claude's* code), so `child_process.spawn`, `fs.writeFileSync`, etc. bypass Claude Code's hardcoded protected-path and bash-validation surfaces entirely. Ownership of the primitive is explicit: safety, approval, and observability live in Rondel's TypeScript, not in Claude Code's internals.

### `rondel_bash`

The shell entry point. Runs commands with the same safety classifier the legacy `Bash` hook used — but in-process, synchronous with the tool call.

```
1. Agent calls rondel_bash({command, working_directory?, timeout_ms?})
2. classifyBash(command) from shared/safety/
   - allow    → proceed
   - escalate → POST /approvals/tool-use, poll GET /approvals/:id
                until resolved (deny → tool_error; allow → proceed)
3. spawn bash -c command with AbortController timeout + SIGKILL
4. Collect stdout/stderr (truncated at 100_000 chars)
5. POST /ledger/tool-call → tool_call ledger event
6. Return JSON {stdout, stderr, exit_code, duration_ms, truncated, error?}
```

Inputs are always JSON-parseable on return — success, error, timeout, denial, and missing-env paths all produce structured output. Bridge context (URL, agent name, channel type, chat id) flows via env vars set at MCP spawn time; missing context returns `tool_error` immediately.

### Filesystem suite: `rondel_read_file`, `rondel_write_file`, `rondel_edit_file`, `rondel_multi_edit_file`

Four first-class filesystem tools implemented in [apps/daemon/src/tools/](apps/daemon/src/tools/) and backed by two daemon-side stores in [apps/daemon/src/filesystem/](apps/daemon/src/filesystem/). Native `Write` / `Edit` / `MultiEdit` are on `FRAMEWORK_DISALLOWED_TOOLS` — the `rondel_*` suite is the only way agents touch the filesystem.

**Shared rules:**

- Absolute paths only; no UNC, no null bytes.
- `scanForSecrets()` over every write payload; matches escalate (`potential_secret_in_content`).
- `isPathInSafeZone()` enforces the agent-dir / `~/.rondel/workspaces` / `/tmp` boundary; outside targets escalate (`write_outside_safezone`).
- Backups precede every overwrite — `FileHistoryStore.backup()` captures the on-disk pre-image into `state/file-history/{agent}/{pathHash}-{ts}.pre` with a `.meta.json` sidecar.
- Every completion emits a `tool_call` ledger event.

**Read-first staleness anchor.** `rondel_read_file` records `sha256(content)` in the in-memory `ReadFileStateStore`, keyed on `(agent, sessionId, path)`. Write/edit/multi-edit consult that record before overwriting an existing file:

| Situation | Behaviour |
|-----------|-----------|
| File does not exist | `rondel_write_file` creates without a prior read. `rondel_edit_file` and `rondel_multi_edit_file` return `tool_error` — edits cannot create files. |
| File exists, no read record | `rondel_write_file` escalates `write_without_read`. `rondel_edit_file`/`multi_edit` return `tool_error` (read first; edit implies knowledge of structure). |
| File exists, recorded hash matches on-disk content | Proceed. |
| File exists, recorded hash differs from on-disk content | All three escalate `write_without_read` — somebody else wrote to the file since the agent read it. |
| Read was truncated (file > `max_bytes`) | Store is NOT updated; a later write/edit will fail staleness against the full on-disk content. Agent must re-read with a larger `max_bytes`. |

Successful writes register the post-write hash as the new read-state record, so subsequent writes in the same session don't re-escalate against the agent's own output.

Session lifecycle: `ReadFileStateStore` subscribes to `session:crash` / `session:halt` and purges records for the failing `(agent, sessionId)`. `/new` (session reset) drops the old sessionId, so records keyed on it become unreachable — the agent is forced to re-read under the fresh sessionId. Daemon restart drops the whole map.

**Contracts in short:**

- `rondel_read_file({path, max_bytes?})` → `{content, size, truncated, hash, path}`. No approval. Truncated=true means the staleness anchor was NOT recorded.
- `rondel_write_file({path, content})` → `{operation: "create"|"update", path, backupId, bytesWritten}`. Creates or overwrites. Overwrites require a matching prior read or escalate.
- `rondel_edit_file({path, old_string, new_string, replace_all?})` → `{path, replacedCount, backupId, bytesWritten}`. Hard requirement: prior `rondel_read_file` in this session. `replace_all=false` requires exactly one match; `replace_all=true` requires at least one.
- `rondel_multi_edit_file({path, edits: [...]})` → `{path, editCount, totalReplacements, backupId, bytesWritten}`. All-or-nothing: any edit whose `old_string` doesn't match its required occurrence count aborts the whole operation with the failing edit's index; no disk change.

### `tool_call` ledger event

Every first-class tool emits a `tool_call` ledger event on completion. The bridge receives the event via `POST /ledger/tool-call`, validates it against `ToolCallEventSchema`, and the existing `LedgerWriter` appends the entry. Pre-execution failures (missing env, invalid working_directory, approval denial) do not emit — the approval service already records denials via `approval_request`/`approval_decision`.

```json
{
  "ts": "2026-04-18T12:00:00.000Z",
  "agent": "bot1",
  "kind": "tool_call",
  "channelType": "telegram",
  "chatId": "123",
  "summary": "Tool rondel_bash: rondel_bash: ls -la (success)",
  "detail": {
    "toolName": "rondel_bash",
    "outcome": "success",
    "durationMs": 12,
    "exitCode": 0
  }
}
```

This gives 99% of agent activity a single queryable event kind (today only escalations produce ledger entries).

---

## 6. Scheduler (Cron Jobs)

Timer-driven job runner ([scheduler.ts](apps/daemon/src/scheduling/scheduler.ts)). Reads `crons` from agent configs, manages timers, executes jobs, and delivers results. Follows OpenClaw's three-way separation: where it runs (session target) / what it does (payload) / where output goes (delivery).

### Config

Cron jobs are declared in `agent.json` under the `crons` array:

```json
{
  "crons": [
    {
      "id": "daily-summary",
      "name": "Daily Summary",
      "schedule": { "kind": "every", "interval": "24h" },
      "prompt": "Generate a daily summary.",
      "delivery": { "mode": "announce", "chatId": "123456" }
    }
  ]
}
```

### Session targets

| Target | How it runs | Use case |
|--------|------------|----------|
| `isolated` (default) | Fresh SubagentProcess per run. No prior context. | Most cron jobs — summaries, checks, reports |
| `session:<name>` | Persistent AgentProcess keyed as `{agentName}:cron:{name}`. Context accumulates across runs. | Workflows needing continuity — "compare today to yesterday" |

### Delivery modes

| Mode | What happens |
|------|-------------|
| `none` (default) | Result logged only. Agent can send to Telegram via MCP tools during its turn if it decides to |
| `announce` | Result text sent to a specific Telegram chat via the adapter |

### Execution flow

```
1. Startup:
   Load crons from agent configs → compute nextRunAtMs → arm timer
   Check for missed jobs (overdue since last shutdown) → stagger-execute

2. Timer fires:
   Run all due jobs sequentially
   For each job:
     isolated → AgentManager.spawnCronRun() → SubagentProcess
     session:<name> → AgentManager.getOrSpawnConversation() → AgentProcess.sendMessage()
   Route output via delivery config
   Update state (lastRunAtMs, consecutiveErrors, nextRunAtMs)
   Emit hooks (cron:completed or cron:failed)
   Persist state to disk
   Rearm timer

3. Error handling:
   Backoff schedule: [30s, 1m, 5m, 15m, 60m] based on consecutiveErrors
   Reset to 0 on success
```

### State persistence

Minimal state persisted to `~/.rondel/state/cron-state.json`:
- `lastRunAtMs`, `nextRunAtMs`, `consecutiveErrors`, `lastStatus`, `lastError`, `lastDurationMs`, `lastCostUsd`

Written atomically after each job execution and on shutdown. Enables missed job detection on restart.

### Config hot-reload

The scheduler watches each agent's `agent.json` for changes using `fs.watch`. When a config file changes:

1. Debounce (300ms) to coalesce rapid edits
2. Reload `agent.json` from disk, parse `crons` array
3. Diff against current jobs — add new ones, remove deleted ones, update changed ones in place
4. Preserve state (consecutiveErrors, lastRunAtMs) for unchanged jobs
5. Re-arm timer

No Rondel restart needed. Add a cron → it starts running within 300ms. Remove a cron → it stops immediately. Follows OpenClaw's hybrid reload pattern.

---

## 7. MCP Tool Injection

### Architecture

The MCP server runs as a **separate process** spawned by Claude CLI, not by Rondel. Communication between Claude and the MCP server uses stdio (MCP protocol). The MCP server calls Telegram API directly — no HTTP bridge back to Rondel core.

### Config construction

`AgentManager.getOrSpawnConversation()` builds the MCP config map ([agent-manager.ts:114](apps/daemon/src/agents/agent-manager.ts#L114)):

```typescript
const mcpConfig: McpConfigMap = {
  rondel: {                                    // always present
    command: "node",
    args: [this.mcpServerPath],                  // resolved at module load
    env: { RONDEL_BOT_TOKEN: template.config.telegram.botToken },
  },
  ...template.config.mcp?.servers,               // user-defined servers merged in
};
```

### Temp file lifecycle

`AgentProcess.writeMcpConfigFile()` writes `{ mcpServers: { ... } }` to a temp file in `$TMPDIR/rondel-mcp/` ([agent-process.ts:253](apps/daemon/src/agents/agent-process.ts#L253)). The path is passed to Claude via `--mcp-config`. File is cleaned up on `stop()` ([agent-process.ts:273](apps/daemon/src/agents/agent-process.ts#L273)).

### Tools exposed

| Tool | Parameters | Description | Data source |
|------|-----------|-------------|-------------|
| `rondel_send_telegram` | `chat_id: string`, `text: string` | Send text message (Markdown, 4096-char chunking) | Telegram API (direct) |
| `rondel_send_telegram_photo` | `chat_id: string`, `image_path: string`, `caption?: string` | Send local image via multipart upload | Telegram API (direct) |
| `rondel_list_agents` | (none) | List all agent templates + active conversation states | Bridge → AgentManager |
| `rondel_agent_status` | `agent_name: string` | Get conversations for a specific agent (chatId, state, sessionId) | Bridge → AgentManager |
| `rondel_spawn_subagent` | `task`, `template?`, `system_prompt?`, `working_directory?`, `model?`, `max_turns?`, `timeout_ms?` | Spawn an ephemeral subagent to execute a task | Bridge → AgentManager → SubagentProcess |
| `rondel_subagent_status` | `subagent_id: string` | Check subagent state and retrieve result | Bridge → AgentManager |
| `rondel_kill_subagent` | `subagent_id: string` | Kill a running subagent | Bridge → AgentManager → SubagentProcess |
| **Inter-agent messaging (all agents)** | | | |
| `rondel_send_message` | `to`, `content` | Send async message to another agent. Response auto-delivered back | Bridge → Router → agent-mail conversation |
| `rondel_list_teammates` | (none) | List agents reachable from the caller (org-isolation-filtered) | Bridge → AgentManager |
| `rondel_memory_read` | (none) | Read current agent's MEMORY.md content | Bridge → filesystem |
| `rondel_memory_save` | `content: string` | Overwrite agent's MEMORY.md (atomic write) | Bridge → filesystem |
| **Conversation ledger (all agents)** | | | |
| `rondel_ledger_query` | `agent?`, `since?`, `kinds?`, `limit?` | Query activity ledger — returns structured events (summaries, not full content) | Bridge → LedgerReader → `state/ledger/*.jsonl` |
| **Runtime skill reload (all agents)** | | | |
| `rondel_reload_skills` | (none) | Schedule a post-turn restart of the calling conversation's process so newly-authored per-agent skills become discoverable. Session preserved via `--resume` | Bridge → ConversationManager.scheduleRestartAfterTurn() |
| **System status (all agents)** | | | |
| `rondel_system_status` | (none) | System overview: uptime, agent count, per-agent conversations | Bridge → AgentManager |
| **Admin tools (admin agents only — gated by `RONDEL_AGENT_ADMIN=1` env var)** | | | |
| `rondel_add_agent` | `agent_name`, `bot_token`, `model?`, `location?` | Scaffold new agent + register + start Telegram polling | Bridge → scaffold → AgentManager.registerAgent() |
| `rondel_update_agent` | `agent_name`, `model?`, `enabled?`, `admin?` | Patch agent.json fields, refresh template | Bridge → AgentManager.updateAgentConfig() |
| `rondel_reload` | (none) | Re-discover all agents, register new ones, refresh existing | Bridge → discoverAgents → AgentManager |
| `rondel_delete_agent` | `agent_name` | Unregister + delete agent permanently | Bridge → AgentManager.unregisterAgent() + rm |
| `rondel_set_env` | `key`, `value` | Set env var in .env file + process.env | Bridge → filesystem |

### User-defined MCP servers

Agents can declare additional MCP servers in `agent.json` under `mcp.servers`. These are merged with the built-in `rondel` server at spawn time. Environment variable substitution (`${VAR}`) works in MCP server entries since `agent.json` goes through `parseJsonWithEnv()` before parsing:

```json
{
  "mcp": {
    "servers": {
      "postgres": {
        "command": "uvx",
        "args": ["postgres-mcp-server"],
        "env": { "DATABASE_URL": "${DB_URL}" }
      }
    }
  }
}
```

### MCP discovery from working directory

We do **not** use `--strict-mcp-config`. This means Claude CLI also discovers MCP servers from standard sources — project `.mcp.json` files, user settings, etc. This is intentional: when an agent spawns in a specific working directory (via `workingDirectory` in agent config), it should pick up that project's `.mcp.json` alongside Rondel's injected servers. The agent gets Rondel tools + whatever the target project provides.

---

## 7.5. Skills (On-Demand Instruction Loading)

### Architecture

Skills are Claude Code native skills (SKILL.md files with YAML frontmatter) discovered via `--add-dir` at spawn time. They teach agents HOW to do things — step-by-step workflows loaded on-demand, not baked into the system prompt.

**Key insight: Skills ≠ Permissions.** Skills are informational (any agent can read any skill). Admin permissions are handled at the MCP tool layer (`RONDEL_AGENT_ADMIN` gating from Phase 8). A non-admin agent reading a "create agent" skill can't execute it because it lacks the `rondel_add_agent` MCP tool.

### Discovery (two `--add-dir` flags per spawn)

1. `--add-dir <agentDir>` → discovers `<agentDir>/.claude/skills/` (per-agent skills, user-created)
2. `--add-dir <frameworkSkillsDir>` → discovers `templates/framework-skills/.claude/skills/` (framework skills, always current from source)
3. If agent has `workingDirectory`, cwd-based discovery finds `.claude/skills/` in the project too (native Claude CLI behavior)

Framework skills resolve from the installed code — never copied, never stale. Per-agent skills are the user's space.

### Framework skills (shipped with Rondel)

```
templates/framework-skills/.claude/skills/
├── rondel-create-agent/SKILL.md     # Agent creation workflow (clarify → BotFather → confirm → act)
├── rondel-delete-agent/SKILL.md     # Agent deletion with confirmation (irreversible)
├── rondel-delegation/SKILL.md       # Subagent vs agent decision framework
├── rondel-manage-config/SKILL.md    # Config/env/reload with confirmation
└── rondel-create-skill/SKILL.md     # Runtime skill self-authoring — agent writes a new SKILL.md
                                     # under its own `<agentDir>/.claude/skills/` and calls
                                     # `rondel_reload_skills` to make it discoverable
```

### How skills trigger

Claude CLI loads skill descriptions into agent context automatically. The model pattern-matches user requests against descriptions and invokes matching skills via the `Skill` tool. The agent then reads the full SKILL.md and follows its instructions. Only the lightweight description is in every session — full content loads on-demand.

### Per-agent skills

Each agent directory has `.claude/skills/` (created at scaffold time). Users or agents can drop SKILL.md files there to teach the agent custom workflows. These are discovered via the `--add-dir <agentDir>` flag.

### Runtime skill self-authoring (post-turn restart)

Skill discovery happens at process spawn — Claude CLI reads `--add-dir` roots when the process starts, not during a turn. To let agents author new skills without losing their session, Rondel uses a **flag-and-consume** pattern that restarts the process *between* turns, never mid-turn.

**Components:**

- **`rondel-create-skill` framework skill** — the user-facing entry point. Walks the agent through writing `<agentDir>/.claude/skills/<name>/SKILL.md` using `Write`, then calls `rondel_reload_skills`.
- **`rondel_reload_skills` MCP tool** — available to every agent (not admin-gated: it only affects the calling conversation's own process, no cross-agent impact). Posts to `POST /agent/schedule-skill-reload` with `{ agent_name, channel_type, chat_id }` (validated by `ScheduleSkillReloadSchema`) and returns immediately with a "scheduled — finish your turn normally" message. The tool never restarts synchronously, because a tool that kills its own process would lose the `result` event for the turn that called it.
- **`ConversationManager.pendingRestarts: Set<ConversationKey>`** — a general-purpose "restart this conversation on the next idle transition" primitive with three methods: `scheduleRestartAfterTurn`, `hasPendingRestart`, `clearPendingRestart`. Nothing in the types mentions skills — any future feature that needs to re-read `--add-dir` roots or MCP config mid-session can reuse the same seam.
- **Router consumes the flag before drain.** Both `wireUserProcess` and `wireAgentMailProcess` check `pendingRestarts` at the top of their `idle` branch, *before* queue drain. If set, they clear the flag and call `process.restart()` (stop → 1s delay → start), then return early. The fresh process fires its own idle event on spawn and drains the queue naturally via the existing `sendOrQueue` machinery. Queued messages that arrived during the restart window are preserved.
- **Crash / halt clear the flag.** Both branches call `clearPendingRestart` unconditionally — crash recovery already reloads skills via the next spawn, so an additional post-recovery restart would be wasted work and would double-fire the turn that triggered it.

**Session continuity** is provided by existing mechanics: `AgentProcess.restart()` reuses `this.sessionId` with `--resume`, `writeMcpConfigFile()` and `--add-dir` are re-executed on every spawn, and the new skill becomes visible because Claude CLI rediscovers the per-agent skills directory at startup.

**Scope:** per-agent only. Org-wide (`<orgDir>/shared/.claude/skills/`) and global (`workspaces/global/.claude/skills/`) authoring scopes are deferred — a bug in one agent's self-authored skill must not affect siblings.

---

## 8. HTTP Bridge (MCP ↔ Rondel Core)

### Purpose

MCP server processes are spawned by Claude CLI, not by Rondel — they run in a separate process tree. The bridge is the communication channel back to Rondel core. Telegram tools don't need it (they call Telegram API directly), but any tool that needs Rondel state (agent list, conversation status, and eventually subagent spawning, inter-agent messaging) goes through the bridge.

### Internal structure

The bridge is split into three files:
- **`bridge.ts`** — HTTP server lifecycle, request routing, read-only endpoints (agents, conversations, subagents, memory, orgs), inter-agent messaging endpoints (`/messages/send`, `/messages/teammates`), org isolation enforcement, body parsing helpers. Admin mutation routes are delegated to AdminApi. Receives `hooks` and `router` for messaging delivery.
- **`admin-api.ts`** — Business logic for admin mutations (add/update/delete agent, add org, reload, set env, system status). Methods return `{ status, data }` — the bridge handles HTTP response writing. This keeps admin logic HTTP-framework-agnostic and testable.
- **`schemas.ts`** — Zod validation schemas for admin, messaging, web-chat, and HITL approval request/response bodies. Validated at the boundary before business logic runs. `BRIDGE_API_VERSION` (currently `6`) pinned here.

### Transport

- Node `http` server on `127.0.0.1` with OS-assigned random port
- MCP server receives the URL via `RONDEL_BRIDGE_URL` env var
- Localhost-only, no authentication — same-machine, same-user IPC
- Started before channel adapters at boot

### Endpoints

| Method | Path | Returns |
|--------|------|---------|
| `GET` | `/agents` | All agent templates with active conversation count and per-conversation state |
| `GET` | `/conversations/:agentName` | Conversations for a specific agent (chatId, state, sessionId) |
| `POST` | `/subagents/spawn` | Spawn a subagent — returns SubagentInfo with id and state |
| `GET` | `/subagents` | List all subagents (optional `?parent=agentName` filter) |
| `GET` | `/subagents/:id` | Get subagent state, result, cost, timing |
| `DELETE` | `/subagents/:id` | Kill a running subagent |
| `GET` | `/memory/:agentName` | Read agent's MEMORY.md content (null if doesn't exist) |
| `PUT` | `/memory/:agentName` | Write agent's MEMORY.md (atomic write, creates if missing) |
| `POST` | `/agent/schedule-skill-reload` | Schedule a post-turn restart of the specified conversation's process. Body: `{ agent_name, channel_type, chat_id }` (validated by `ScheduleSkillReloadSchema`). Returns immediately; the Router consumes the flag on the next `idle` transition |
| **Conversation ledger** | | |
| `GET` | `/ledger/query?agent=&since=&kinds=&limit=` | Query structured event log. Filters by agent, time range, event kinds. Returns newest-first |
| **Live streams (SSE)** | | |
| `GET` | `/ledger/tail[?since=<ISO>]` | System-wide live ledger. Optional `since` replays events newer than the cursor before the live stream attaches |
| `GET` | `/ledger/tail/:agent[?since=<ISO>]` | Per-agent live ledger. Server-side filter applied at the handler boundary — single shared upstream subscription fans out to all clients |
| `GET` | `/agents/state/tail` | Live conversation state. One `agent_state.snapshot` frame on connect, then `agent_state.delta` frames per state transition |
| `GET` | `/conversations/:agent/:channelType/:chatId/history` | Ordered user/assistant turns for a conversation, parsed from the Claude CLI transcript file. Returns `{ turns: ConversationTurn[], sessionId }`. Unknown `channelType` → 400. No session yet → `{ turns: [], sessionId: null }`. Turns are capped at the most recent 200 (MVP ceiling — a long chat becomes hundreds of turns and the web UI only needs recent context to rehydrate; tune if needed) |
| `GET` | `/conversations/:agent/:channelType/:chatId/tail` | Per-conversation live SSE stream. New `ConversationStreamSource` constructed per request, disposed on socket close. Emits `conversation.frame` events with a `kind`-discriminated payload (`user_message`, `agent_response`, `typing_start`, `typing_stop`, `session`). For web conversations, replays the adapter's ring buffer before live frames. Unknown `channelType` → 400 |
| `GET` | `/version` | `{ apiVersion, rondelVersion }` — version handshake for clients on boot. `apiVersion` is `BRIDGE_API_VERSION` from `bridge/schemas.ts` (currently `12` — v5 added HITL Tier 1, v6 added the short-lived Tier 2 AskUserQuestion proxy, v7 removed it so only tool-use records remain, v8 dropped the dead `unsupported_tty_tool` reason and added `potential_secret_in_content`, v9 added the `tool_call` ledger event kind and the `POST /ledger/tool-call` endpoint for first-class Rondel tools like `rondel_bash`, v10 added the filesystem tool suite — `ReadFileStateStore` + `FileHistoryStore`, `POST`/`GET` `/filesystem/read-state/:agent`, `POST`/`GET` `/filesystem/history/:agent{/:backupId}`, `ApprovalReason.write_without_read`, and first-class tools `rondel_read_file` / `rondel_write_file` / `rondel_edit_file` / `rondel_multi_edit_file`, v11 flipped the switch — native `Bash` / `Write` / `Edit` / `MultiEdit` added to `FRAMEWORK_DISALLOWED_TOOLS` and the PreToolUse hook reduced to a transitional deny-and-explain redirector, v12 removed the transitional hook entirely — no more `state/agent-runtime/` or `.claude/settings.json` stamping, added `GET /approvals/tail` (SSE) + `POST /prompts/ask-user` + `GET /prompts/ask-user/:id`, shipped `rondel_ask_user`, dropped `AgentConfig.permissionMode`) |
| **Web chat** | | |
| `POST` | `/web/messages/send` | Inject a user message into a web conversation. Body: `{ agent_name, chat_id, text }` (chat_id must start with `web-`). Validated with `WebSendRequestSchema`. Normalizes to `ChannelMessage` via `WebChannelAdapter.ingestUserMessage()` and dispatches through the shared Router pipeline — same `sendOrQueue` path as Telegram. Pre-validates that the agent has a live synthetic web account and returns 503 if not |
| **HITL approvals** | | |
| `POST` | `/approvals/tool-use` | Create a tool-use approval request (called by `rondel_*` MCP tools when their classifier escalates). Returns `{ requestId }` immediately; the caller polls GET. Body validated with `ToolUseApprovalCreateSchema` |
| `GET` | `/approvals/:id` | Get a single approval record (pending or resolved). Used by tool polling and web UI drill-in |
| `GET` | `/approvals` | List pending + recent resolved records. Web UI `/approvals` page consumes this |
| `POST` | `/approvals/:id/resolve` | Resolve a tool-use approval (allow/deny). Body: `{ decision, resolvedBy? }`. Used by the web UI. Telegram resolves via interactive-callback handler in the orchestrator, not this endpoint |
| `GET` | `/approvals/tail` | Live SSE stream of `approval.requested` / `approval.resolved` frames. Web `/approvals` page subscribes and folds new frames into the server-rendered initial list — replaces the previous 2s polling refresher |
| **Ask-user prompts** | | |
| `POST` | `/prompts/ask-user` | Create a structured multiple-choice prompt (called by the `rondel_ask_user` MCP tool). Body: `AskUserCreateSchema` (`agentName`, `channelType`, `chatId`, `prompt`, `options[1..8]`, `timeout_ms?`). Dispatches an interactive message to the originating channel with callback data `rondel_aq_<requestId>_<optIdx>`. Returns `{ requestId }`. In-memory only — no disk persistence |
| `GET` | `/prompts/ask-user/:id` | Poll a pending prompt. Returns `{status: "pending"}`, `{status: "resolved", selected_index, selected_label, resolvedBy?}`, or `{status: "timeout"}`. 404 if the id is unknown (e.g. after a daemon restart; the MCP tool treats this as a timeout) |
| **First-class Rondel tools** | | |
| `POST` | `/ledger/tool-call` | Record a `tool_call` ledger event. Called by first-class Rondel MCP tools (`rondel_bash`, filesystem suite) after execution. Body validated with `ToolCallEventSchema`. Emits the `tool:call` hook event, which `LedgerWriter` turns into a per-agent JSONL entry |
| `POST` | `/filesystem/read-state/:agent` | Record a successful read by `rondel_read_file`. Body: `RecordReadSchema` (`sessionId`, `path`, `contentHash` sha256). Populates the `ReadFileStateStore` so downstream writes/edits can enforce the read-first staleness invariant |
| `GET` | `/filesystem/read-state/:agent?sessionId=X&path=Y` | Return the recorded `{contentHash, readAt}` for the key, or 404 if no record exists. Consulted by write/edit/multi-edit before overwriting |
| `POST` | `/filesystem/history/:agent/backup` | Capture a file pre-image before overwrite. Body: `BackupCreateSchema` (`originalPath`, `content`). Returns `{backupId}`. Routes through the daemon so `FileHistoryStore` owns the on-disk layout |
| `GET` | `/filesystem/history/:agent?path=P` | List backups, newest first, optionally filtered to a single `originalPath`. Used for manual recovery |
| `GET` | `/filesystem/history/:agent/:backupId` | Return `{originalPath, content}` for a specific backup |
| **Inter-agent messaging** | | |
| `POST` | `/messages/send` | Send message to another agent — validates, checks org isolation, delivers via router |
| `GET` | `/messages/teammates?from=name` | List agents reachable from the caller (org-isolation-filtered) |
| **Admin** | | |
| `GET` | `/admin/status` | System status: uptime, agent count, per-agent model/admin/conversations |
| `POST` | `/admin/agents` | Create + register + start a new agent (scaffold + hot-add) |
| `PATCH` | `/admin/agents/:name` | Update agent config fields (model, enabled, admin) |
| `POST` | `/admin/reload` | Re-discover agents from workspaces, register new, refresh existing |
| `DELETE` | `/admin/agents/:name` | Unregister agent, stop polling, kill conversations, delete directory |
| `PUT` | `/admin/env` | Set env var in .env + process.env |

### Request flow

**Read-only (handled directly by Bridge):**
```
Agent calls rondel_list_agents
  → Claude CLI → MCP server tool via stdio
  → mcp-server.ts bridgeCall("/agents")
  → bridge.ts handleListAgents()
  → agentManager.getAgentNames() + getConversationsForAgent()
  → JSON response back through the chain
```

**Admin mutation (delegated to AdminApi):**
```
Agent calls rondel_add_agent
  → Claude CLI → MCP server tool via stdio
  → mcp-server.ts bridgeCall("POST /admin/agents", body)
  → bridge.ts delegateAdmin(() => admin.addAgent(body))
  → admin-api.ts addAgent(): validateBody(AddAgentSchema) → scaffold → register
  → { status: 201, data: { ok: true, agent_name, ... } }
  → bridge.ts sendJson(res, result.status, result.data)
```

---

## 8b. Live Streams (SSE)

The web UI needs a live picture of what's happening inside the daemon — new ledger events as agents converse, and conversation-state transitions as processes go idle → busy → crashed. Rather than polling, the bridge exposes Server-Sent Events endpoints that push deltas as they happen.

### Design

- **One source per stream type, N clients fan out from it.** `LedgerStreamSource` subscribes once to `LedgerWriter.onAppended`; `AgentStateStreamSource` subscribes once to `ConversationManager.onStateChange`. Each SSE client gets a `subscribe(send)` closure and unsubscribes on disconnect. Sources are constructed in [index.ts](apps/daemon/src/index.ts) at startup and disposed in the shutdown sequence after the bridge stops accepting new connections.
- **Protocol-agnostic sources, one wire-format handler.** `streams/sse-types.ts` defines a tiny `StreamSource<T>` interface (`subscribe`, optional `snapshot`, `dispose`). The generic `handleSseRequest` in `streams/sse-handler.ts` is the only place that knows the SSE wire format. Future stream sources (system status, cron status, …) stay cheap to add.
- **Filtering at the boundary, not the source.** The `/ledger/tail/:agent` endpoint builds a per-client `filter` closure; the handler applies it before each write. The shared upstream subscription stays single-listener — one `LedgerWriter.onAppended` regardless of how many per-agent clients are connected.
- **Subscribe → replay → flush → live.** To prevent the "subscribed but not yet replayed" gap: the handler subscribes FIRST, routes deltas into a buffer, then runs `source.snapshot()` (if implemented) and the per-request `replay` (if provided), flushes the buffer in arrival order, and finally switches to direct-write live mode. Deltas that arrive during the prefix phase are delivered in order, none lost.
- **Heartbeats + dual cleanup.** 25s SSE comment heartbeats keep connections alive through any future intermediary (nginx 60s, Cloudflare 100s). Both `req.on("close")` and `res.on("error")` are wired to cleanup — either alone is insufficient because `EPIPE` on a write to a dead socket races the close event and only fires via `res.on("error")`.

### Frame format

The wire payload uses the default `message` SSE event — NOT named events — and carries the discriminator inside the JSON:

```
data: {"event":"ledger.appended","data":{...LedgerEvent}}

data: {"event":"agent_state.snapshot","data":{"kind":"snapshot","entries":[...]}}

data: {"event":"agent_state.delta","data":{"kind":"delta","entry":{...}}}
```

This keeps the generic consumer hook simple on the web side — parse `msg.data`, discriminate on `.event` in JS. Named SSE events would force clients to register `addEventListener` for each tag, defeating the abstraction.

### Ledger tail

`LedgerWriter.onAppended(cb)` was added as a synchronous listener registry. It fires BEFORE the disk write completes — subscribers see events at emit time so they don't pay fs latency. Same fire-and-forget contract as the disk write itself: broken listeners are swallowed and must never crash the emitter or block other listeners.

`/ledger/tail[/:agent]` accepts an optional `?since=<ISO8601>` parameter. When present, the handler's `replay` closure calls `queryLedger()` to backfill events newer than the cursor, in oldest-first order, before any live frames arrive. The web client passes the timestamp of the newest historical event it already has from its server-rendered fetch, so the visible timeline never has a gap between "historical" and "live."

### Agent state tail

`ConversationManager.onStateChange(cb)` emits an `AgentStateEvent` for every conversation state transition (`starting → idle → busy → idle → …`), not just the crash/halt subset that goes to RondelHooks / the ledger. `ConversationManager.getAllConversationStates()` returns one entry per active conversation for the snapshot frame.

On connect, the web client receives one `agent_state.snapshot` frame with an array of entries (replaces the client's Map keyed by conversationKey), then one `agent_state.delta` frame per subsequent transition (sets one entry in the Map).

### Per-conversation tail

`ConversationStreamSource` is the third stream source, but differs from the other two in an important way: **it is constructed per request**, not once at startup. The ledger and agent-state sources are long-lived singletons with a single upstream subscription each, fanning out to N clients. A per-conversation source doesn't fit that shape — we don't want to hold one `RondelHooks` subscription per known conversation forever; we only want listeners while a tab is actually open to that conversation.

The bridge handler for `GET /conversations/{agent}/{channelType}/{chatId}/tail` therefore:

1. Constructs a new `ConversationStreamSource` scoped to the target conversation. The constructor wires `conversation:message_in`, `conversation:response`, and the five session lifecycle hooks, filtered by `(agentName, chatId)` in memory. For web channels only, it also subscribes to the `WebChannelAdapter`'s per-conversation fan-out to receive typing indicators.
2. Passes the source into `handleSseRequest` with a `replay` callback that drains the web adapter's ring buffer (no-op for non-web channels, which rehydrate from `/history` on the client side).
3. Disposes the source when the socket closes, which unsubscribes from every hook and the web adapter.

`ConversationStreamSource.translateWebFrame()` deliberately returns `null` for the adapter's `agent_response` frames — those are already emitted via the `conversation:response` hook subscription, and double-emitting would duplicate them in the browser timeline. Only `typing_start` / `typing_stop` come from the web adapter; everything else comes from hooks.

Clients consume both channels through one SSE stream with a single frame shape. The reason the per-conversation source taps both the hooks bus AND the web adapter is that typing indicators are web-channel-specific (Telegram adapters handle them internally via the Bot API) — hooks don't emit them. If and when we add typing indicators as first-class hook events, this double-subscribe collapses.

### Lifecycle

Sources are constructed after `AgentManager.initialize()` (for the conversation-manager-backed source) and passed into the `Bridge` constructor. The shutdown sequence disposes them AFTER the bridge stops — by that point no new SSE clients can attach, and disposing at this moment releases the upstream subscriptions before `agentManager.stopAll()` tears down the conversation processes those listeners observe.

### End-to-end flow (web UI live ledger)

```
1. Next.js RSC page fetches /ledger/query → renders initial list
2. Client-side LedgerStream component mounts
     ↓
   useEventStream opens /api/bridge/ledger/tail/:agent?since=<newest>
     ↓ (Next.js route handler proxies to the daemon bridge, loopback-gated)
   Bridge.handleLedgerTail builds filter + replay closures
     ↓
   handleSseRequest: subscribe → writeFrame buffered
     ↓
   replay: queryLedger(since=...) → oldest-first backfill
     ↓
   flush buffered deltas in arrival order
     ↓
   live mode — every LedgerWriter append fans out to this client
3. useLedgerTail reducer merges deltas into the list as they arrive
4. On unmount / navigation: req.close → source.unsubscribe → cleanup
```

---

## 9. Channel Adapter Pattern

### Interface ([channels/core/channel.ts](apps/daemon/src/channels/core/channel.ts))

```typescript
interface ChannelAdapter {
  readonly id: string;
  readonly supportsInteractive: boolean;   // can this adapter render inline keyboards?
  addAccount(accountId: string, credentials: ChannelCredentials): void;
  start(): void;
  stop(): void;
  startAccount(accountId: string): void;
  removeAccount(accountId: string): void;
  onMessage(handler: (msg: ChannelMessage) => void): void;
  sendText(accountId: string, chatId: string, text: string): Promise<void>;
  startTypingIndicator(accountId: string, chatId: string): void;
  stopTypingIndicator(accountId: string, chatId: string): void;
  sendInteractive(accountId: string, chatId: string, text: string, buttons: InteractiveButton[]): Promise<void>;
  onInteractiveCallback(handler: (cb: InteractiveCallback) => void): void;
}

interface InteractiveButton {
  readonly label: string;
  readonly callbackData: string;   // opaque — adapter echoes it back on tap
}

interface InteractiveCallback {
  readonly channelType: string;
  readonly accountId: string;
  readonly chatId: string;
  readonly senderId: string;
  readonly callbackData: string;
  readonly messageId?: number;     // platform message id (for card editing)
  readonly callbackQueryId?: string; // Telegram-specific ack id
}
```

`sendInteractive` is the primitive that tool-use approval cards (Approve/Deny) are built on. Adapters that don't support buttons (`supportsInteractive: false`) throw from `sendInteractive`; callers fall through to the web UI silently.

### WebChannelAdapter implementation ([channels/web/adapter.ts](apps/daemon/src/channels/web/adapter.ts))

The web adapter is a first-class channel but has no external protocol — it's an in-process, loopback-only surface driven entirely by the HTTP bridge. There is no polling loop, no credentials, and no `start()` work: the adapter becomes "live" the moment bridge endpoints attach.

- **Always registered.** `AgentManager.initialize()` registers a single `WebChannelAdapter` on the `ChannelRegistry` unconditionally, regardless of what channels agents declare in `agent.json`.
- **Synthetic per-agent accounts.** Every agent gets an automatic `web:<agentName>` binding registered during `registerChannelBindings()`. `accountId === agentName`, so `Router.resolveAgentByChannel("web", accountId)` works unchanged. The account is not surfaced in `agentChannels` (so it never becomes the agent's primary channel) and is torn down symmetrically by `unregisterAgent()` to prevent leaks across `rondel_add_agent` → `rondel_remove_agent` cycles. Registration failure throws from startup — the web UI is user-facing, and a silent failure would produce a "message disappears into the void" experience that's hard to diagnose (CLAUDE.md: *fail loudly at boundaries*).
- **Inbound via `ingestUserMessage()`.** The bridge's `POST /web/messages/send` calls this method, which normalizes the HTTP body to a `ChannelMessage` and dispatches it through the same `onMessage` handlers the Router registered for Telegram. From there, `sendOrQueue` takes over — there is no web-specific routing path.
- **Outbound via fan-out + ring buffer.** `sendText()` and the typing-indicator methods publish `WebChannelFrame`s keyed by `(accountId, chatId)`. Each conversation has a 20-frame ring buffer plus a set of live subscribers. A tab opening mid-turn pulls `getRingBuffer()` before attaching its live subscription so it sees recent context rather than starting blank. `subscribeConversation(accountId, chatId, listener)` returns an unsubscribe closure used by `ConversationStreamSource`.
- **Not an outbound MCP surface.** The web channel has no MCP tool equivalent of `rondel_send_telegram` — agents don't proactively "push" to the web UI. Everything flows through their normal response stream, which the per-conversation SSE tail surfaces to the browser via the hook bus.

### TelegramAdapter implementation ([channels/telegram/adapter.ts](apps/daemon/src/channels/telegram/adapter.ts))

- One `TelegramAdapter` instance manages N `TelegramAccount` objects (one per bot)
- Each account polls independently via `getUpdates()` with 30s long-poll timeout. `allowed_updates: ["message", "callback_query"]` — both text messages and button taps.
- `allowedUsers` set is shared across all accounts (from `~/.rondel/config.json`). Callback queries from unauthorized users are rejected at the account level.
- `supportsInteractive: true` — `sendInteractive()` renders inline keyboards via Telegram's `reply_markup` API. Used by the approval flow for Approve/Deny buttons. `answerCallbackQuery()` acks button taps (stops the spinner). `editMessageText()` cosmetically updates cards after resolution.
- Outbound: Markdown formatting with automatic plain-text fallback on parse failure
- Message chunking at 4096 chars, breaking at newlines or spaces

### Multi-account model

Bot token = routing. Each agent gets its own Telegram bot. `accountId` is the agent name. `AgentManager` maintains bidirectional maps: `accountToAgent` and `agentToAccount` ([agent-manager.ts:44](apps/daemon/src/agents/agent-manager.ts#L44)). No chat ID configuration needed — message a bot, you're talking to that agent.

---

## 10. Config & Context

### Config loading ([config.ts:24](apps/daemon/src/config/config.ts#L24))

Two config sources:

**`~/.rondel/config.json`** (global):
```typescript
interface RondelConfig {
  readonly defaultModel: string;
  readonly allowedUsers: readonly string[];   // Telegram user IDs
}
```

No agent list — agents are discovered by scanning `workspaces/` for directories containing `agent.json`.

**`agent.json`** (per agent, anywhere under `workspaces/`):
```typescript
interface AgentConfig {
  readonly agentName: string;
  readonly enabled: boolean;
  readonly model: string;
  // No permissionMode — safety classification is per-tool, not per-agent.
  // Native shell/filesystem/AskUser tools are hard-disallowed via
  // FRAMEWORK_DISALLOWED_TOOLS and every rondel_* MCP tool runs its
  // own classifier inline.
  readonly workingDirectory: string | null;
  readonly channels: readonly ChannelBinding[];
  readonly tools: {
    readonly allowed: readonly string[];     // → --allowedTools
    readonly disallowed: readonly string[];  // → --disallowedTools
  };
  readonly mcp?: {
    readonly servers?: Readonly<Record<string, McpServerEntry>>;
  };
}

interface McpServerEntry {
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
}
```

### Environment variable substitution

All `${VAR_NAME}` patterns in JSON config files are replaced with `process.env` values before parsing. Missing variables throw ([config.ts:9](apps/daemon/src/config/config.ts#L9)).

### Context assembly ([context-assembler.ts](apps/daemon/src/config/context-assembler.ts))

Multi-file bootstrap system inspired by OpenClaw. Agent context is assembled from purpose-specific files, each prefixed with a `# filename` heading:

```
apps/daemon/templates/framework-context/*.md   Layer 0: Framework-owned. Tool surface,
                                               disallowed natives, protocol invariants.
                                               NOT user-editable. Ships with the daemon.
  ---
workspaces/global/CONTEXT.md                   Layer 1: Global (cross-agent conventions, user-owned)
  ---
{org}/shared/CONTEXT.md                        Layer 1.5: Org-specific conventions (user-owned, if org)
  ---
# AGENT.md                                     Layer 2: Operating style, delegation, personality
# SOUL.md                                      Layer 3: Persona, tone, boundaries
# IDENTITY.md                                  Layer 4: Name, creature, vibe, emoji, avatar
# USER.md                                      Layer 5: User profile, preferences, timezone
# MEMORY.md                                    Layer 6: Agent-maintained persistent knowledge
# BOOTSTRAP.md                                 Layer 7: First-run ritual (deleted after completion)
```

**Layer 0 (framework-owned, uneditable)** is the canonical home for content that must exist for agents to function correctly: the Rondel tool surface, the disallowed-natives list, protocol contracts with the LLM. It is prepended to every top-level agent's system prompt and to subagent/cron contexts. All `.md` files under `templates/framework-context/` are loaded alphabetically and joined. See [context-assembler.ts:loadFrameworkContext](apps/daemon/src/config/context-assembler.ts).

**Layers 1 through 7 are user-owned.** Users may edit or delete any of them. Framework-critical content must never live in these layers — see the "User Space vs Framework Space" section in CLAUDE.md.

All user-layer files are optional — missing files are silently skipped. If no bootstrap files exist, falls back to legacy `SYSTEM.md`.

**Ephemeral context filtering:** Subagent and cron contexts strip `MEMORY.md`, `USER.md`, and `BOOTSTRAP.md` to keep ephemeral processes lightweight and prevent leaking personal context. Layer 0 framework-context is retained — subagents and crons call the same MCP tool surface.

**Agent directory structure** (inside `workspaces/`):
```
{org}/agents/{name}/
├── agent.json       # Config
├── AGENT.md         # Operating instructions
├── SOUL.md          # Persona and boundaries
├── IDENTITY.md      # Identity card (name, creature, vibe, emoji, avatar)
├── USER.md          # User profile
├── MEMORY.md        # Persistent knowledge (optional, agent-managed via MCP tools)
└── BOOTSTRAP.md     # First-run ritual (deleted by agent after completion)
```

**Template files** live at `templates/context/` and use `{{agentName}}` placeholders. The scaffold CLI reads these at runtime — no prompt content is hardcoded in source.

### Agent memory

Persistent knowledge that survives session resets, Rondel restarts, and context compaction. Stored as a plain markdown file (`MEMORY.md`) in the agent's directory. Agents read/write memory via MCP tools (`rondel_memory_read`, `rondel_memory_save`) which call bridge endpoints (`GET /memory/:agentName`, `PUT /memory/:agentName`). Memory content is included in the system prompt on every spawn (main sessions only — not subagents or cron).

### Startup sequence ([index.ts:19](apps/daemon/src/index.ts#L19))

```
0. loadEnvFile()                  → parse ~/.rondel/.env into process.env (no overwrite)
0b. initLogFile() (daemon only)   → rotate if >10MB, open file for append, enable file transport
1. loadRondelConfig()             → read + validate ~/.rondel/config.json (env vars now available)
2. AgentManager.initialize()      → for each agent:
   a. loadAgentConfig()           → read + validate agent.json (including crons[])
   b. assembleContext()           → read + concatenate markdown layers
   c. Store as AgentTemplate      → (no process spawned)
   d. telegram.addAccount()       → register bot token
3. AgentManager.loadSessionIndex() → read sessions.json (conversation key → session ID)
4. ApprovalService.init()         → ensure state/approvals/{pending,resolved} dirs exist
5. ApprovalService.recoverPending() → auto-deny orphaned pending records from previous run
6. Wire interactive callbacks     → channelRegistry.onInteractiveCallback for tool-use Approve/Deny
7. Bridge.start(approvals)        → HTTP server on 127.0.0.1:<random-port>, receives ApprovalService
8. agentManager.setBridgeUrl()    → MCP processes will receive this via env var
9. Scheduler.start()              → load cron jobs, restore state, arm timer, run missed jobs
10. Router.start()                → subscribe to channel messages
11. telegram.start()              → begin long-polling on all accounts (message + callback_query)
   (processes spawn on first message to each chat — with --resume if session exists)
```

---

## 11. Session Persistence & Transcripts

Follows OpenClaw's two-layer session model, adapted for Claude CLI delegation.

### Two-layer persistence

**Layer 1: Session index** (`~/.rondel/state/sessions.json`)

Lightweight metadata index mapping conversation keys to Claude CLI session IDs. Written atomically after session changes and on shutdown.

```json
{
  "assistant:12345": {
    "sessionId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "agentName": "assistant",
    "chatId": "12345",
    "createdAt": 1711641600000,
    "updatedAt": 1711728000000
  }
}
```

**Layer 2: Transcripts** (`~/.rondel/state/transcripts/{agentName}/{sessionId}.jsonl`)

Append-only JSONL files capturing full conversation history — user messages, assistant responses (with tool calls and tool results), costs, errors. Raw stream-json events are written as-is for maximum fidelity.

```
transcripts/
├── assistant/
│   ├── a1b2c3d4-e5f6-7890-abcd-ef1234567890.jsonl   # conversation transcript
│   ├── sub_1711641600000_abc123.jsonl                 # subagent transcript
│   └── cron_daily-summary_1711641600000_def456.jsonl  # cron run transcript
└── dev-lead/
    └── ...
```

### Session lifecycle

**New conversation**: Generate UUID → spawn with `--session-id <uuid>` → create transcript with header → persist to index.

**Crash recovery**: Process dies → look up session ID from index → spawn with `--resume <uuid>` → conversation context restored from Claude CLI's persisted session. Transcript continues in same file.

**Rondel restart**: Load session index on startup → no processes spawned → first message to a known chat spawns with `--resume` → seamless continuation.

**Session reset** (`/new` command): Stop process → delete entry from session index → next message generates fresh UUID and spawns with `--session-id <new-uuid>`. Old transcript stays on disk (history preserved).

**Resume failure**: If `--resume` fails (process exits within 10s), delete the session index entry. Next spawn generates a fresh UUID and starts with `--session-id`.

### Transcript capture

Both `AgentProcess` and `SubagentProcess` capture events to transcripts:

| Event source | What's written |
|-------------|---------------|
| `sendMessage()` | User entry: `{"type":"user","text":"...","senderId":"...","senderName":"...","timestamp":"..."}` |
| `handleStdoutLine()` | Raw stream-json event as-is — `assistant` (full content with tool_use + tool_result), `result`, `system` |

Writes are fire-and-forget (async, errors logged but never thrown) — transcript failures never block or crash the agent.

### System commands

| Command | Behavior |
|---------|----------|
| `/new` | Reset session for this chat. Stops process, generates new session ID. Old transcript preserved on disk |

### Conversation Ledger (Layer 1)

Business-level event log that makes agent activity observable to humans, other agents, and future automation (Layer 3 monitors, Layer 4 workflows). Complements raw transcripts — the ledger is an index (summaries + metadata), not a transcript (full content).

**Storage**: One JSONL file per agent at `state/ledger/{agentName}.jsonl`.

**Event schema**: Every line is a `LedgerEvent`:
```json
{"ts":"2026-03-31T23:27:02.501Z","agent":"bot2","kind":"user_message","channelType":"telegram","chatId":"5948773741","summary":"Anything new in the chat?","detail":{"senderId":"5948773741","senderName":"David"}}
```

Fields: `ts` (ISO 8601), `agent` (agentName), `kind` (event type), `channelType` and `chatId` (optional, paired), `summary` (truncated, max 100 chars for messages / 80 for inter-agent), `detail` (kind-specific metadata).

**Invariant — `channelType` and `chatId` are a pair.** Both are present for conversation- and session-bound events; both are absent for system-wide events (cron). A `chatId` alone is ambiguous — the same id string can occur on different channels (Telegram, web), and every other layer of Rondel keys on the composite `(agentName, channelType, chatId)`. Writers always set them together; readers can rely on the invariant.

**Event kinds**: `user_message`, `agent_response`, `inter_agent_sent`, `inter_agent_received`, `subagent_spawned`, `subagent_result`, `cron_completed`, `cron_failed`, `session_start`, `session_resumed`, `session_reset`, `crash`, `halt`, `approval_request`, `approval_decision`, `tool_call`.

**How events get in**: The `LedgerWriter` subscribes to all `RondelHooks` events in [index.ts](apps/daemon/src/index.ts) and transforms each into a `LedgerEvent` with a truncated summary. Writes are fire-and-forget `appendFile` — same pattern as transcripts.

**How agents query it**: `rondel_ledger_query` MCP tool → `GET /ledger/query` bridge endpoint → `queryLedger()` reader. Supports filtering by `agent`, `since` (relative: "6h", "1d" or ISO 8601), `kinds`, and `limit` (default 50, max 500). Returns newest-first.

**Relationship to transcripts**: Transcripts capture raw stream-json events (every token, every tool call result). The ledger captures business-level events (who said what to whom, what happened). Both are append-only JSONL. Both coexist — the ledger tells you what to look at, the transcript shows the full picture.

**Retention**: Unbounded for now. File rotation will be added when real data volumes warrant it.

---

## 12. Daemon & OS Service

### Two-tier process management

Rondel has two run modes across macOS, Linux, and Windows:

**Development** (`pnpm start` — runs the daemon directly from the workspace)
- Runs the orchestrator in the current terminal. For development and debugging only.
- Ctrl+C to stop. No auto-restart, no auto-start on login.
- Not exposed in the user-facing CLI.

**Production — OS service** (`rondel service install`)
- Registers Rondel with the OS service manager (launchd, systemd, or Task Scheduler)
- Auto-start on login, auto-restart on crash (5s delay)
- `RONDEL_DAEMON=1` env var triggers file logging — the service manager is the supervisor
- This is the production mode. After `rondel init`, the user is offered to install the service. From that point, Rondel just works.

### RONDEL_DAEMON=1

Single env var that means "use file logging." Set by the service manifest (plist `EnvironmentVariables` / unit `Environment=` / PowerShell wrapper). The orchestrator doesn't care who started it. `RONDEL_DAEMON=1` → call `initLogFile()` → all logger output goes to `~/.rondel/state/rondel.log`.

### Service-aware stop

`rondel stop` checks if an OS service is installed. If yes, it uses the service manager to stop (`launchctl bootout` / `systemctl --user stop`) — otherwise `KeepAlive`/`Restart=always` would immediately restart the process. If no service, sends SIGTERM directly with SIGKILL escalation after 5s.

### Platform backends

**macOS (launchd)**:
- Plist: `~/Library/LaunchAgents/dev.rondel.orchestrator.plist`
- `RunAtLoad=true`, `KeepAlive=true`, `ThrottleInterval=5`
- `StandardOutPath` + `StandardErrorPath` → `~/.rondel/state/rondel.log`
- `EnvironmentVariables` includes `RONDEL_HOME`, `RONDEL_DAEMON=1`, and `PATH` with directories containing `node` and `claude`
- Install: `launchctl bootstrap gui/<uid>`
- Uninstall: `launchctl bootout gui/<uid>/dev.rondel.orchestrator`

**Linux (systemd)**:
- Unit: `~/.config/systemd/user/rondel.service`
- `Type=simple`, `Restart=always`, `RestartSec=5`
- `EnvironmentFile=-~/.rondel/.env` (dash prefix = optional, no error if missing)
- `Environment=RONDEL_HOME=... RONDEL_DAEMON=1 PATH=...`
- Install: `systemctl --user enable --now rondel.service`
- Uninstall: `systemctl --user disable --now rondel.service`
- Warns if `loginctl enable-linger` is needed for service to run without login session

**Windows Task Scheduler backend:**
- Task name: `Rondel`
- Trigger: `ONLOGON` (auto-start on login)
- Action: PowerShell wrapper script at `~/.rondel/state/rondel-runner.ps1`
- Crash recovery: wrapper restarts on non-zero exit (5s delay), clean exit (code 0) breaks loop
- Install: `schtasks /Create ... /SC ONLOGON` + `schtasks /Run`
- Uninstall: `schtasks /Delete /TN "Rondel" /F`
- Stop: `taskkill /PID <pid> /T /F` (tree kill to stop wrapper + node process)

### .env auto-loading

The orchestrator loads `~/.rondel/.env` at the top of `startOrchestrator()`, before any config resolution. This is critical because:
- Service context (launchd/systemd) has no shell profile — `${BOT_TOKEN}` references in agent.json would fail
- Environment variables already set take precedence (explicit env > .env file)
- The parser is minimal: `KEY=VALUE` lines, skip `#` comments and empty lines, no multiline/interpolation

### Log management

- Log file: `~/.rondel/state/rondel.log`
- Rotation: simple size-based — if >10MB on startup, renamed to `.log.1` (1 backup)
- Logger writes to file via `writeSync` (synchronous for signal-handler safety)
- Console output only when `process.stdout.isTTY` — daemon mode is file-only
- `rondel logs` tails the file; `rondel logs -f` uses `tail -f`

### State files

| File | Retention | Notes |
|------|-----------|-------|
| `rondel.lock` | Deleted on shutdown | PID, startedAt, bridgeUrl, logPath |
| `rondel.log` | Grows, rotated at 10MB on startup | 1 backup (.log.1) |
| `sessions.json` | Persisted across restarts | ConversationKey → SessionEntry for `--resume` |
| `cron-state.json` | Persisted across restarts | Backoff counters, last run times, missed job detection |
| `inboxes/{agent}.json` | Deleted after delivery | Per-agent pending inter-agent messages. Recovered on startup |
| `ledger/{agent}.jsonl` | Grows indefinitely, rotation TBD | Per-agent structured event log (Layer 1). Business-level events: user messages, responses, inter-agent, subagent, cron, session lifecycle, approval requests/decisions. Summaries only, not full content |
| `transcripts/{agent}/{session}.jsonl` | Grows indefinitely, prune TBD | Per-conversation raw stream-json events + user entries. Forensic-level — complements the ledger |
| `approvals/pending/{id}.json` | Deleted on resolution | One file per pending tool-use approval. Moved to resolved/ on decision |
| `approvals/resolved/{id}.json` | Grows indefinitely, prune TBD | Resolved approval records. Kept for audit trail and web UI history |
