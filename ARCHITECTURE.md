# Rondel Architecture (as built)

> Current state of the codebase as of Phase 11 (conversation ledger). Only documents what exists in code — not planned features.

---

## 1. System Overview

Rondel is a single-installation system at `~/.rondel/` (overridable via `RONDEL_HOME`) that bridges Telegram bots to Claude CLI processes via the `stream-json` protocol. It runs as an OS-managed background service (launchd on macOS, systemd on Linux) that auto-starts on login and auto-restarts on crash. Organizations and agents are discovered automatically by scanning `workspaces/` for directories containing `org.json` and `agent.json` respectively. Organizations group agents and provide shared context; agents within an org get org-specific context injected between global and per-agent context. Each agent is a template (config + system prompt). No Claude processes run at startup — they spawn lazily when a user sends the first message to a bot. Each unique chat gets its own isolated Claude process with its own session. The MCP protocol injects tools (Telegram messaging, agent queries, org management, inter-agent messaging) into each agent process. An internal HTTP bridge allows MCP server processes to query Rondel core state. A CLI (`rondel init`, `add agent`, `add org`, `stop`, `logs`, `service`, etc.) handles setup and lifecycle management.

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

### Source files (~45 files, ~8000 lines, 2 runtime dependencies)

| File | Lines | Responsibility | Depends on |
|------|-------|---------------|------------|
| [index.ts](apps/daemon/src/index.ts) | 175 | Orchestrator entry point. Exports `startOrchestrator(rondelHome?)`. Loads .env, sets up daemon logging, loads config, discovers orgs+agents via `discoverAll()`, creates hooks, wires LedgerWriter, initializes AgentManager (with orgs), wires hook listeners, starts scheduler/bridge/router/polling. Also runnable directly for daemon mode and backward compat | env-loader, config, agent-manager, router, bridge, scheduler, hooks, ledger, instance-lock, logger |
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
| [ledger/ledger-types.ts](apps/daemon/src/ledger/ledger-types.ts) | 65 | `LedgerEvent`, `LedgerEventKind` type definitions + `LedgerQuerySchema` Zod schema for MCP tool input validation. Pure types + one Zod import | zod |
| [ledger/ledger-writer.ts](apps/daemon/src/ledger/ledger-writer.ts) | 230 | `LedgerWriter` class. Subscribes to all RondelHooks events, transforms each into a `LedgerEvent`, appends JSONL to `state/ledger/{agentName}.jsonl`. Fire-and-forget writes, lazy directory creation | hooks, ledger-types |
| [ledger/ledger-reader.ts](apps/daemon/src/ledger/ledger-reader.ts) | 130 | `queryLedger()` function. Reads per-agent JSONL files, filters by time range / event kinds / limit, returns newest-first. Supports relative time ("6h", "1d") and ISO 8601 | ledger-types |
| [ledger/index.ts](apps/daemon/src/ledger/index.ts) | 5 | Barrel exports for ledger module | ledger-writer, ledger-reader, ledger-types |
| **Core** | | | |
| [hooks.ts](apps/daemon/src/shared/hooks.ts) | 135 | Typed EventEmitter for lifecycle hooks. Conversation events (`message_in`, `response`) + session lifecycle (`start`, `resumed`, `reset`, `crash`, `halt`) + subagent events + cron events + inter-agent messaging events | types |
| [types/](apps/daemon/src/shared/types/) | ~260 | Domain-aligned type definitions split across 8 files: `config.ts` (RondelConfig, AgentConfig, OrgConfig, discovery types), `agents.ts` (AgentState, AgentEvent, stream-json protocol), `subagents.ts` (SubagentSpawnRequest, SubagentState, SubagentInfo), `scheduling.ts` (CronJob, CronSchedule, CronJobState), `sessions.ts` (ConversationKey branded type + constructor/parser, SessionEntry, SessionIndex), `routing.ts` (QueuedMessage with optional AgentMailReplyTo), `transcripts.ts` (TranscriptSessionHeader, TranscriptUserEntry), `messaging.ts` (InterAgentMessage, AgentMailReplyTo, hook event types). Barrel `index.ts` re-exports all. Each file has zero runtime imports — pure types only, safe to import anywhere | (none, except `config.ts` imports type from `scheduling.ts`, `routing.ts` imports type from `messaging.ts`) |
| [env-loader.ts](apps/daemon/src/config/env-loader.ts) | 30 | Minimal .env parser. Loads `KEY=VALUE` lines into `process.env` (doesn't overwrite existing vars). Critical for service context where shell profile isn't loaded | (none) |
| [config.ts](apps/daemon/src/config/config.ts) | 270 | `resolveRondelHome()`, `rondelPaths()`, load config from `~/.rondel/config.json`, recursive org+agent discovery from `workspaces/` via `discoverAll()`, `loadOrgConfig()`, `discoverSingleAgent()` / `discoverSingleOrg()` for hot-add, `${ENV_VAR}` substitution, validation. Nested org detection, disabled org subtree skipping | types |
| [context-assembler.ts](apps/daemon/src/config/context-assembler.ts) | 160 | Assemble agent context from bootstrap files with `# filename` heading prefixes. Layer order: global/CONTEXT.md → {org}/shared/CONTEXT.md (if org) → AGENT.md + SOUL.md + IDENTITY.md + USER.md + MEMORY.md + BOOTSTRAP.md. USER.md fallback chain: agent → org/shared → global. Falls back to legacy SYSTEM.md. Ephemeral mode strips MEMORY.md + USER.md + BOOTSTRAP.md. Also handles template context assembly | config, logger |
| [channels/core/channel.ts](apps/daemon/src/channels/core/channel.ts) | 85 | `ChannelAdapter` interface + `ChannelMessage` + `ChannelCredentials` types. Core types every adapter depends on — no adapter-specific knowledge | (none) |
| [channels/core/registry.ts](apps/daemon/src/channels/core/registry.ts) | 130 | `ChannelRegistry` class. Central adapter lookup + dispatch. `startAll`/`stopAll` wrap per-adapter errors (one bad adapter cannot halt startup/shutdown) | channel, logger |
| [channels/telegram/adapter.ts](apps/daemon/src/channels/telegram/adapter.ts) | 330 | `TelegramAdapter` implementing `ChannelAdapter`. Multi-account, long-polling, send text with Markdown + chunking, typing indicator lifecycle (start/stop with 4s refresh loop — Telegram expires after ~5s). `startAccount()` for hot-adding agents at runtime | channels/core, logger |
| [channels/telegram/mcp-tools.ts](apps/daemon/src/channels/telegram/mcp-tools.ts) | 170 | `registerTelegramTools(server)` — registers `rondel_send_telegram` + `rondel_send_telegram_photo` MCP tools on a passed-in server. No-op if `RONDEL_CHANNEL_TELEGRAM_TOKEN` is not set for the agent | @modelcontextprotocol/sdk |
| [agent-manager.ts](apps/daemon/src/agents/agent-manager.ts) | 470 | Agent template registry + org registry + account mapping + facade. Takes `rondelHome` + `DiscoveredAgent[]` + `DiscoveredOrg[]`, assembles system prompts (with orgDir for context layering), creates focused managers. Stores `agentDirs`, `agentOrgs`, and `orgRegistry`. Delegates lifecycle to ConversationManager, SubagentManager, CronRunner. `registerAgent()` / `registerOrg()` for hot-add, `getOrgs()` / `getOrgByName()` / `getAgentOrg()` for queries, `getSystemStatus()` includes org info | conversation-manager, subagent-manager, cron-runner, telegram, config, context-assembler, hooks, types, logger |
| [conversation-manager.ts](apps/daemon/src/agents/conversation-manager.ts) | 310 | Per-conversation process lifecycle + session persistence. Owns the `conversations` map (`ConversationKey` → AgentProcess) and the session index (sessions.json). Uses branded `ConversationKey` type from `shared/types/sessions.ts`. Spawns processes with `--session-id` (new) or `--resume` (existing). Handles session reset (`/new`), resume failure detection, transcript creation. Emits session lifecycle hooks (`session:start`, `session:resumed`, `session:reset`, `session:crash`, `session:halt`) by translating AgentProcess `stateChange` events into RondelHooks | agent-process, transcript, hooks, types (ConversationKey), logger |
| [subagent-manager.ts](apps/daemon/src/agents/subagent-manager.ts) | 289 | Ephemeral subagent spawning, tracking, and garbage collection. Resolves templates, builds MCP configs, emits lifecycle hooks (subagent:spawning/completed/failed). Background timer prunes completed results after 1 hour | subagent-process, agent-process (McpConfigMap), config, context-assembler, transcript, hooks, types, logger |
| [cron-runner.ts](apps/daemon/src/scheduling/cron-runner.ts) | 138 | Cron job execution engine. Two modes: `runIsolated()` spawns a fresh SubagentProcess (with ephemeral context — no MEMORY.md/USER.md), `getOrSpawnNamedSession()` delegates to ConversationManager for persistent sessions. Owns transcript creation for cron runs | subagent-process, agent-process (McpConfigMap), context-assembler, conversation-manager, transcript, types, logger |
| [agent-process.ts](apps/daemon/src/agents/agent-process.ts) | 410 | Single persistent Claude CLI process. Spawn with `stream-json`, parse events, send messages, manage state, crash recovery, MCP config file lifecycle. Session-aware: `--session-id` for new sessions, `--resume` for crash recovery. Passes `--add-dir` for per-agent and framework skill discovery. Transcript capture: appends all stream-json events to JSONL | types, transcript, logger |
| [subagent-process.ts](apps/daemon/src/agents/subagent-process.ts) | 310 | Ephemeral Claude CLI process for task execution. Single task in, result out, exit. Timeout, MCP config, structured result parsing. Passes `--add-dir` for framework skill discovery. Transcript capture: appends all stream-json events to JSONL | types, transcript, agent-process (McpConfigMap type), logger |
| [transcript.ts](apps/daemon/src/shared/transcript.ts) | 58 | Append-only JSONL transcript writer. Creates transcript files, appends entries. Fire-and-forget writes that never block the agent | logger |
| [messaging/inbox.ts](apps/daemon/src/messaging/inbox.ts) | 114 | File-based inbox for inter-agent message persistence. `appendToInbox()` writes before delivery, `removeFromInbox()` clears after. `readAllInboxes()` recovers pending messages on startup. Each agent gets `state/inboxes/{agentName}.json`. No locking needed — single writer (Bridge process), atomic file writes | atomic-file, types (InterAgentMessage) |
| [router.ts](apps/daemon/src/routing/router.ts) | 410 | Inbound message routing: account → agent resolution, message queuing per conversation (using branded `ConversationKey`), system commands, response dispatch back to Telegram. Emits `conversation:message_in` (on user message) and `conversation:response` (on agent reply). Inter-agent messaging: `deliverAgentMail()` spawns agent-mail conversations, `wireAgentMailProcess()` buffers responses and routes replies back to senders. Emits `message:reply` hook. | agent-manager, agent-process, channel, hooks, types (ConversationKey, AgentMailReplyTo), logger |
| [bridge.ts](apps/daemon/src/bridge/bridge.ts) | 575 | Internal HTTP server (localhost, random port). Owns HTTP routing, read-only endpoints (agents, conversations, subagents, memory, orgs, ledger query), subagent spawn/kill, inter-agent messaging (`POST /messages/send`, `GET /messages/teammates`), org isolation enforcement, and body parsing. Admin mutation endpoints are delegated to AdminApi. Async-safe readBody | http (node built-in), admin-api, schemas, ledger, agent-manager, router, hooks, atomic-file, types (InterAgentMessage), logger |
| [admin-api.ts](apps/daemon/src/bridge/admin-api.ts) | 280 | Admin mutation logic extracted from bridge. Methods return `{ status, data }` — HTTP-framework-agnostic. Handles add/update/delete agent, add org, reload, set env, system status. Uses Zod schemas for request validation | schemas, config, scaffold, agent-manager, atomic-file, logger |
| [schemas.ts](apps/daemon/src/bridge/schemas.ts) | 100 | Zod validation schemas for admin and messaging endpoints: `AddAgentSchema`, `UpdateAgentSchema`, `AddOrgSchema`, `SetEnvSchema`, `SendMessageSchema`. Includes `validateBody()` helper that returns structured errors | zod |
| [mcp-server.ts](apps/daemon/src/bridge/mcp-server.ts) | 810 | Standalone MCP server process. Exposes Telegram tools + bridge query tools + subagent tools + inter-agent messaging tools (`rondel_send_message`, `rondel_list_teammates`) + ledger query tool (`rondel_ledger_query`) + memory tools + org tools (`rondel_list_orgs`, `rondel_org_details` — all agents) + system status (all agents) + admin tools (gated by `RONDEL_AGENT_ADMIN`: add_agent with `org` param, create_org, update_agent, delete_agent, reload, set_env). Calls Telegram API directly and Rondel bridge via HTTP | `@modelcontextprotocol/sdk`, zod |
| [scheduler.ts](apps/daemon/src/scheduling/scheduler.ts) | 581 | Timer-driven cron job runner. Reads `crons` from agent configs, manages timers, delegates execution to CronRunner (isolated) or CronRunner + ConversationManager (named sessions), delivers results via Telegram or log. State persistence, backoff, missed job recovery | agent-manager, cron-runner, telegram, hooks, types, logger |
| [atomic-file.ts](apps/daemon/src/shared/atomic-file.ts) | 36 | Atomic file write utility. Write-to-temp + rename pattern for state files (sessions.json, cron-state.json, lockfile). Prevents data corruption on crash mid-write | (none) |
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
  ├── bridge.ts ──── admin-api.ts, schemas.ts, ledger/, agent-manager.ts, router.ts, hooks.ts, atomic-file.ts, types.ts, logger.ts
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
  --dangerously-skip-permissions \      # if permissionMode = "bypassPermissions"
  --allowedTools <tool list> \
  --disallowedTools <tool list> \
  --mcp-config <temp-file-path> \
  --add-dir <agentDir> \               # per-agent skill discovery
  --add-dir <framework-skills-dir>         # framework skill discovery
```

Built at [agent-process.ts:57](apps/daemon/src/agents/agent-process.ts#L57). Working directory set from `agentConfig.workingDirectory` if non-null.

### Framework-disallowed tools

Rondel always adds certain built-in Claude CLI tools to `--disallowedTools` because it supersedes them with managed MCP equivalents. These are merged with any user-configured disallowed tools from `agent.json`.

| Built-in tool | Rondel replacement | Why |
|--------------|---------------------|-----|
| `Agent` | `rondel_spawn_subagent` | Rondel owns delegation — it needs to track, kill, and budget subagent lifecycles. The built-in Agent tool is a black box. |

Defined in `FRAMEWORK_DISALLOWED_TOOLS` at [agent-process.ts:24](apps/daemon/src/agents/agent-process.ts#L24). This is a framework invariant, not a per-agent config choice.

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
└── rondel-manage-config/SKILL.md    # Config/env/reload with confirmation
```

### How skills trigger

Claude CLI loads skill descriptions into agent context automatically. The model pattern-matches user requests against descriptions and invokes matching skills via the `Skill` tool. The agent then reads the full SKILL.md and follows its instructions. Only the lightweight description is in every session — full content loads on-demand.

### Per-agent skills

Each agent directory has `.claude/skills/` (created at scaffold time). Users or agents can drop SKILL.md files there to teach the agent custom workflows. These are discovered via the `--add-dir <agentDir>` flag.

---

## 8. HTTP Bridge (MCP ↔ Rondel Core)

### Purpose

MCP server processes are spawned by Claude CLI, not by Rondel — they run in a separate process tree. The bridge is the communication channel back to Rondel core. Telegram tools don't need it (they call Telegram API directly), but any tool that needs Rondel state (agent list, conversation status, and eventually subagent spawning, inter-agent messaging) goes through the bridge.

### Internal structure

The bridge is split into three files:
- **`bridge.ts`** — HTTP server lifecycle, request routing, read-only endpoints (agents, conversations, subagents, memory, orgs), inter-agent messaging endpoints (`/messages/send`, `/messages/teammates`), org isolation enforcement, body parsing helpers. Admin mutation routes are delegated to AdminApi. Receives `hooks` and `router` for messaging delivery.
- **`admin-api.ts`** — Business logic for admin mutations (add/update/delete agent, add org, reload, set env, system status). Methods return `{ status, data }` — the bridge handles HTTP response writing. This keeps admin logic HTTP-framework-agnostic and testable.
- **`schemas.ts`** — Zod validation schemas for admin and messaging request bodies (`AddAgentSchema`, `UpdateAgentSchema`, `AddOrgSchema`, `SetEnvSchema`, `SendMessageSchema`). Validated at the boundary before business logic runs.

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
| **Conversation ledger** | | |
| `GET` | `/ledger/query?agent=&since=&kinds=&limit=` | Query structured event log. Filters by agent, time range, event kinds. Returns newest-first |
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

## 9. Channel Adapter Pattern

### Interface ([channels/core/channel.ts](apps/daemon/src/channels/core/channel.ts))

```typescript
interface ChannelAdapter {
  readonly id: string;
  addAccount(accountId: string, config: AccountConfig): void;
  start(): void;
  stop(): void;
  onMessage(handler: (msg: ChannelMessage) => void): void;
  sendText(accountId: string, chatId: string, text: string): Promise<void>;
  startTypingIndicator(accountId: string, chatId: string): void;
  stopTypingIndicator(accountId: string, chatId: string): void;
}

interface ChannelMessage {
  readonly accountId: string;
  readonly chatId: string;
  readonly senderId: string;
  readonly senderName: string;
  readonly text: string;
  readonly messageId: number;
}
```

### TelegramAdapter implementation ([channels/telegram/adapter.ts](apps/daemon/src/channels/telegram/adapter.ts))

- One `TelegramAdapter` instance manages N `TelegramAccount` objects (one per bot)
- Each account polls independently via `getUpdates()` with 30s long-poll timeout
- `allowedUsers` set is shared across all accounts (from `~/.rondel/config.json`)
- Outbound: Markdown formatting with automatic plain-text fallback on parse failure ([channels/telegram/adapter.ts](apps/daemon/src/channels/telegram/adapter.ts))
- Message chunking at 4096 chars, breaking at newlines or spaces ([channels/telegram/adapter.ts](apps/daemon/src/channels/telegram/adapter.ts))

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
  readonly permissionMode: string;          // "bypassPermissions" → --dangerously-skip-permissions
  readonly workingDirectory: string | null;
  readonly telegram: { readonly botToken: string };
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
workspaces/global/CONTEXT.md   Layer 1: Global (platform mechanics, session commands)
  ---
# AGENT.md                     Layer 2: Operating instructions, rules, delegation
# SOUL.md                      Layer 3: Persona, tone, boundaries
# IDENTITY.md                  Layer 4: Name, creature, vibe, emoji, avatar
# USER.md                      Layer 5: User profile, preferences, timezone
# MEMORY.md                    Layer 6: Agent-maintained persistent knowledge
# BOOTSTRAP.md                 Layer 7: First-run ritual (deleted after completion)
```

All files are optional — missing files are silently skipped. If no bootstrap files exist, falls back to legacy `SYSTEM.md`.

**Ephemeral context filtering:** Subagent and cron contexts strip `MEMORY.md`, `USER.md`, and `BOOTSTRAP.md` to keep ephemeral processes lightweight and prevent leaking personal context.

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
1. loadRondelConfig()           → read + validate ~/.rondel/config.json (env vars now available)
2. AgentManager.initialize()      → for each agent:
   a. loadAgentConfig()           → read + validate agent.json (including crons[])
   b. assembleContext()           → read + concatenate markdown layers
   c. Store as AgentTemplate      → (no process spawned)
   d. telegram.addAccount()       → register bot token
3. AgentManager.loadSessionIndex() → read sessions.json (conversation key → session ID)
4. Bridge.start()                 → HTTP server on 127.0.0.1:<random-port>
5. agentManager.setBridgeUrl()    → MCP processes will receive this via env var
6. Scheduler.start()              → load cron jobs, restore state, arm timer, run missed jobs
7. Router.start()                 → subscribe to channel messages
8. telegram.start()               → begin long-polling on all accounts
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
{"ts":"2026-03-31T23:27:02.501Z","agent":"bot2","kind":"user_message","chatId":"5948773741","summary":"Anything new in the chat?","detail":{"senderId":"5948773741","senderName":"David"}}
```

Fields: `ts` (ISO 8601), `agent` (agentName), `kind` (event type), `chatId` (optional), `summary` (truncated, max 100 chars for messages / 80 for inter-agent), `detail` (kind-specific metadata).

**Event kinds**: `user_message`, `agent_response`, `inter_agent_sent`, `inter_agent_received`, `subagent_spawned`, `subagent_result`, `cron_completed`, `cron_failed`, `session_start`, `session_resumed`, `session_reset`, `crash`, `halt`.

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
| `ledger/{agent}.jsonl` | Grows indefinitely, rotation TBD | Per-agent structured event log (Layer 1). Business-level events: user messages, responses, inter-agent, subagent, cron, session lifecycle. Summaries only, not full content |
| `transcripts/{agent}/{session}.jsonl` | Grows indefinitely, prune TBD | Per-conversation raw stream-json events + user entries. Forensic-level — complements the ledger |
