# Rondel Architecture (as built)

> Current state of the codebase as of the runtime-scheduling + schedule-watchdog work and the `apps/web` revamp (April 2026). Only documents what exists in code — not planned features.

---

## 1. System Overview

Rondel is a single-installation system at `~/.rondel/` (overridable via `RONDEL_HOME`) that bridges messaging channels (Telegram today, a loopback web channel for the dashboard) to Claude CLI processes via the `stream-json` protocol. It runs as an OS-managed background service (launchd on macOS, systemd on Linux, Task Scheduler on Windows) that auto-starts on login and auto-restarts on crash. Organizations and agents are discovered automatically by scanning `workspaces/` for directories containing `org.json` and `agent.json` respectively. Organizations group agents and provide shared context; agents within an org get org-specific context injected between global and per-agent context. Each agent is a template (config + system prompt). No Claude processes run at startup — they spawn lazily when a user sends the first message to a bot. Each unique `(agentName, chatId)` conversation gets its own isolated Claude process with its own session. The MCP protocol injects tools (channel messaging, agent queries, org management, inter-agent messaging, durable scheduling, first-class shell/filesystem, structured ask-user prompts) into each agent process. An internal HTTP bridge lets MCP server processes query Rondel core state. Agent-facing shell and filesystem work flows through first-class `rondel_*` MCP tools — each tool owns its own safety classifier, human-approval escalation, and ledger emission. Native `Bash` / `Write` / `Edit` / `MultiEdit` / `AskUserQuestion` / `CronCreate` / `CronDelete` / `CronList` are hard-disallowed at spawn time. A CLI (`rondel init`, `add agent`, `add org`, `stop`, `logs`, `service`, etc.) handles setup and lifecycle management.

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

`apps/daemon/src/` is organized by domain. Each directory has a barrel `index.ts`; external consumers import from the directory (`../agents`), internal files import each other directly. Runtime deps: `@modelcontextprotocol/sdk`, `croner`, `zod`.

### Entry

| File | Responsibility |
|------|---------------|
| [index.ts](apps/daemon/src/index.ts) | `startOrchestrator(rondelHome?)`. Loads `.env`, opens daemon log, loads config, runs `discoverAll()`, creates hooks + LedgerWriter, initializes AgentManager, wires subagent / cron / inter-agent hook listeners, constructs ApprovalService + ApprovalStreamSource, recovers orphaned pending approvals, wires the interactive-callback handler (approval cards + `rondel_ask_user` option taps), constructs ReadFileStateStore + FileHistoryStore + ScheduleStore + Scheduler + ScheduleService + ScheduleStreamSource, starts Bridge, sets the bridge URL on the agent manager, replays pending inter-agent inboxes, starts Scheduler + ScheduleWatchdog + Router + channel polling. Handles SIGINT/SIGTERM shutdown (stops watchdog → channels → scheduler → bridge → streams → agents → releases lock). |

### CLI (`cli/`)

| File | Responsibility |
|------|---------------|
| [cli/index.ts](apps/daemon/src/cli/index.ts) | `bin` entry. Dispatches `init`, `add agent`, `add org`, `stop`, `restart`, `logs`, `status`, `doctor`, `service`. |
| [cli/init.ts](apps/daemon/src/cli/init.ts) | `rondel init` — creates `~/.rondel/`, config, `.env`, scaffolds first agent, optionally installs OS service. |
| [cli/add-agent.ts](apps/daemon/src/cli/add-agent.ts) | `rondel add agent` — scaffolds agent directory from templates. |
| [cli/add-org.ts](apps/daemon/src/cli/add-org.ts) | `rondel add org` — scaffolds org directory + `shared/CONTEXT.md` + `agents/`. |
| [cli/stop.ts](apps/daemon/src/cli/stop.ts) | Service-aware stop (launchctl / systemctl / taskkill when service installed, raw SIGTERM → SIGKILL otherwise). |
| [cli/restart.ts](apps/daemon/src/cli/restart.ts) | Restart via OS service (service must be installed). |
| [cli/logs.ts](apps/daemon/src/cli/logs.ts) | Tail `~/.rondel/state/rondel.log`. `-f` for follow, `-n` for line count. |
| [cli/status.ts](apps/daemon/src/cli/status.ts) | Service status + PID / uptime / log path + per-agent conversation states (bridge query). |
| [cli/doctor.ts](apps/daemon/src/cli/doctor.ts) | Diagnostic checks (init, config, CLI, orgs, agents, configs, tokens, state, service, skills). |
| [cli/service.ts](apps/daemon/src/cli/service.ts) | `install` / `uninstall` / `status` for the OS service. |
| [cli/scaffold.ts](apps/daemon/src/cli/scaffold.ts) | Agent + org directory scaffolding. Reads `templates/context/` with `{{agentName}}` / `{{orgName}}` substitution. Used by the CLI and by `bridge/admin-api.ts`. |
| [cli/telegram-discover.ts](apps/daemon/src/cli/telegram-discover.ts) | Helper used by `add agent` to verify a Telegram bot token and fetch its username. |
| [cli/prompt.ts](apps/daemon/src/cli/prompt.ts) | Readline-based ask / confirm helpers (no deps). |

### Agents (`agents/`)

| File | Responsibility |
|------|---------------|
| [agents/agent-manager.ts](apps/daemon/src/agents/agent-manager.ts) | Template + org registry, channel-binding facade. Precomputes the `main` and `agent-mail` system prompts per agent and caches them on `AgentTemplate`. Registers a `WebChannelAdapter` unconditionally and a synthetic `web:<agentName>` account per agent. Delegates lifecycle to `ConversationManager`, `SubagentManager`, `CronRunner`. Hot-add / unregister via `registerAgent` / `unregisterAgent`. |
| [agents/conversation-manager.ts](apps/daemon/src/agents/conversation-manager.ts) | Per-conversation process lifecycle + `sessions.json` index. Owns the branded `ConversationKey` → `AgentProcess` map. Spawns with `--session-id` (new) or `--resume` (existing). Handles `/new`, resume-failure detection, transcript creation. Emits the `session:*` hook family. Owns the `pendingRestarts: Set<ConversationKey>` seam used by `rondel_reload_skills` for post-turn restarts. |
| [agents/subagent-manager.ts](apps/daemon/src/agents/subagent-manager.ts) | Ephemeral subagent spawning / tracking / GC. Resolves template prompts via `loadTemplateSubagentPrompt`; emits `subagent:spawning` / `:completed` / `:failed`; prunes completed records after 1 h. |
| [agents/agent-process.ts](apps/daemon/src/agents/agent-process.ts) | Persistent Claude CLI child. `stream-json` in/out, MCP config temp-file lifecycle, state machine, crash recovery with daily backoff, exit-handshake stop/restart (no fixed timer). Exports `FRAMEWORK_DISALLOWED_TOOLS` (10 names — see §4) and `McpConfigMap`. Passes `--session-id` / `--resume`, `--dangerously-skip-permissions`, `--add-dir <agentDir>` and `--add-dir <frameworkSkillsDir>`, `--model`, `--system-prompt`. `cwd` is the configured `workingDirectory` or inherited. |
| [agents/subagent-process.ts](apps/daemon/src/agents/subagent-process.ts) | Ephemeral Claude CLI child for single-task execution. Reuses `McpConfigMap` + `FRAMEWORK_DISALLOWED_TOOLS`. Timeout + SIGKILL, structured result parsing. |

### Routing (`routing/`) and messaging (`messaging/`)

| File | Responsibility |
|------|---------------|
| [routing/router.ts](apps/daemon/src/routing/router.ts) | Inbound channel → agent resolution, per-conversation queueing via branded `ConversationKey`, system commands (`/new` etc.), response dispatch via the channel registry. Emits `conversation:message_in` / `conversation:response`. Inter-agent delivery: `deliverAgentMail()` spawns agent-mail conversations, `wireAgentMailProcess()` buffers responses and routes replies back to senders. Consumes `pendingRestarts` on the `idle` branch (pre-drain) so post-turn skill-reload restarts don't drop queued messages. |
| [messaging/inbox.ts](apps/daemon/src/messaging/inbox.ts) | File-based inbox (`state/inboxes/{agent}.json`). `appendToInbox` before delivery, `removeFromInbox` after. `readAllInboxes` recovers pending messages on startup. |

### Bridge + MCP (`bridge/`)

| File | Responsibility |
|------|---------------|
| [bridge/bridge.ts](apps/daemon/src/bridge/bridge.ts) | Internal HTTP server (`127.0.0.1` + random port). Route table for read-only endpoints, SSE tails (delegated to `handleSseRequest`), web-chat ingest, HITL approvals, ask-user prompts (in-memory, no persistence), runtime schedules, inter-agent messaging, and admin (delegated to `AdminApi`). Owns the WebChannelAdapter lookup (`channelRegistry.get("web") instanceof WebChannelAdapter`) and pre-validates the synthetic web account before injecting. Unknown `channelType` in history/tail URLs → 400. |
| [bridge/admin-api.ts](apps/daemon/src/bridge/admin-api.ts) | HTTP-framework-agnostic admin mutations. `{status, data}` return shape. Covers add / update / delete agent, create org, reload, set env, system status. Calls `ScheduleService.purgeForAgent` before deleting an agent directory. |
| [bridge/schemas.ts](apps/daemon/src/bridge/schemas.ts) | Zod schemas for every validated endpoint (admin, messaging, web chat, approvals, tool-call ledger, filesystem tools, ask-user, schedules — `CronSchedule` is a cross-field-refined discriminated union, `cron` expressions validated by parsing through `croner`). Pins `BRIDGE_API_VERSION` (currently `14`). |
| [bridge/mcp-server.ts](apps/daemon/src/bridge/mcp-server.ts) | Standalone MCP server spawned by Claude CLI per conversation. Imports `registerTelegramTools` and the first-class tool registrars from `tools/`. Registers Rondel bridge query tools, messaging, memory, org read tools, ledger query, skill reload, runtime schedule tools, system status, and `RONDEL_AGENT_ADMIN`-gated admin tools (add/update/delete agent, create org, reload, set env). Calls Telegram API directly; everything else goes over `RONDEL_BRIDGE_URL`. |

### Scheduling (`scheduling/`)

| File | Responsibility |
|------|---------------|
| [scheduling/scheduler.ts](apps/daemon/src/scheduling/scheduler.ts) | Timer-driven runner. Merges declarative `crons` (from `agent.json`, hot-reloaded via `fs.watch`) and runtime entries (from `ScheduleStore`) into one in-memory map keyed `${owner}:${jobId}`. Dispatches per schedule kind (`every` / `at` / `cron` via `croner`). Implements `SchedulerControl` (upsert / remove / triggerNow / getJobStateSnapshot). Auto-deletes successful one-shot runtime jobs. Channel-aware delivery (`delivery.channelType` + `delivery.accountId`, falling back to the agent's primary channel). Backoff, state persistence, missed-job recovery on `start()`. |
| [scheduling/schedule-store.ts](apps/daemon/src/scheduling/schedule-store.ts) | File-backed store for runtime schedules (`state/schedules.json`, `{version:1, jobs:[...]}`). Atomic writes, corrupt-file recovery, immutable identity fields (id, source, owner, createdAtMs). |
| [scheduling/schedule-service.ts](apps/daemon/src/scheduling/schedule-service.ts) | Business logic between bridge / MCP tools and `ScheduleStore` + `Scheduler`. Owns ID generation, permission gating (self-only; admin can target same-org or global agents; cross-org blocked even for admin), delivery defaulting to the caller's active conversation, schedule validation via `parseSchedule`, `schedule:created` / `:updated` / `:deleted` hook emission, `purgeForAgent(name)`. Throws `ScheduleError` with structured codes (`validation` / `not_found` / `forbidden` / `cross_org` / `unknown_agent`). Exports the shared `summarizeSchedule()` projection used by reads and stream frames. |
| [scheduling/parse-schedule.ts](apps/daemon/src/scheduling/parse-schedule.ts) | Unified parser across the three schedule kinds. Returns `{normalized, isOneShot, initialFireAtMs(now), computeNextRunAtMs(fromMs)}`. |
| [scheduling/cron-runner.ts](apps/daemon/src/scheduling/cron-runner.ts) | Per-run execution engine: `runIsolated()` → fresh `SubagentProcess` with `cron`-mode prompt; `getOrSpawnNamedSession()` → persistent `AgentProcess` keyed `{agent}:cron:{name}`. Owns transcript creation for cron runs. |
| [scheduling/watchdog.ts](apps/daemon/src/scheduling/watchdog.ts) | `ScheduleWatchdog`. Periodic (default 2 min) classification of `Scheduler.getJobSummaries()` into `stuck_in_backoff` / `never_fired` / `timer_drift` / healthy. Transition-only `schedule:overdue` / `schedule:recovered` hook emission. `selfHeal: true` calls `Scheduler.rearm()` on `timer_drift`. |

### Channels (`channels/`)

| File | Responsibility |
|------|---------------|
| [channels/core/channel.ts](apps/daemon/src/channels/core/channel.ts) | `ChannelAdapter` interface + `ChannelMessage` + `ChannelCredentials` + `InteractiveButton` + `InteractiveCallback` types. `supportsInteractive` flag + `sendInteractive()` + `onInteractiveCallback()` for button flows. |
| [channels/core/registry.ts](apps/daemon/src/channels/core/registry.ts) | `ChannelRegistry` — central adapter lookup + dispatch. Replays handlers across adapters; per-adapter errors don't halt startup/shutdown. |
| [channels/telegram/adapter.ts](apps/daemon/src/channels/telegram/adapter.ts) | Multi-account long-poller (`allowed_updates: ["message", "callback_query"]`). Markdown with plain-text fallback, 4096-char chunking, 4s typing-indicator refresh loop. `supportsInteractive: true` — inline keyboards, `answerCallbackQuery`, `editMessageText`. `startAccount()` for hot-add. |
| [channels/telegram/mcp-tools.ts](apps/daemon/src/channels/telegram/mcp-tools.ts) | `registerTelegramTools(server)` — registers `rondel_send_telegram` + `rondel_send_telegram_photo` on a passed-in MCP server. No-op if the bot-token env var isn't set. |
| [channels/web/adapter.ts](apps/daemon/src/channels/web/adapter.ts) | `WebChannelAdapter` — loopback-only, in-process, no credentials. `supportsInteractive: false`. `ingestUserMessage()` normalizes bridge POST bodies to `ChannelMessage`. Outbound via per-conversation fan-out + 20-frame ring buffer (so tabs joining mid-turn replay recent context). |

### Config + prompt assembly (`config/`)

| File | Responsibility |
|------|---------------|
| [config/env-loader.ts](apps/daemon/src/config/env-loader.ts) | Minimal `.env` parser. `KEY=VALUE` lines, no interpolation, doesn't overwrite existing env. Critical because service context (launchd / systemd) has no shell profile. |
| [config/config.ts](apps/daemon/src/config/config.ts) | `resolveRondelHome()`, `rondelPaths()`, `loadRondelConfig()`, recursive `discoverAll()` for orgs + agents under `workspaces/`, `discoverSingleAgent` / `discoverSingleOrg` for hot-add, `${ENV_VAR}` substitution, nested-org detection, disabled-subtree skipping. |
| [config/prompt/](apps/daemon/src/config/prompt/) | Prompt-assembly module. Public API: `buildPrompt(inputs)` (pure, no I/O) + `loadPromptInputs(args)` (async). Four `PromptMode`s (`main` / `agent-mail` / `subagent` / `cron`). 11 pure section builders under `sections/` + disk loaders (`bootstrap.ts`, `shared-context.ts`, `agent-mail.ts`, `cron-preamble.ts`) + a separate `template-subagent.ts` pipeline for named-template subagents. Blocks joined with `\n\n` — no `---` separators, no synthetic `# FILENAME` prefix. |

### Ledger, approvals, filesystem

| File | Responsibility |
|------|---------------|
| [ledger/ledger-writer.ts](apps/daemon/src/ledger/ledger-writer.ts) | Subscribes to every `RondelHooks` event, transforms to a `LedgerEvent`, appends JSONL to `state/ledger/{agent}.jsonl`. Fire-and-forget writes. Exposes `onAppended(cb)` for `LedgerStreamSource`. |
| [ledger/ledger-reader.ts](apps/daemon/src/ledger/ledger-reader.ts) | `queryLedger()` — reads per-agent files, filters by agent / time / kinds / limit, returns newest-first. Relative times (`"6h"`, `"1d"`) and ISO 8601. |
| [ledger/ledger-types.ts](apps/daemon/src/ledger/ledger-types.ts) | `LedgerEvent`, `LedgerEventKind` definitions + `LedgerQuerySchema` (Zod). |
| [approvals/approval-service.ts](apps/daemon/src/approvals/approval-service.ts) | Central HITL owner. `requestToolUse()` persists + dispatches an interactive card + arms an in-memory resolver with timeout (30 min, tunable via `RONDEL_APPROVAL_TIMEOUT_MS`). `resolve()` moves `pending/<id>.json` → `resolved/<id>.json`. `recoverPending()` auto-denies orphans on startup. |
| [approvals/approval-store.ts](apps/daemon/src/approvals/approval-store.ts) | File store for approval records. Pending + resolved sibling directories under `state/approvals/`. |
| [approvals/tool-summary.ts](apps/daemon/src/approvals/tool-summary.ts) | Pure helper — one-line human summary of a tool call. Tool-specific formatting. |
| [approvals/types.ts](apps/daemon/src/approvals/types.ts) | Thin re-export — canonical approval types live in `shared/types/approvals.ts`. |
| [filesystem/read-state-store.ts](apps/daemon/src/filesystem/read-state-store.ts) | `ReadFileStateStore` — in-memory `(agent, sessionId, path) → {contentHash, readAt}`. Populated by `rondel_read_file` (non-truncated reads only). Subscribes to `session:crash` / `session:halt` to purge failed-session records. |
| [filesystem/file-history-store.ts](apps/daemon/src/filesystem/file-history-store.ts) | `FileHistoryStore` — disk-backed pre-image backups at `state/file-history/{agent}/{pathHash}-{ts}.pre` + `.meta.json` sidecar. 7-day retention, pruned on startup + every 24 h (unref'd timer). |

### First-class MCP tools (`tools/`)

| File | Responsibility |
|------|---------------|
| [tools/_common.ts](apps/daemon/src/tools/_common.ts) | Shared helpers: bridge-context env resolution, `contentHash` (sha256 hex), `validateAbsolutePath`, bridge HTTP wrappers, `emitToolCall` (fire-and-forget), `requestApprovalAndWait` (POST + poll), MCP result helpers. |
| [tools/bash.ts](apps/daemon/src/tools/bash.ts) | `rondel_bash`. `classifyBash` → allow / escalate; `spawn("bash", ["-c", ...])` with AbortController timeout + SIGKILL; stdout/stderr truncated at 100 000 chars; `tool_call` emit on every completion. |
| [tools/read-file.ts](apps/daemon/src/tools/read-file.ts) | `rondel_read_file`. Non-truncated reads register the staleness anchor (`POST /filesystem/read-state/:agent`); truncated reads do NOT register. |
| [tools/write-file.ts](apps/daemon/src/tools/write-file.ts) | `rondel_write_file`. Create proceeds unconditionally; overwrite requires a matching recorded read or escalates `write_without_read`. Secret scanner + safe-zone check. Backup → `atomicWriteFile` → re-record hash. |
| [tools/edit-file.ts](apps/daemon/src/tools/edit-file.ts) | `rondel_edit_file` — single-pattern replace. Hard requirement: prior read in this session (tool_error, no escalation). Drift escalates. Exact-1 / ≥1 occurrence validation. |
| [tools/multi-edit-file.ts](apps/daemon/src/tools/multi-edit-file.ts) | `rondel_multi_edit_file` — N edits applied in order to an in-memory buffer. All-or-nothing with `{editIndex}` on failure. One backup + one `tool_call` emit per operation. |
| [tools/ask-user.ts](apps/daemon/src/tools/ask-user.ts) | `rondel_ask_user` — multiple-choice prompt routed to the originating channel. POSTs to `/prompts/ask-user`, polls `/prompts/ask-user/:id`. Replaces the TTY-only `AskUserQuestion`. |

### Streams (SSE) (`streams/`)

| File | Responsibility |
|------|---------------|
| [streams/sse-types.ts](apps/daemon/src/streams/sse-types.ts) | `SseFrame<T>` + `StreamSource<T>` interface. |
| [streams/sse-handler.ts](apps/daemon/src/streams/sse-handler.ts) | Generic HTTP handler — the only place that knows the SSE wire format. Subscribe → buffer → snapshot/replay → flush → live mode. 25 s heartbeats. `req.close` + `res.error` cleanup. |
| [streams/ledger-stream.ts](apps/daemon/src/streams/ledger-stream.ts) | `LedgerStreamSource` — one upstream subscription to `LedgerWriter.onAppended`, fans out to N clients. Per-agent filtering applied at the handler boundary. |
| [streams/agent-state-stream.ts](apps/daemon/src/streams/agent-state-stream.ts) | `AgentStateStreamSource` — `snapshot()` of every active conversation + delta frames on each state transition. |
| [streams/conversation-stream.ts](apps/daemon/src/streams/conversation-stream.ts) | `ConversationStreamSource` — per-request, per-conversation. Taps `conversation:*` + `session:*` hooks filtered by `(agent, chatId)`. For `channelType === "web"`, also subscribes to the `WebChannelAdapter` fan-out for typing indicators and replays the ring buffer on connect. |
| [streams/approval-stream.ts](apps/daemon/src/streams/approval-stream.ts) | `ApprovalStreamSource` — fans `approval:requested` / `approval:resolved` out to the web `/approvals/tail`. |
| [streams/schedule-stream.ts](apps/daemon/src/streams/schedule-stream.ts) | `ScheduleStreamSource` — fans `schedule:{created,updated,deleted,ran}` out to the web `/schedules/tail`. Runtime jobs only. |

### Shared (`shared/`)

| File | Responsibility |
|------|---------------|
| [shared/hooks.ts](apps/daemon/src/shared/hooks.ts) | Typed `RondelHooks` EventEmitter. Conversation, session lifecycle, subagent, cron, inter-agent, approval, schedule, and tool-call events. See §5. |
| [shared/types/](apps/daemon/src/shared/types/) | Pure type definitions split by domain (`config`, `agents`, `subagents`, `scheduling`, `sessions` with branded `ConversationKey`, `routing`, `transcripts`, `messaging`, `approvals`). Barrel `index.ts` re-exports. Zero runtime imports — safe to import anywhere. |
| [shared/safety/](apps/daemon/src/shared/safety/) | Shared classifier + zone primitives used by every `rondel_*` tool that needs them. `classify-bash.ts` (`classifyBash`), `safe-zones.ts` (`isPathInSafeZone`), `secret-scanner.ts` (`scanForSecrets`), `types.ts` (`ApprovalReason`, classification result shapes). Pure TS, no runtime deps. |
| [shared/atomic-file.ts](apps/daemon/src/shared/atomic-file.ts) | Write-to-temp + rename atomic write. Used for every state file. |
| [shared/transcript.ts](apps/daemon/src/shared/transcript.ts) | Append-only JSONL transcript writer + `loadTranscriptTurns()` reader (used by `/conversations/.../history`). Returns `[]` only on ENOENT. |
| [shared/channels.ts](apps/daemon/src/shared/channels.ts) | Small helpers for channel-binding resolution shared across agent-manager and bridge. |
| [shared/org-isolation.ts](apps/daemon/src/shared/org-isolation.ts) | Org-isolation predicate used by `ScheduleService` and the inter-agent messaging path. |
| [shared/paths.ts](apps/daemon/src/shared/paths.ts) | `resolveFrameworkSkillsDir()` — path to the shipped `templates/framework-skills/.claude/skills/` dir relative to the installed daemon package. |
| [shared/logger.ts](apps/daemon/src/shared/logger.ts) | Dual-transport logger. TTY console (ANSI) + file via `initLogFile()` (daemon mode). 10 MB rotate to `.log.1` on startup. Hierarchical `.child()` prefixes. |

### System (`system/`)

| File | Responsibility |
|------|---------------|
| [system/instance-lock.ts](apps/daemon/src/system/instance-lock.ts) | PID lockfile at `state/rondel.lock` — stale detection, bridge URL + log path recording. |
| [system/service.ts](apps/daemon/src/system/service.ts) | Platform-aware OS service management. Backends: launchd (macOS), systemd (Linux), Task Scheduler (Windows, via a PowerShell wrapper). Generates manifests with PATH, env, and log redirection. |

### Dependency flow

- `shared/` depends on nothing inside the daemon.
- Domain dirs (`agents/`, `routing/`, `scheduling/`, `channels/`, `ledger/`, `approvals/`, `filesystem/`, `tools/`, `streams/`, `messaging/`, `system/`) depend on `shared/`, on each other via type imports, and on `config/`.
- `bridge/bridge.ts` is the top of the call graph — it depends on almost every domain.
- `bridge/mcp-server.ts` is a **separate process** spawned by Claude CLI. It is not imported by the orchestrator. It talks back to `bridge/bridge.ts` over HTTP via `RONDEL_BRIDGE_URL`.
- `cli/` is its own entry graph — it reaches into `config/`, `system/`, and `cli/scaffold.ts`, but never into the runtime domain modules.

---

## 3. Message Flow

### Inbound: channel message → agent response → reply

1. `TelegramAccount.pollLoop()` (or `WebChannelAdapter.ingestUserMessage()`) receives an update, filters by `allowedUsers`, and normalizes to `ChannelMessage`.
2. The adapter dispatches to handlers registered via `onMessage` — the Router is one of them.
3. `Router.handleInboundMessage()` resolves `accountId → agentName` via `agentManager.resolveAgentByChannel()`.
4. System commands (`/status`, `/restart`, `/stop`, `/new`, `/help`, `/start`) are intercepted by the Router and never forwarded to the agent.
5. `agentManager.getOrSpawnConversation(agentName, chatId)` returns an existing process or lazily spawns a new one (with `--session-id` for new conversations, `--resume` when a session exists).
6. If the process is `idle`, `sendOrQueue` writes JSON to stdin; otherwise the message is pushed onto a per-conversation queue.
7. Claude responds over stdout. `handleStdoutLine` parses newline-delimited JSON. `assistant` events emit text blocks immediately (block streaming); `result` events flush and mark the turn complete.
8. Each emitted text block fires `conversation:response`. The Router's wired handler sends it back via the channel registry.
9. On the `busy → idle` transition, the Router first checks `pendingRestarts` (consumed pre-drain for post-turn skill reload), then drains the queue.

### Outbound: agent-initiated message via MCP tool

1. The agent calls `rondel_send_telegram` (or another outbound channel tool) during its turn.
2. Claude CLI dispatches the tool call over stdio to the MCP server process (started once via `--mcp-config` at spawn time and kept alive for the life of the Claude CLI process).
3. The registered Telegram tool in `channels/telegram/mcp-tools.ts` calls the Telegram Bot API directly using `RONDEL_CHANNEL_TELEGRAM_TOKEN` from env.
4. The message appears in Telegram without any Rondel core involvement; the tool result returns to Claude which continues the turn.

---

## 4. Process Model

### Per-conversation, not per-agent

Agent config is a **template** — identity, model, tools, channel bindings. No processes exist at startup. Each unique `(agentName, chatId)` pair gets its own Claude CLI process. Three users messaging the same bot = three independent Claude instances with isolated sessions.

Conversation key: `"${agentName}:${chatId}"` — a branded string type defined in `shared/types/sessions.ts`. Always constructed via `conversationKey(agent, chatId)`, never by interpolation, so misuse is caught at compile time.

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
| `CronCreate`    | `rondel_schedule_create`  | Claude Code's cron is session-only (dies on CLI exit) and capped at 7 days. Rondel's scheduler owns durable schedules that survive restarts, have no TTL, and route delivery structurally. |
| `CronDelete`    | `rondel_schedule_delete`  | Counterpart to `CronCreate` — routed through `ScheduleService` for permission + org-isolation checks. |
| `CronList`      | `rondel_schedule_list`    | Counterpart to `CronCreate` — exposes the merged view of declarative (`agent.json`) + runtime (`state/schedules.json`) schedules, which the native tool cannot see. |

`ScheduleWakeup` is NOT disallowed — it's a short in-turn wait (≤1h) with a different purpose from persistent scheduling.

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

On process exit:
- Daily crash counter resets at midnight.
- If < 5 crashes today: wait with escalating backoff (5s → 15s → 30s → 60s → 2m), auto-restart with `--resume`.
- If ≥ 5: set state to `"halted"`, notify the user via the originating channel, stop restarting. Recovery requires an explicit `/restart`.
- Resume failure: if the process exits within 10s of `--resume`, the stale session entry is removed and the next message spawns a fresh session.

### Restart handshake

`AgentProcess.stop()` and `AgentProcess.restart()` use an **exit handshake** instead of a timer. `start()` sets up an `exitWaiter` promise resolved by `handleExit`; `stop()` returns it; `restart()` awaits it before respawning. This guarantees the previous Claude CLI child has fully exited (and released its session lock on disk) before the new one spawns — eliminating the `"Session ID is already in use"` race that the old hardcoded 1s `setTimeout` produced under slow shutdowns. SIGTERM is escalated to SIGKILL after `STOP_TIMEOUT_MS` (5s) as a side-effect; the timer cancels automatically when the exit waiter resolves, so a clean shutdown leaves no pending kill. The synchronous side-effects of `stop()` (state → `"stopped"`, MCP config cleanup, nulling the process reference) still run on the calling tick, so the Router's `consumePendingRestart → drainQueue` invariant is preserved.

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
| `conversation:response_delta` | AgentProcess | Per-chunk streaming hint while a text block is in flight (only emitted when the CLI is run with `--include-partial-messages`). `blockId` ties deltas to the final `conversation:response` | *(none in core — web SSE picks these up for UX only; consumers must treat `conversation:response` as source of truth)* |
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
| `schedule:created` | ScheduleService | Runtime schedule created via `rondel_schedule_create` | LedgerWriter → `schedule_created` |
| `schedule:updated` | ScheduleService | Runtime schedule patched via `rondel_schedule_update` | LedgerWriter → `schedule_updated` |
| `schedule:deleted` | ScheduleService / Scheduler | Schedule removed — `requested`, `ran_once` (one-shot auto-delete), or `owner_deleted` (payload carries `reason`) | LedgerWriter → `schedule_deleted` |
| `schedule:ran` | ScheduleService / Scheduler | Runtime schedule finished a run. Carries post-run `CronJobState` (`lastRunAtMs` / `lastStatus` / `nextRunAtMs`) so the web stream can update without a refetch. Distinct from `cron:completed` / `cron:failed`, which fire for ALL jobs (declarative + runtime) and carry `CronRunResult` | ScheduleStreamSource → SSE `schedule.ran` |
| `schedule:overdue` | ScheduleWatchdog | Job flagged as overdue (new state or reason transition — `timer_drift` / `stuck_in_backoff` / `never_fired`) | LedgerWriter → `schedule_overdue` |
| `schedule:recovered` | ScheduleWatchdog | Previously-overdue job observed healthy again (or disabled) | LedgerWriter → `schedule_recovered` |
| `tool:call` | Bridge (`POST /ledger/tool-call`) | First-class Rondel tool (`rondel_bash`, `rondel_read_file`, `rondel_write_file`, `rondel_edit_file`, `rondel_multi_edit_file`) completed — success or error | LedgerWriter → `tool_call` |
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

Timer-driven job runner ([scheduler.ts](apps/daemon/src/scheduling/scheduler.ts)). Reads jobs from two sources — declarative `crons` in each agent's `agent.json` and runtime entries in `state/schedules.json` — merges them into a single in-memory map, dispatches by schedule kind, executes them, and delivers results. Follows OpenClaw's three-way separation: where it runs (session target) / what it does (payload) / where output goes (delivery).

### Two job sources

| Source | Where it lives | Who creates it | Survives restart |
|--------|---------------|----------------|------------------|
| Declarative | `agent.json` `crons` array (user-owned, git-committable) | User at config-authoring time; hot-reloaded on `fs.watch` | Yes |
| Runtime | `state/schedules.json` (framework-owned) | Agents at runtime via `rondel_schedule_create` | Yes |

Both go through the same execution, backoff, and delivery logic. The only structural difference is metadata on `CronJob`: runtime jobs carry `source: "runtime"`, `owner: <agentName>`, and `createdAtMs`. Runtime jobs live under `state/` because `agent.json` is user-space — framework code must not mutate it at runtime (see CLAUDE.md "User Space vs Framework Space").

### Schedule kinds

`CronSchedule` is a discriminated union with three kinds (see [parse-schedule.ts](apps/daemon/src/scheduling/parse-schedule.ts)):

| Kind | Shape | Notes |
|------|-------|-------|
| `every` | `{ kind: "every", interval: "24h" }` | Recurring at fixed interval (`30s`, `5m`, `1h`, `2h30m`, `7d`). Reuses `parseInterval`. |
| `at` | `{ kind: "at", at: "2026-04-19T08:00:00Z" }` | One-shot. Accepts ISO 8601 or relative (`"20m"`, `"1h30m"`). Relative forms resolve to absolute ISO at creation time and are stored as ISO. Default `deleteAfterRun: true`. If the target is already past on restart, fires immediately (missed-job catchup). |
| `cron` | `{ kind: "cron", expression: "0 8 * * *", timezone?: "America/Sao_Paulo" }` | Standard 5-field cron. Parsed and fired via the `croner` library. Optional IANA timezone; defaults to daemon local. |

### Config (declarative example)

```json
{
  "crons": [
    {
      "id": "daily-summary",
      "name": "Daily Summary",
      "schedule": { "kind": "cron", "expression": "0 8 * * *" },
      "prompt": "Generate a daily summary.",
      "delivery": { "mode": "announce", "chatId": "123456", "channelType": "telegram", "accountId": "assistant" }
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
| `none` (default) | Result logged only. Agent can send via MCP tools during its turn if it decides to |
| `announce` | Result text sent to a specific chat via the channel adapter. `chatId` is required; `channelType` + `accountId` are optional and fall back to the agent's primary channel binding when absent |

**Channel-aware delivery (runtime schedules)**: When `rondel_schedule_create` is called without an explicit `delivery`, `ScheduleService` fills it in from the caller's active conversation (`channelType`, `accountId`, `chatId`). "Remind me at 8am" routes back to the chat where the user asked — no prompt-stuffing required.

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

Two files, both atomically written:

- **`state/cron-state.json`** — execution state for every job (declarative + runtime), keyed `${agentName}:${jobId}`. Fields: `lastRunAtMs`, `nextRunAtMs`, `consecutiveErrors`, `lastStatus`, `lastError`, `lastDurationMs`, `lastCostUsd`. Written after each run and on shutdown. Enables missed-job detection on restart.
- **`state/schedules.json`** — the runtime schedule store itself (`{version:1, jobs:[...]}`). Owned by `ScheduleStore`. Loaded on startup before the scheduler arms its timer so declarative + runtime jobs merge in a single pass.

### Config hot-reload

The scheduler watches each agent's `agent.json` for changes using `fs.watch`. When a config file changes:

1. Debounce (300ms) to coalesce rapid edits
2. Reload `agent.json` from disk, parse `crons` array
3. Diff against current jobs — add new ones, remove deleted ones, update changed ones in place
4. Preserve state (consecutiveErrors, lastRunAtMs) for unchanged jobs
5. Re-arm timer

No Rondel restart needed. Add a cron → it starts running within 300ms. Remove a cron → it stops immediately. Follows OpenClaw's hybrid reload pattern.

### Runtime schedule lifecycle

Runtime schedules come in via MCP tools and flow through `ScheduleService` → `ScheduleStore` + `Scheduler`:

```
Agent calls rondel_schedule_create
  → MCP server POST /schedules
  → Bridge validates body (ScheduleCreateRequestSchema, croner refinement)
  → ScheduleService.create():
      • resolveTargetAgent (self by default; admin may pass targetAgent)
      • checkOrgIsolation (cross-org blocked even for admin)
      • parseSchedule (throws on malformed expressions / past `at` times are allowed and fire on first tick)
      • resolveDelivery (fill from caller's chat if omitted)
      • generate id (sched_<epoch>_<hex>)
      • ScheduleStore.add(job)              ← persists atomically to state/schedules.json
      • Scheduler.upsertRuntimeJob(job)     ← inserts into in-memory map + arms timer
      • hooks.emit("schedule:created")      ← LedgerWriter writes schedule_created
  → 201 { scheduleId, nextRunAtMs, … }
```

`update` / `delete` / `run` follow the same pattern through `SchedulerControl`. One-shot `at` jobs with `deleteAfterRun: true` self-delete after a successful run: the scheduler calls `ScheduleStore.remove(id)` and emits `schedule:deleted` with reason `ran_once`. When an agent is deleted, `AdminApi.deleteAgent()` calls `ScheduleService.purgeForAgent(name)` before removing the directory — runtime jobs without an owner would pile up forever otherwise.

Permission rules (enforced by `ScheduleService`, surfaced as HTTP 403/404):

| Caller | Action | Allowed |
|--------|--------|---------|
| Non-admin | CRUD own schedules | Yes |
| Non-admin | CRUD another agent's schedules | No (403 `forbidden`) |
| Admin | CRUD schedules on any same-org or global agent | Yes |
| Admin | CRUD schedules across orgs | No (403 `cross_org`) — admin does not bypass org isolation |

### Silent-failure watchdog

Scheduler is robust against restart (persisted state, missed-job catchup on `start()`) but can't self-detect failures while running: OS sleep pausing `setTimeout`, jobs stuck in exponential backoff (firing every 60 min with the user hearing silence), or never-fired startup bugs where `nextRunAtMs` stays `undefined` after insert. [`ScheduleWatchdog`](apps/daemon/src/scheduling/watchdog.ts) periodically scans `Scheduler.getJobSummaries()` (every 2 min by default, 5 min grace, backoff threshold 3), classifies each job — priority `stuck_in_backoff` > `never_fired` > `timer_drift` — and emits transition-only `schedule:overdue` / `schedule:recovered` hook events. Steady states don't re-emit, so a chronically broken job doesn't spam the ledger. Observation-only by default; `selfHeal: true` calls `Scheduler.rearm()` on `timer_drift` (idempotent).

```
Watchdog.scanOnce() every 2 min
  → classify(job) → "stuck_in_backoff" | "never_fired" | "timer_drift" | null
  → if new-or-changed reason: hooks.emit("schedule:overdue") ← LedgerWriter writes schedule_overdue
  → if previously overdue and now healthy: hooks.emit("schedule:recovered") ← LedgerWriter writes schedule_recovered
```

---

## 7. MCP Tool Injection

### Architecture

The MCP server runs as a **separate process** spawned by Claude CLI, not by Rondel. Communication between Claude and the MCP server uses stdio (MCP protocol). The MCP server calls Telegram API directly — no HTTP bridge back to Rondel core.

### Config construction

`AgentManager.getOrSpawnConversation()` builds the MCP config map. The always-present `rondel` server has `command: "node"` and `args: [mcpServerPath]`, with env vars including `RONDEL_BRIDGE_URL`, `RONDEL_PARENT_AGENT`, `RONDEL_PARENT_CHANNEL_TYPE`, `RONDEL_PARENT_ACCOUNT_ID`, `RONDEL_PARENT_CHAT_ID`, `RONDEL_AGENT_ADMIN` (when `admin: true`), and every `credentialEnvVar` / `extraEnvVars` value declared by the agent's channel bindings (so `registerTelegramTools` can pick up `RONDEL_CHANNEL_TELEGRAM_TOKEN` or equivalent). User-defined MCP servers from `agent.json` are merged on top.

### Temp file lifecycle

`AgentProcess.writeMcpConfigFile()` writes `{ mcpServers: { ... } }` to a temp file under `$TMPDIR/rondel-mcp/`. The path is passed to Claude via `--mcp-config`. The file is deleted on `stop()`.

### Tools exposed

Everything on this list is available to every agent unless otherwise marked. Admin-only tools are gated by the `RONDEL_AGENT_ADMIN=1` env var that Rondel injects into the MCP process at spawn time based on `agent.json`'s `admin` flag.

| Tool | Parameters | Description | Data source |
|------|-----------|-------------|-------------|
| **Channel outbound (Telegram-only for now)** | | | |
| `rondel_send_telegram` | `chat_id`, `text` | Send text message (Markdown, 4096-char chunking) | Telegram API (direct) |
| `rondel_send_telegram_photo` | `chat_id`, `image_path`, `caption?` | Send local image via multipart upload | Telegram API (direct) |
| **Agents / subagents** | | | |
| `rondel_list_agents` | (none) | List all agent templates + active conversation states | Bridge → AgentManager |
| `rondel_agent_status` | `agent_name` | Get conversations for a specific agent (chatId, state, sessionId) | Bridge → AgentManager |
| `rondel_spawn_subagent` | `task`, `template?`, `system_prompt?`, `working_directory?`, `model?`, `max_turns?`, `timeout_ms?` | Spawn an ephemeral subagent to execute a task | Bridge → AgentManager → SubagentProcess |
| `rondel_subagent_status` | `subagent_id` | Check subagent state and retrieve result | Bridge → AgentManager |
| `rondel_kill_subagent` | `subagent_id` | Kill a running subagent | Bridge → AgentManager → SubagentProcess |
| **Inter-agent messaging** | | | |
| `rondel_send_message` | `to`, `content` | Send async message to another agent. Response auto-delivered back | Bridge → Router → agent-mail conversation |
| `rondel_list_teammates` | (none) | List agents reachable from the caller (org-isolation-filtered) | Bridge → AgentManager |
| `rondel_recall_user_conversation` | `limit?` | Read the agent's own recent user-conversation turns from the transcript. Used inside an agent-mail turn to ground a reply in live context beyond MEMORY.md | Bridge → transcript reader |
| **Memory** | | | |
| `rondel_memory_read` | (none) | Read current agent's MEMORY.md content | Bridge → filesystem |
| `rondel_memory_save` | `content` | Overwrite agent's MEMORY.md (atomic write) | Bridge → filesystem |
| **Orgs (read-only for all agents)** | | | |
| `rondel_list_orgs` | (none) | List discovered organizations | Bridge → AgentManager |
| `rondel_org_details` | `org_name` | Get org config + member agents | Bridge → AgentManager |
| **Conversation ledger** | | | |
| `rondel_ledger_query` | `agent?`, `since?`, `kinds?`, `limit?` | Query activity ledger — returns structured events (summaries, not full content) | Bridge → LedgerReader → `state/ledger/*.jsonl` |
| **Runtime skill reload** | | | |
| `rondel_reload_skills` | (none) | Schedule a post-turn restart of the calling conversation's process so newly-authored per-agent skills become discoverable. Session preserved via `--resume` | Bridge → ConversationManager.scheduleRestartAfterTurn() |
| **Durable scheduling** | | | |
| `rondel_schedule_create` | `name`, `schedule`, `prompt`, `delivery?`, `sessionTarget?`, `model?`, `timeoutMs?`, `deleteAfterRun?`, `targetAgent?` | Create a durable runtime schedule. Three kinds: `every` / `at` / `cron`. Delivery defaults to the caller's active conversation. Non-admins target themselves only; `targetAgent` requires admin | Bridge → ScheduleService → ScheduleStore + Scheduler |
| `rondel_schedule_list` | `targetAgent?`, `includeDisabled?` | List schedules (runtime + declarative for the target agent) with current `nextRunAtMs` / `lastRunAtMs` / `lastStatus` | Bridge → ScheduleService |
| `rondel_schedule_update` | `scheduleId`, `patch` | Patch a schedule. Identity fields (id, source, owner, createdAtMs) are immutable; any other field can be changed | Bridge → ScheduleService |
| `rondel_schedule_delete` | `scheduleId` | Cancel a schedule. Self-only unless admin (same-org rule still applies) | Bridge → ScheduleService → ScheduleStore + Scheduler |
| `rondel_schedule_run` | `scheduleId` | Fire a schedule immediately, bypassing its normal `nextRunAtMs`. Does not affect future firings | Bridge → ScheduleService → Scheduler.triggerNow() |
| **First-class shell / filesystem / prompts** | | | |
| `rondel_bash` | `command`, `working_directory?`, `timeout_ms?` | Run a shell command. Dangerous patterns escalate through the HITL approval service; output truncated at 100 000 chars; emits `tool_call`. Replaces native `Bash` | In-process spawn + Bridge (`/approvals`, `/ledger/tool-call`) |
| `rondel_read_file` | `path`, `max_bytes?` | Read UTF-8 content + sha256 hash. Non-truncated reads register the staleness anchor used by the write/edit suite. Replaces native `Read` | In-process fs + Bridge (`/filesystem/read-state`) |
| `rondel_write_file` | `path`, `content` | Create (unconditional) or overwrite (requires matching prior read). Secret scanner + safe-zone enforcement. Backup → atomic write. Replaces native `Write` | In-process fs + Bridge (`/filesystem/history`, `/approvals`) |
| `rondel_edit_file` | `path`, `old_string`, `new_string`, `replace_all?` | Single-pattern replace. Hard requirement: prior read in this session. Replaces native `Edit` | In-process fs + Bridge |
| `rondel_multi_edit_file` | `path`, `edits[]` | N edits applied in order, all-or-nothing. Replaces native `MultiEdit` | In-process fs + Bridge |
| `rondel_ask_user` | `prompt`, `options[1..8]`, `timeout_ms?` | Dispatch a multiple-choice prompt through the calling channel; poll until resolved. Replaces native `AskUserQuestion` | Bridge (`/prompts/ask-user`) → channel `sendInteractive` |
| **System status** | | | |
| `rondel_system_status` | (none) | System overview: uptime, agent count, per-agent conversations, `currentTimeIso` | Bridge → AgentManager |
| **Admin only (`admin: true`)** | | | |
| `rondel_add_agent` | `agent_name`, `bot_token`, `model?`, `org?`, `location?` | Scaffold new agent + register + start Telegram polling | Bridge → scaffold → AgentManager.registerAgent() |
| `rondel_create_org` | `org_name`, `display_name?` | Scaffold + register a new organization | Bridge → AdminApi → AgentManager.registerOrg() |
| `rondel_update_agent` | `agent_name`, `model?`, `enabled?`, `admin?` | Patch agent.json fields, refresh template | Bridge → AgentManager.updateAgentConfig() |
| `rondel_reload` | (none) | Re-discover all agents + orgs, register new, refresh existing | Bridge → discoverAll → AgentManager |
| `rondel_delete_agent` | `agent_name` | Unregister + delete agent permanently; purges its runtime schedules first | Bridge → ScheduleService.purgeForAgent → AgentManager.unregisterAgent() + rm |
| `rondel_set_env` | `key`, `value` | Set env var in `.env` file + `process.env` | Bridge → filesystem |

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
- **Router consumes the flag before drain.** Both `wireUserProcess` and `wireAgentMailProcess` check `pendingRestarts` at the top of their `idle` branch, *before* queue drain. If set, they clear the flag and call `process.restart()` (stop → await actual exit → start; see "Restart handshake" under Process Model), then return early. The fresh process fires its own idle event on spawn and drains the queue naturally via the existing `sendOrQueue` machinery. Queued messages that arrived during the restart window are preserved.
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
- **`schemas.ts`** — Zod validation schemas for admin, messaging, web-chat, HITL approval, and runtime-schedule request/response bodies. Validated at the boundary before business logic runs. `BRIDGE_API_VERSION` (currently `14`) pinned here.

### Transport

- Node `http` server on `127.0.0.1` with OS-assigned random port
- MCP server receives the URL via `RONDEL_BRIDGE_URL` env var
- Localhost-only, no authentication — same-machine, same-user IPC
- Started before channel adapters at boot

### Endpoints

| Method | Path | Returns |
|--------|------|---------|
| **Meta** | | |
| `GET` | `/version` | `{ apiVersion, rondelVersion }` — version handshake for clients on boot. `apiVersion` is `BRIDGE_API_VERSION` pinned in `bridge/schemas.ts` (currently `14`). Bumped whenever the wire format changes; the web package and any external client should reject unexpected versions. |
| **Reads** | | |
| `GET` | `/agents` | All agent templates with active conversation count and per-conversation state |
| `GET` | `/agents/:name/prompt` | The cached `main`-mode system prompt for an agent, for UI inspection |
| `GET` | `/conversations/:agentName` | Conversations for a specific agent (chatId, state, sessionId) |
| `GET` | `/conversations/:agent/:channelType/:chatId/history` | Ordered user/assistant turns for a conversation, parsed from the Claude CLI transcript file. Returns `{ turns: ConversationTurn[], sessionId }`. Capped at the most recent 200 turns. Unknown `channelType` → 400. No session yet → `{ turns: [], sessionId: null }`. |
| `GET` | `/transcripts/:agent/recent` | Most recent transcript files for an agent (filesystem listing) |
| `GET` | `/orgs` | Discovered organizations |
| `GET` | `/orgs/:name` | Org config + member agents |
| `GET` | `/subagents` | List all subagents (optional `?parent=agentName` filter) |
| `GET` | `/subagents/:id` | Get subagent state, result, cost, timing |
| `GET` | `/memory/:agentName` | Read agent's MEMORY.md content (null if doesn't exist) |
| `PUT` | `/memory/:agentName` | Write agent's MEMORY.md (atomic write, creates if missing) |
| **Subagent lifecycle** | | |
| `POST` | `/subagents/spawn` | Spawn a subagent — returns SubagentInfo with id and state |
| `DELETE` | `/subagents/:id` | Kill a running subagent |
| **Skill reload** | | |
| `POST` | `/agent/schedule-skill-reload` | Schedule a post-turn restart of the specified conversation's process. Body: `{ agent_name, channel_type, chat_id }` (validated by `ScheduleSkillReloadSchema`). Returns immediately; the Router consumes the flag on the next `idle` transition |
| **Ledger** | | |
| `GET` | `/ledger/query?agent=&since=&kinds=&limit=` | Query structured event log. Filters by agent, time range, event kinds. Returns newest-first |
| **Live streams (SSE)** | | |
| `GET` | `/ledger/tail[?since=<ISO>]` | System-wide live ledger. Optional `since` replays events newer than the cursor before the live stream attaches |
| `GET` | `/ledger/tail/:agent[?since=<ISO>]` | Per-agent live ledger. Server-side filter applied at the handler boundary — single shared upstream subscription fans out to all clients |
| `GET` | `/agents/state/tail` | Live conversation state. One `agent_state.snapshot` frame on connect, then `agent_state.delta` frames per state transition |
| `GET` | `/conversations/:agent/:channelType/:chatId/tail` | Per-conversation live SSE stream. New `ConversationStreamSource` constructed per request, disposed on socket close. Emits `conversation.frame` events with a `kind`-discriminated payload (`user_message`, `agent_response`, `typing_start`, `typing_stop`, `session`). For web conversations, replays the adapter's ring buffer before live frames. Unknown `channelType` → 400 |
| `GET` | `/approvals/tail` | Live SSE stream of `approval.requested` / `approval.resolved` frames. Web `/approvals` page subscribes and folds new frames into the server-rendered initial list |
| `GET` | `/schedules/tail` | Live SSE stream of `schedule.{created,updated,deleted,ran}` frames — each carrying a `ScheduleSummary` payload (runtime jobs only). Web `/agents/:name/schedules` page subscribes and folds frames into the server-rendered initial list |
| **Web chat** | | |
| `POST` | `/web/messages/send` | Inject a user message into a web conversation. Body: `{ agent_name, chat_id, text }` (chat_id must start with `web-`). Validated with `WebSendRequestSchema`. Normalizes to `ChannelMessage` via `WebChannelAdapter.ingestUserMessage()` and dispatches through the shared Router pipeline — same `sendOrQueue` path as Telegram. Pre-validates that the agent has a live synthetic web account and returns 503 if not |
| **HITL approvals** | | |
| `POST` | `/approvals/tool-use` | Create a tool-use approval request (called by `rondel_*` MCP tools when their classifier escalates). Returns `{ requestId }` immediately; the caller polls GET. Body validated with `ToolUseApprovalCreateSchema` |
| `GET` | `/approvals/:id` | Get a single approval record (pending or resolved). Used by tool polling and web UI drill-in |
| `GET` | `/approvals` | List pending + recent resolved records. Web UI `/approvals` page consumes this |
| `POST` | `/approvals/:id/resolve` | Resolve a tool-use approval (allow/deny). Body: `{ decision, resolvedBy? }`. Used by the web UI. Telegram resolves via interactive-callback handler in the orchestrator, not this endpoint |
| `GET` | `/approvals/tail` | Live SSE stream of `approval.requested` / `approval.resolved` frames. Web `/approvals` page subscribes and folds new frames into the server-rendered initial list — replaces the previous 2s polling refresher |
| `GET` | `/schedules/tail` | Live SSE stream of `schedule.{created,updated,deleted,ran}` frames — each carrying a `ScheduleSummary` payload (runtime jobs only). Web `/agents/:name/schedules` page subscribes and folds frames into the server-rendered initial list |
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
| **Runtime schedules** | | |
| `GET` | `/schedules?callerAgent=&isAdmin=&targetAgent=&includeDisabled=` | List runtime schedules visible to the caller. Self-only unless admin; cross-org blocked |
| `POST` | `/schedules` | Create a new schedule. Body `{ caller, input }` validated by `ScheduleCreateRequestSchema`. Returns the full `ScheduleSummary` with assigned id and `nextRunAtMs` |
| `GET` | `/schedules/:id?callerAgent=...` | Get a single schedule (same visibility rules as list) |
| `PATCH` | `/schedules/:id` | Patch a schedule. Body `{ caller, patch }` validated by `ScheduleUpdateRequestSchema` |
| `DELETE` | `/schedules/:id` | Cancel a schedule. Body `{ caller }` (HTTP DELETE with body — validated by `ScheduleMutationRequestSchema`) |
| `POST` | `/schedules/:id/run` | Fire a schedule immediately, bypassing `nextRunAtMs`. Body `{ caller }` |
| **Admin (caller must identify as an admin agent — scaffolding tools go through `RONDEL_AGENT_ADMIN`-gated MCP tools)** | | |
| `GET` | `/admin/status` | System status: uptime, agent count, per-agent model/admin/conversations |
| `POST` | `/admin/agents` | Create + register + start a new agent (scaffold + hot-add) |
| `PATCH` | `/admin/agents/:name` | Update agent config fields (model, enabled, admin) |
| `DELETE` | `/admin/agents/:name` | Unregister agent, stop polling, kill conversations, purge runtime schedules, delete directory |
| `POST` | `/admin/orgs` | Scaffold + register a new organization |
| `POST` | `/admin/reload` | Re-discover agents + orgs from workspaces, register new, refresh existing |
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
- **Protocol-agnostic sources, one wire-format handler.** `streams/sse-types.ts` defines a tiny `StreamSource<T>` interface (`subscribe`, optional `snapshot`, `dispose`). The generic `handleSseRequest` in `streams/sse-handler.ts` is the only place that knows the SSE wire format. Future stream sources (system status, …) stay cheap to add.
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

Bot token = routing. Each agent gets its own Telegram bot. `accountId` is the agent name. `AgentManager` maintains bidirectional maps between accounts and agents (`resolveAgentByChannel` / `getPrimaryChannel`). No chat-ID configuration needed — message a bot, you're talking to that agent.

---

## 10. Config & Context

The shape of `RondelConfig` / `AgentConfig` / `OrgConfig`, the "User Space vs Framework Space" boundary, the `workspaces/` layout, and the agent directory structure are documented in [CLAUDE.md](CLAUDE.md). This section covers the runtime behavior — how configs are loaded, how the system prompt is assembled, and the startup sequence.

### Config loading

- `~/.rondel/config.json` holds global settings (`defaultModel`, `allowedUsers`, optional `env`). There is no agent list — agents are discovered by recursively scanning `workspaces/` for `agent.json` files.
- Each `agent.json` is loaded through `parseJsonWithEnv()`, which substitutes `${VAR_NAME}` against `process.env` before JSON parsing. Missing variables throw. This is how bot tokens, DB URLs, and other secrets keep out of git-tracked files.
- `org.json` is discovered the same way; a directory with `org.json` becomes an organization, and agents below it inherit `orgName`. Nested orgs throw on startup.
- `enabled: false` at either level disables that node (and for orgs, its entire subtree).

### Prompt assembly

Pure-function pipeline in `config/prompt/` (see the module summary in §2). Public API:

- `buildPrompt(inputs)` — pure, no I/O. Given a populated `PromptInputs`, returns the `--system-prompt` string.
- `loadPromptInputs(args)` — reads bootstrap files, shared `CONTEXT.md`, tool invariants, and the agent-mail block in parallel, then calls `buildPrompt`.

Four `PromptMode`s:

- **`main`** — user-facing conversation, maximal shape.
- **`agent-mail`** — `main` + the AGENT-MAIL.md block appended at the bottom.
- **`cron`** — ephemeral. Cron preamble prepended above everything; MEMORY.md / USER.md / BOOTSTRAP.md and the memory / admin / CLI framework sections are stripped.
- **`subagent`** — bypasses `buildPrompt` entirely. `rondel_spawn_subagent` passes a `system_prompt` inline (typically sourced from a skill). Named templates go through the separate `template-subagent.ts` pipeline.

Block order in `main` mode (joined with `\n\n` — no `---` rules, no synthetic `# FILENAME` prefix):

```
Framework layer (code-owned, not user-editable):
  Identity · Safety · Tool Call Style · Memory* · Execution Bias ·
  Tool Invariants (from templates/framework-context/TOOLS.md) ·
  Admin Tool Guidance* · CLI Quick Reference* · Current Date & Time ·
  Workspace · Runtime

Shared context (user-owned):
  workspaces/global/CONTEXT.md
  {org}/shared/CONTEXT.md                      (only for agents in an org)

Bootstrap files (user-owned — raw content, no synthetic headings):
  AGENT.md · SOUL.md · IDENTITY.md · USER.md* · MEMORY.md* · BOOTSTRAP.md*

Appended in agent-mail mode:
  AGENT-MAIL.md
```

Sections marked `*` are persistent-only and are stripped in `cron` mode. USER.md has a fallback chain: agent's own → `{org}/shared/USER.md` → `workspaces/global/USER.md`. All user-layer files are optional; missing files are silently skipped.

**Current date & time.** The section emits only the configured timezone and instructs the agent to call `rondel_system_status` for a fresh `currentTimeIso`. We don't bake a timestamp into the spawn-time prompt because agents run for days.

**Agent memory.** `MEMORY.md` is included in the `main` system prompt on every spawn. Agents read/write it via `rondel_memory_read` / `rondel_memory_save`, which call `GET /memory/:agent` and `PUT /memory/:agent` on the bridge. Subagents and cron runs do not see it.

### Startup sequence

Follows `startOrchestrator()` in [apps/daemon/src/index.ts](apps/daemon/src/index.ts). Condensed:

1. `loadEnvFile(paths.env)` — parse `~/.rondel/.env` into `process.env` (no overwrite).
2. If `RONDEL_DAEMON=1`: `initLogFile(paths.log)` — rotate at 10 MB, switch logger to file transport.
3. `loadRondelConfig(home)` → read + validate `~/.rondel/config.json` (env vars now resolve).
4. `discoverAll(home)` → recursive walk of `workspaces/` for orgs + agents. Empty list exits with an error.
5. `acquireInstanceLock(paths.state, log)` — stale-PID detection; writes PID + log path to `rondel.lock`.
6. `createHooks()`, then `new LedgerWriter(paths.state, hooks)` — ledger writer subscribes to every hook event.
7. `new LedgerStreamSource(ledgerWriter)` — SSE fan-out constructed once for the daemon lifetime.
8. `new AgentManager(log, hooks)` + `.initialize(home, agents, allowedUsers, orgs)` — for each agent: load config, `loadPromptInputs` in both `main` and `agent-mail` modes, cache on `AgentTemplate`, register channel bindings (Telegram + synthetic web).
9. `agentManager.loadSessionIndex()` → read `sessions.json` (conversation key → session ID).
10. `new Router(agentManager, log, hooks)`.
11. Hook wiring — subagent spawn/complete/fail delivery, cron logging, inter-agent message console logs.
12. `new AgentStateStreamSource(agentManager.conversations)` — snapshot + delta SSE source.
13. `new ApprovalService({...})` → `init()` + `recoverPending()` (auto-denies orphans BEFORE agents can spawn).
14. `new ApprovalStreamSource(hooks)` + `new ReadFileStateStore(hooks)` + `new FileHistoryStore(paths.state, log)` + schedule 24 h cleanup interval.
15. Wire `channelRegistry.onInteractiveCallback` — matches `rondel_appr_<decision>_<id>` (approvals) and `rondel_aq_<requestId>_<optIdx>` (ask-user); both cosmetically edit the Telegram card via `answerCallbackQuery` / `editMessageText`.
16. `new ScheduleStore(paths.schedulesFile, log)` → `init()`. Then `new Scheduler(...)`, `new ScheduleService({...})`, `new ScheduleStreamSource(hooks, scheduler)`.
17. `new Bridge(agentManager, log, home, hooks, router, ledgerStream, agentStateStream, approvals, readFileState, fileHistory, approvalStream, scheduleService, scheduleStream)` → `start()` → `agentManager.setBridgeUrl()` → `updateLockBridgeUrl()`.
18. `readAllInboxes(paths.state)` → replay any pending inter-agent messages persisted from a prior crash; delivered via `router.deliverAgentMail`.
19. `scheduler.start()` — merges declarative + runtime jobs, restores cron-state, arms timer, runs missed one-shots.
20. `new ScheduleWatchdog({...}).start()` — periodic drift/backoff scan; observation-only by default.
21. `router.start()` + `channelRegistry.startAll()` — subscribe to channel messages and begin Telegram long-polling. Conversation processes spawn lazily on the first inbound message per `(agent, chatId)` pair.

Shutdown (SIGINT/SIGTERM): stop watchdog → stop channels → stop scheduler → stop bridge → dispose SSE sources → stop all agent processes → persist session index → release instance lock.

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

Business-level event log that makes agent activity observable to humans, other agents, and future automation (e.g. Layer 3 monitors). Complements raw transcripts — the ledger is an index (summaries + metadata), not a transcript (full content).

**Storage**: One JSONL file per agent at `state/ledger/{agentName}.jsonl`.

**Event schema**: Every line is a `LedgerEvent`:
```json
{"ts":"2026-03-31T23:27:02.501Z","agent":"bot2","kind":"user_message","channelType":"telegram","chatId":"5948773741","summary":"Anything new in the chat?","detail":{"senderId":"5948773741","senderName":"David"}}
```

Fields: `ts` (ISO 8601), `agent` (agentName), `kind` (event type), `channelType` and `chatId` (optional, paired), `summary` (truncated, max 100 chars for messages / 80 for inter-agent), `detail` (kind-specific metadata).

**Invariant — `channelType` and `chatId` are a pair.** Both are present for conversation- and session-bound events; both are absent for system-wide events (cron). A `chatId` alone is ambiguous — the same id string can occur on different channels (Telegram, web), and every other layer of Rondel keys on the composite `(agentName, channelType, chatId)`. Writers always set them together; readers can rely on the invariant.

**Event kinds**: `user_message`, `agent_response`, `inter_agent_sent`, `inter_agent_received`, `subagent_spawned`, `subagent_result`, `cron_completed`, `cron_failed`, `session_start`, `session_resumed`, `session_reset`, `crash`, `halt`, `approval_request`, `approval_decision`, `tool_call`, `schedule_created`, `schedule_updated`, `schedule_deleted`, `schedule_overdue`, `schedule_recovered`.

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
| `cron-state.json` | Persisted across restarts | Backoff counters, last run times, missed job detection (both declarative and runtime jobs) |
| `schedules.json` | Persisted across restarts; entries removed on delete, cancel, or one-shot auto-delete | Runtime schedule store — `{version:1, jobs:[...]}`. Owned by `ScheduleStore`. Declarative jobs stay in `agent.json` and are not mirrored here |
| `inboxes/{agent}.json` | Deleted after delivery | Per-agent pending inter-agent messages. Recovered on startup |
| `ledger/{agent}.jsonl` | Grows indefinitely, rotation TBD | Per-agent structured event log (Layer 1). Business-level events: user messages, responses, inter-agent, subagent, cron, session lifecycle, approval requests/decisions. Summaries only, not full content |
| `transcripts/{agent}/{session}.jsonl` | Grows indefinitely, prune TBD | Per-conversation raw stream-json events + user entries. Forensic-level — complements the ledger |
| `approvals/pending/{id}.json` | Deleted on resolution | One file per pending tool-use approval. Moved to resolved/ on decision |
| `approvals/resolved/{id}.json` | Grows indefinitely, prune TBD | Resolved approval records. Kept for audit trail and web UI history |

---

## 13. Web UI (`@rondel/web`)

The dashboard at [apps/web/](apps/web/) is a Next.js 15 App Router client of the daemon's HTTP bridge. It never imports runtime values from `@rondel/daemon`; every request flows through the loopback proxy at `app/api/bridge/[...path]/route.ts`, and every domain type is derived from a Zod schema at that boundary (see [apps/web/lib/bridge/schemas.ts](apps/web/lib/bridge/schemas.ts)).

### Stack

| Concern | Choice |
|---|---|
| Framework | Next.js 15 (App Router, React 19, Server Components by default) |
| Styling | Tailwind CSS v4 (CSS-first `@theme`, no `tailwind.config.ts`), `@tailwindcss/postcss`, `tw-animate-css`, `tw-shimmer` |
| Components | shadcn/ui primitives (`new-york` style, `zinc` base) in [components/ui/](apps/web/components/ui/) — owned by this repo, edited freely. `class-variance-authority` + `tailwind-variants` for variants. `cn()` helper in [lib/utils.ts](apps/web/lib/utils.ts) |
| Icons | `lucide-react` |
| Chat | `@assistant-ui/react` + `@assistant-ui/react-markdown`. Scaffolded Thread/Composer/Markdown live in [components/assistant-ui/](apps/web/components/assistant-ui/) |
| Markdown | `react-markdown` + `rehype-sanitize` + `remark-gfm` + `remark-breaks` (unchanged from before the revamp) |
| State / runtime | assistant-ui's `ExternalStoreRuntime`; no Vercel AI SDK, no Zustand for chat state |
| Command palette | `cmdk` |
| Motion | `motion` (the former `framer-motion`) with `useReducedMotion` gating |
| Theme | `next-themes` (class attribute, `dark` default, system mode disabled) |
| Shortcuts | `react-hotkeys-hook` |
| Toasts | `sonner` |
| Validation | `zod` (same schemas as the daemon at the wire boundary) |

### Shell

[app/(dashboard)/layout.tsx](apps/web/app/(dashboard)/layout.tsx) wraps everything in `CommandPaletteProvider` + `HotkeyProvider`, fetches agents and approvals once (deduplicated via React `cache()`), and renders a three-region shell:

```
┌─────────────────────────────────────────────────┐
│ TopBar (breadcrumbs · ⌘K · approvals · theme)  │
├──────────┬──────────────────────────────────────┤
│ Sidebar  │ RouteTransition > children           │
│ (agents) │                                      │
│ approvals│                                      │
└──────────┴──────────────────────────────────────┘
```

- [components/layout/topbar.tsx](apps/web/components/layout/topbar.tsx) — segment-derived breadcrumbs, palette trigger, approvals badge (live via `useApprovalStream`), theme toggle.
- [components/layout/sidebar.tsx](apps/web/components/layout/sidebar.tsx) — nav + agents grouped by org; live state dots via [components/layout/live-agent-badges.tsx](apps/web/components/layout/live-agent-badges.tsx).
- [components/layout/route-transition.tsx](apps/web/components/layout/route-transition.tsx) — `motion.AnimatePresence` fade on route change, suppressed under `prefers-reduced-motion`.
- [components/command-palette.tsx](apps/web/components/command-palette.tsx) — `cmdk` dialog with `mod+k`. Navigation, per-agent "chat / memory", theme toggle.
- [components/hotkey-provider.tsx](apps/web/components/hotkey-provider.tsx) — `g a` / `g p` navigation + `⌘.` theme toggle. Palette owns its own `⌘K` binding.

### Theming

Tokens are declared in CSS-first Tailwind v4 `@theme` blocks inside [styles/globals.css](apps/web/styles/globals.css). The **dark** palette sits on `:root` (so a user with JS disabled still gets the intended look); the **light** palette overrides the same HSL variables under a `.light` class added by `next-themes` via `attribute="class"`. System mode is disabled — the toggle is the only way into light mode, and the choice persists in `localStorage`. There is no `tailwind.config.ts` file.

### Chat surface

This is the only non-trivial client-side state in the package. The chat view is split into a runtime and a presentation layer:

- **[components/chat/rondel-runtime.tsx](apps/web/components/chat/rondel-runtime.tsx)** — a `useExternalStoreRuntime<DisplayMessage>(…)` that owns a local `messages` array plus a typing flag. It subscribes to the existing `useConversationTail(agent, channelType, chatId)` hook (which in turn reads the bridge SSE stream at `/conversations/{agent}/{channelType}/{chatId}/tail`), folds `user_message` / `agent_response` / `agent_response_delta` / `typing_*` / `session` frames into the store (same block-id streaming reducer as the previous handwritten ChatView), and routes new user messages through the existing `POST /api/bridge/web/messages/send` proxy. `isRunning` is true whenever a typing indicator is active or an assistant block is still accumulating deltas. Read-only mirrors (non-web channels) set `isDisabled: true` and `onNew` throws.
- **[components/chat/chat-view.tsx](apps/web/components/chat/chat-view.tsx)** — presentational shell that mounts `<RondelRuntimeProvider>` around assistant-ui's `<Thread />`. No state.
- **[components/assistant-ui/](apps/web/components/assistant-ui/)** — assistant-ui's scaffolded `Thread`, `MarkdownText`, tool-call fallback, attachments, reasoning block. Themed with Tailwind tokens; no custom CSS.

The bridge contract is unchanged: the daemon sees a regular web-channel user message, responds through the ring-buffered per-conversation fan-out, and the browser renders it. Nothing about `WebChannelAdapter`, `ConversationStreamSource`, or the proxy route changed in the revamp — the rewrite is confined to what the browser does with frames already on the wire.

### Loopback enforcement

[apps/web/middleware.ts](apps/web/middleware.ts) rejects any request whose `host` header is not `127.0.0.1` or `localhost` with a 403. The proxy route [apps/web/app/api/bridge/[...path]/route.ts](apps/web/app/api/bridge/[...path]/route.ts) is the only way to reach the daemon bridge; it carries a small GET allowlist plus the single `POST /web/messages/send` entry needed by the chat client component. The loopback gate is unchanged by the revamp.

### Not included

- No admin UI (agent create/delete, env edit) — those stay CLI-only for now.
- No chat cancel / interrupt button — requires a new bridge endpoint on the daemon.
- No system-preference theme — infrastructure is in place (`enableSystem={false}` in the provider); flip to enable.
