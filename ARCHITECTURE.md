# Rondel Architecture (as built)

> Current state of the codebase as of Phase 9 (org awareness). Only documents what exists in code — not planned features.

---

## 1. System Overview

Rondel is a single-installation system at `~/.rondel/` (overridable via `RONDEL_HOME`) that bridges Telegram bots to Claude CLI processes via the `stream-json` protocol. It runs as an OS-managed background service (launchd on macOS, systemd on Linux) that auto-starts on login and auto-restarts on crash. Organizations and agents are discovered automatically by scanning `workspaces/` for directories containing `org.json` and `agent.json` respectively. Organizations group agents and provide shared context; agents within an org get org-specific context injected between global and per-agent context. Each agent is a template (config + system prompt). No Claude processes run at startup — they spawn lazily when a user sends the first message to a bot. Each unique chat gets its own isolated Claude process with its own session. The MCP protocol injects tools (Telegram messaging, agent queries, org management) into each agent process. An internal HTTP bridge allows MCP server processes to query Rondel core state. A CLI (`rondel init`, `add agent`, `add org`, `stop`, `logs`, `service`, etc.) handles setup and lifecycle management.

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

### Source files (35 files, ~7000 lines, 1 runtime dependency)

| File | Lines | Responsibility | Depends on |
|------|-------|---------------|------------|
| [index.ts](src/index.ts) | 175 | Orchestrator entry point. Exports `startOrchestrator(rondelHome?)`. Loads .env, sets up daemon logging, loads config, discovers orgs+agents via `discoverAll()`, creates hooks, initializes AgentManager (with orgs), wires hook listeners, starts scheduler/bridge/router/polling. Also runnable directly for daemon mode and backward compat | env-loader, config, agent-manager, router, bridge, scheduler, hooks, instance-lock, logger |
| **CLI** | | | |
| [cli/index.ts](src/cli/index.ts) | 125 | CLI entry point (`bin` field). Parses commands (init, add agent, add org, stop, restart, logs, status, doctor, service), routes to handlers | cli/* |
| [cli/init.ts](src/cli/init.ts) | 160 | `rondel init` — creates `~/.rondel/` structure, config, .env, scaffolds first agent with BOOTSTRAP.md. Offers OS service installation at the end | config, scaffold, prompt, service |
| [cli/add-agent.ts](src/cli/add-agent.ts) | 75 | `rondel add agent` — scaffolds new agent directory with config + context files | config, scaffold, prompt |
| [cli/add-org.ts](src/cli/add-org.ts) | 85 | `rondel add org` — scaffolds new organization directory with org.json + shared context structure. Validates name format and uniqueness | config, scaffold, prompt |
| [cli/stop.ts](src/cli/stop.ts) | 70 | `rondel stop` — service-aware: uses launchctl/systemctl/taskkill if service is installed, raw SIGTERM otherwise. Polls for process exit, escalates to SIGKILL | instance-lock, service, prompt |
| [cli/restart.ts](src/cli/restart.ts) | 40 | `rondel restart` — restarts the OS service (requires installed service) | service, prompt |
| [cli/logs.ts](src/cli/logs.ts) | 50 | `rondel logs` — tail the daemon log file. `--follow`/`-f` for real-time, `--lines N`/`-n N` for line count | instance-lock, config |
| [cli/service.ts](src/cli/service.ts) | 100 | `rondel service [install\|uninstall\|status]` — manages OS service registration via the service module | service, config, prompt |
| [cli/status.ts](src/cli/status.ts) | 95 | `rondel status` — shows service status, PID, uptime, log path, queries /agents endpoint for conversation states | instance-lock, service, config, prompt |
| [cli/doctor.ts](src/cli/doctor.ts) | 195 | `rondel doctor` — 10 expandable diagnostic checks (init, config, CLI, orgs, agents, configs, tokens, state, service, skills) | config, service, prompt |
| [cli/prompt.ts](src/cli/prompt.ts) | 55 | Interactive prompt helpers (readline-based, no deps). ask(), confirm(), styled output | (none) |
| [cli/scaffold.ts](src/cli/scaffold.ts) | 110 | Agent + org directory scaffolding. `scaffoldAgent()` creates agent.json + context files + `.claude/skills/`. `scaffoldOrg()` creates org.json + `shared/CONTEXT.md` + `agents/` dir. Loads templates from `templates/context/` with `{{agentName}}`/`{{orgName}}` substitution. Used by CLI and bridge admin endpoints | (none) |
| **Core** | | | |
| [hooks.ts](src/shared/hooks.ts) | 62 | Typed EventEmitter for lifecycle hooks. Subagent events + cron events | types |
| [types.ts](src/shared/types.ts) | 230 | All shared interfaces: `RondelConfig`, `AgentConfig` (with `admin?` flag), `OrgConfig`, `DiscoveredAgent` (with `orgName?`/`orgDir?`), `DiscoveredOrg`, `DiscoveryResult`, `McpServerEntry`, agent events, state types, subagent types, cron types, session persistence types | (none) |
| [env-loader.ts](src/config/env-loader.ts) | 30 | Minimal .env parser. Loads `KEY=VALUE` lines into `process.env` (doesn't overwrite existing vars). Critical for service context where shell profile isn't loaded | (none) |
| [config.ts](src/config/config.ts) | 270 | `resolveRondelHome()`, `rondelPaths()`, load config from `~/.rondel/config.json`, recursive org+agent discovery from `workspaces/` via `discoverAll()`, `loadOrgConfig()`, `discoverSingleAgent()` / `discoverSingleOrg()` for hot-add, `${ENV_VAR}` substitution, validation. Nested org detection, disabled org subtree skipping | types |
| [context-assembler.ts](src/config/context-assembler.ts) | 160 | Assemble agent context from bootstrap files with `# filename` heading prefixes. Layer order: global/CONTEXT.md → {org}/shared/CONTEXT.md (if org) → AGENT.md + SOUL.md + IDENTITY.md + USER.md + MEMORY.md + BOOTSTRAP.md. USER.md fallback chain: agent → org/shared → global. Falls back to legacy SYSTEM.md. Ephemeral mode strips MEMORY.md + USER.md + BOOTSTRAP.md. Also handles template context assembly | config, logger |
| [channel.ts](src/channels/channel.ts) | 60 | `ChannelAdapter` interface + `ChannelMessage` + `AccountConfig` types | (none) |
| [telegram.ts](src/channels/telegram.ts) | 295 | `TelegramAdapter` implementing `ChannelAdapter`. Multi-account, long-polling, send text with Markdown + chunking, typing indicator lifecycle (start/stop with 4s refresh loop — Telegram expires after ~5s). `startAccount()` for hot-adding agents at runtime | channel, logger |
| [agent-manager.ts](src/agents/agent-manager.ts) | 470 | Agent template registry + org registry + account mapping + facade. Takes `rondelHome` + `DiscoveredAgent[]` + `DiscoveredOrg[]`, assembles system prompts (with orgDir for context layering), creates focused managers. Stores `agentDirs`, `agentOrgs`, and `orgRegistry`. Delegates lifecycle to ConversationManager, SubagentManager, CronRunner. `registerAgent()` / `registerOrg()` for hot-add, `getOrgs()` / `getOrgByName()` / `getAgentOrg()` for queries, `getSystemStatus()` includes org info | conversation-manager, subagent-manager, cron-runner, telegram, config, context-assembler, hooks, types, logger |
| [conversation-manager.ts](src/agents/conversation-manager.ts) | 314 | Per-conversation process lifecycle + session persistence. Owns the `conversations` map (conversationKey → AgentProcess) and the session index (sessions.json). Spawns processes with `--session-id` (new) or `--resume` (existing). Handles session reset (`/new`), resume failure detection, transcript creation | agent-process, transcript, types, logger |
| [subagent-manager.ts](src/agents/subagent-manager.ts) | 289 | Ephemeral subagent spawning, tracking, and garbage collection. Resolves templates, builds MCP configs, emits lifecycle hooks (subagent:spawning/completed/failed). Background timer prunes completed results after 1 hour | subagent-process, agent-process (McpConfigMap), config, context-assembler, transcript, hooks, types, logger |
| [cron-runner.ts](src/scheduling/cron-runner.ts) | 138 | Cron job execution engine. Two modes: `runIsolated()` spawns a fresh SubagentProcess (with ephemeral context — no MEMORY.md/USER.md), `getOrSpawnNamedSession()` delegates to ConversationManager for persistent sessions. Owns transcript creation for cron runs | subagent-process, agent-process (McpConfigMap), context-assembler, conversation-manager, transcript, types, logger |
| [agent-process.ts](src/agents/agent-process.ts) | 410 | Single persistent Claude CLI process. Spawn with `stream-json`, parse events, send messages, manage state, crash recovery, MCP config file lifecycle. Session-aware: `--session-id` for new sessions, `--resume` for crash recovery. Passes `--add-dir` for per-agent and framework skill discovery. Transcript capture: appends all stream-json events to JSONL | types, transcript, logger |
| [subagent-process.ts](src/agents/subagent-process.ts) | 310 | Ephemeral Claude CLI process for task execution. Single task in, result out, exit. Timeout, MCP config, structured result parsing. Passes `--add-dir` for framework skill discovery. Transcript capture: appends all stream-json events to JSONL | types, transcript, agent-process (McpConfigMap type), logger |
| [transcript.ts](src/shared/transcript.ts) | 58 | Append-only JSONL transcript writer. Creates transcript files, appends entries. Fire-and-forget writes that never block the agent | logger |
| [router.ts](src/routing/router.ts) | 235 | Inbound message routing: account -> agent resolution, message queuing per conversation, system commands, response dispatch back to Telegram | agent-manager, agent-process, channel, types, logger |
| [bridge.ts](src/bridge/bridge.ts) | 640 | Internal HTTP server (localhost, random port). Exposes Rondel core state + subagent lifecycle + agent memory + org endpoints (`GET /orgs`, `GET /orgs/:name`, `POST /admin/orgs`) + admin endpoints (add/update/delete agent, reload, set env, system status) to MCP server processes. Hot-add agents auto-detect parent org. Path traversal guard on locations. Async-safe readBody | http (node built-in), agent-manager, atomic-file, config, scaffold, logger |
| [mcp-server.ts](src/bridge/mcp-server.ts) | 700 | Standalone MCP server process. Exposes Telegram tools + bridge query tools + subagent tools + memory tools + org tools (`rondel_list_orgs`, `rondel_org_details` — all agents) + system status (all agents) + admin tools (gated by `RONDEL_AGENT_ADMIN`: add_agent with `org` param, create_org, update_agent, delete_agent, reload, set_env). Calls Telegram API directly and Rondel bridge via HTTP | `@modelcontextprotocol/sdk`, zod |
| [scheduler.ts](src/scheduling/scheduler.ts) | 581 | Timer-driven cron job runner. Reads `crons` from agent configs, manages timers, delegates execution to CronRunner (isolated) or CronRunner + ConversationManager (named sessions), delivers results via Telegram or log. State persistence, backoff, missed job recovery | agent-manager, cron-runner, telegram, hooks, types, logger |
| [atomic-file.ts](src/shared/atomic-file.ts) | 36 | Atomic file write utility. Write-to-temp + rename pattern for state files (sessions.json, cron-state.json, lockfile). Prevents data corruption on crash mid-write | (none) |
| [instance-lock.ts](src/system/instance-lock.ts) | 115 | Singleton instance guard. PID lockfile at `~/.rondel/state/rondel.lock` prevents two Rondel instances. Stale lock detection via PID liveness check. Records bridge URL and log path. Exports `readInstanceLock()` for CLI commands and `LockData` interface | atomic-file, logger |
| [service.ts](src/system/service.ts) | 250 | Platform-aware OS service management. `getServiceBackend()` returns launchd (macOS) or systemd (Linux) backend. Handles install, uninstall, stop, status. Generates plist/unit files with correct PATH (including claude CLI location), env vars, log redirection. `buildServiceConfig()` resolves all paths from current environment | config |
| [logger.ts](src/shared/logger.ts) | 95 | Dual-transport logger. Console output with ANSI colors (TTY only) + file output via `initLogFile()` (daemon mode). Simple size-based log rotation (10MB → .log.1). `[LEVEL] [component]` prefix, hierarchical via `.child()` | (none) |

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
  ├── agent-manager.ts (facade)
  │     ├── conversation-manager.ts ──── atomic-file.ts, agent-process.ts, transcript.ts, types.ts
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
  ├── bridge.ts ──── agent-manager.ts, logger.ts
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

1. `TelegramAccount.pollLoop()` calls `getUpdates()` with long-polling ([telegram.ts:59](src/channels/telegram.ts#L59))
2. Each update is filtered by `allowedUsers` set ([telegram.ts:113](src/channels/telegram.ts#L113))
3. Valid messages are normalized to `ChannelMessage` and dispatched to handlers ([telegram.ts:118](src/channels/telegram.ts#L118))
4. `Router.handleInboundMessage()` receives it ([router.ts:85](src/routing/router.ts#L85))
5. `agentManager.resolveAgentByAccount(accountId)` maps bot -> agent name ([agent-manager.ts:90](src/agents/agent-manager.ts#L90))
6. System commands (`/status`, `/restart`, `/cancel`, `/help`, `/start`) are intercepted and handled by the Router, not forwarded to the agent ([router.ts:95](src/routing/router.ts#L95))
7. `agentManager.getOrSpawnConversation(agentName, chatId)` returns existing process or spawns new ([agent-manager.ts:104](src/agents/agent-manager.ts#L104))
8. If agent is idle: `process.sendMessage(text)` writes JSON to Claude's stdin ([agent-process.ts:127](src/agents/agent-process.ts#L127))
9. If agent is busy: message is pushed to per-conversation queue ([router.ts:119](src/routing/router.ts#L119))
10. Claude responds via stdout. `handleStdoutLine()` parses newline-delimited JSON ([agent-process.ts:169](src/agents/agent-process.ts#L169))
11. `assistant` events buffer text blocks. `result` event flushes buffer and emits `"response"` ([agent-process.ts:203](src/agents/agent-process.ts#L203))
12. Router's wired handler sends response text back via `telegram.sendText(accountId, chatId, text)` ([router.ts:59](src/routing/router.ts#L59))
13. On state change to `idle`, queue is drained — next queued message is sent to the process ([router.ts:67](src/routing/router.ts#L67))

### Outbound: Agent-initiated message via MCP tool

1. Agent decides to call `rondel_send_telegram` tool during its turn
2. Claude CLI spawns the MCP server process (via `--mcp-config` temp file) and calls the tool over stdio
3. `mcp-server.ts` receives the tool call with `chat_id` and `text` params ([mcp-server.ts:114](src/bridge/mcp-server.ts#L114))
4. `sendTelegramText()` calls Telegram Bot API directly using `RONDEL_BOT_TOKEN` from env ([mcp-server.ts:39](src/bridge/mcp-server.ts#L39))
5. Message appears in Telegram without any Rondel core involvement
6. Tool result is returned to Claude, which continues its turn

---

## 4. Process Model

### Per-conversation, not per-agent

Agent config is a **template** — identity, model, tools, bot token. No processes exist at startup. Each unique `(agentName, chatId)` pair gets its own Claude CLI process ([agent-manager.ts:104](src/agents/agent-manager.ts#L104)). Three users messaging the same bot = three independent Claude instances with isolated sessions.

Conversation key: `"${agentName}:${chatId}"` ([agent-manager.ts:183](src/agents/agent-manager.ts#L183))

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
  --add-dir <framework-skills-dir>     # framework skill discovery
```

Built at [agent-process.ts:57](src/agents/agent-process.ts#L57). Working directory set from `agentConfig.workingDirectory` if non-null.

### Framework-disallowed tools

Rondel always adds certain built-in Claude CLI tools to `--disallowedTools` because it supersedes them with managed MCP equivalents. These are merged with any user-configured disallowed tools from `agent.json`.

| Built-in tool | Rondel replacement | Why |
|--------------|---------------------|-----|
| `Agent` | `rondel_spawn_subagent` | Rondel owns delegation — it needs to track, kill, and budget subagent lifecycles. The built-in Agent tool is a black box. |

Defined in `FRAMEWORK_DISALLOWED_TOOLS` at [agent-process.ts:24](src/agents/agent-process.ts#L24). This is a framework invariant, not a per-agent config choice.

### State machine

```
stopped → starting → idle ⇄ busy
                       ↓       ↓
                    crashed → (auto-restart after 5s) → starting
                       ↓
                    halted  (after 5 crashes/day — manual /restart required)
```

States defined as: `"starting" | "idle" | "busy" | "crashed" | "halted" | "stopped"` ([types.ts:78](src/shared/types.ts#L78))

### Block streaming

Text blocks are emitted immediately as they arrive in `assistant` events — not buffered until turn end. Each text block fires a `response` event, which the Router sends to Telegram. The user sees intermediate messages (e.g., "Creating the agent now...") while tools run, then the result after.

### Session resilience

New session entries only persist to `sessions.json` after Claude CLI confirms via the `sessionEstablished` event. This prevents stale entries from processes that crash before the first turn. Resume failure detection catches stale sessions within 10 seconds (regardless of exit code — Claude CLI exits 0 even on errors) and falls back to a fresh session.

### Crash recovery

On process exit ([agent-process.ts:221](src/agents/agent-process.ts#L221)):
- Daily crash counter resets at midnight
- If < 5 crashes today: wait with escalating backoff (5s → 15s → 30s → 60s → 2m), auto-restart
- If >= 5: set state to `"halted"`, notify user via Telegram, stop restarting
- Router notifies the chat on crash/halt ([router.ts:77](src/routing/router.ts#L77))
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

Typed EventEmitter for cross-cutting concerns ([hooks.ts](src/shared/hooks.ts)). Modules emit events when significant things happen; other modules subscribe to react. The emitter doesn't know what the listeners do — this keeps concerns decoupled.

Created once in `index.ts`, injected into `AgentManager` via constructor.

| Hook | Fired by | When | Default listeners |
|------|----------|------|-------------------|
| `subagent:spawning` | AgentManager | Before subagent process starts | Send Telegram notification to user |
| `subagent:completed` | AgentManager | Subagent finished successfully | Deliver result to parent agent as message + Telegram notification |
| `subagent:failed` | AgentManager | Subagent errored/timed out/killed | Inform parent agent + Telegram notification |
| `cron:completed` | Scheduler | Cron job finished successfully | Log completion |
| `cron:failed` | Scheduler | Cron job errored/timed out | Log failure + Telegram notification if announce delivery configured |

Listeners are wired in [index.ts](src/index.ts). The `subagent:completed` listener delivers the result to the parent agent by calling `sendMessage()` on the parent's conversation process — this triggers a new turn where the parent summarizes the findings for the user.

---

## 6. Scheduler (Cron Jobs)

Timer-driven job runner ([scheduler.ts](src/scheduling/scheduler.ts)). Reads `crons` from agent configs, manages timers, executes jobs, and delivers results. Follows OpenClaw's three-way separation: where it runs (session target) / what it does (payload) / where output goes (delivery).

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

`AgentManager.getOrSpawnConversation()` builds the MCP config map ([agent-manager.ts:114](src/agents/agent-manager.ts#L114)):

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

`AgentProcess.writeMcpConfigFile()` writes `{ mcpServers: { ... } }` to a temp file in `$TMPDIR/rondel-mcp/` ([agent-process.ts:253](src/agents/agent-process.ts#L253)). The path is passed to Claude via `--mcp-config`. File is cleaned up on `stop()` ([agent-process.ts:273](src/agents/agent-process.ts#L273)).

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
| `rondel_memory_read` | (none) | Read current agent's MEMORY.md content | Bridge → filesystem |
| `rondel_memory_save` | `content: string` | Overwrite agent's MEMORY.md (atomic write) | Bridge → filesystem |
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

### Transport

- Node `http` server on `127.0.0.1` with OS-assigned random port ([bridge.ts:38](src/bridge/bridge.ts#L38))
- MCP server receives the URL via `RONDEL_BRIDGE_URL` env var
- Localhost-only, no authentication — same-machine, same-user IPC
- Started before channel adapters at boot ([index.ts:21](src/index.ts#L21))

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
| **Admin** | | |
| `GET` | `/admin/status` | System status: uptime, agent count, per-agent model/admin/conversations |
| `POST` | `/admin/agents` | Create + register + start a new agent (scaffold + hot-add) |
| `PATCH` | `/admin/agents/:name` | Update agent config fields (model, enabled, admin) |
| `POST` | `/admin/reload` | Re-discover agents from workspaces, register new, refresh existing |
| `DELETE` | `/admin/agents/:name` | Unregister agent, stop polling, kill conversations, delete directory |
| `PUT` | `/admin/env` | Set env var in .env + process.env |

### Request flow

```
Agent decides to call rondel_list_agents
  ↓
Claude CLI calls MCP server tool via stdio
  ↓
mcp-server.ts bridgeCall("/agents")
  ↓ HTTP GET
bridge.ts handleListAgents()
  ↓ method call
agentManager.getAgentNames() + getConversationsForAgent()
  ↓
JSON response back through the chain
  ↓
Agent receives tool result and continues its turn
```

---

## 9. Channel Adapter Pattern

### Interface ([channel.ts:23](src/channels/channel.ts#L23))

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

### TelegramAdapter implementation ([telegram.ts:155](src/channels/telegram.ts#L155))

- One `TelegramAdapter` instance manages N `TelegramAccount` objects (one per bot)
- Each account polls independently via `getUpdates()` with 30s long-poll timeout
- `allowedUsers` set is shared across all accounts (from `~/.rondel/config.json`)
- Outbound: Markdown formatting with automatic plain-text fallback on parse failure ([telegram.ts:137](src/channels/telegram.ts#L137))
- Message chunking at 4096 chars, breaking at newlines or spaces ([telegram.ts:226](src/channels/telegram.ts#L226))

### Multi-account model

Bot token = routing. Each agent gets its own Telegram bot. `accountId` is the agent name. `AgentManager` maintains bidirectional maps: `accountToAgent` and `agentToAccount` ([agent-manager.ts:44](src/agents/agent-manager.ts#L44)). No chat ID configuration needed — message a bot, you're talking to that agent.

---

## 10. Config & Context

### Config loading ([config.ts:24](src/config/config.ts#L24))

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

All `${VAR_NAME}` patterns in JSON config files are replaced with `process.env` values before parsing. Missing variables throw ([config.ts:9](src/config/config.ts#L9)).

### Context assembly ([context-assembler.ts](src/config/context-assembler.ts))

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

### Startup sequence ([index.ts:19](src/index.ts#L19))

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

---

## 12. Daemon & OS Service

### Two-tier process management

Rondel has two run modes across macOS, Linux, and Windows:

**Development** (`npm start`)
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
