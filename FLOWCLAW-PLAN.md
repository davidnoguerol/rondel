# FlowClaw — Implementation Plan

> A lean, extensible multi-agent orchestration framework built on the `claude` CLI, with Telegram as the primary UI.

---

## 1. What FlowClaw Is

FlowClaw is a **framework for building multi-agent systems** powered by Claude Code CLI. It is not a pre-built agent team — it is scaffolding. Users define their own orchestrator and worker agents, configure their identities and skills, and FlowClaw handles the lifecycle, communication, and messaging integration.

Think of it as: **OpenClaw's architectural patterns (openclaw-architecture.md) + CRM's (claude-code-manager.md) simplicity + proper Node.js process management**.

### Core Principles

- **Framework, not product**: FlowClaw provides the engine. Users define the agents.
- **File-based state, no database**: All persistence via JSON/JSONL files. Debuggable, portable, git-friendly.
- **Plugin-ready from day 1**: Channel adapters, agent backends, and tools are interfaces — even if the MVP only ships Telegram.
- **Convention over configuration**: Drop files in the right folder structure and FlowClaw discovers them.
- **Cross-platform**: Windows, Linux, macOS. No tmux dependency.
- **Progressive complexity**: Start flat with just `agents/`. Add organizations when you need isolation and shared context. The org layer is entirely optional.
- **Multi-org isolation**: When orgs are used, run agents across multiple companies/projects with shared and isolated context.

---

## 2. Architecture Overview

### System Diagram

```
FlowClaw Core (Node.js — always running)
|
|-- Channel Manager
|   |-- Telegram Bot (single or multiple bots)
|   |-- (future: Slack, WhatsApp, Web UI)
|
|-- Agent Manager
|   |                                          -- With orgs: --
|   |-- Org: Company A (optional grouping)
|   |   |-- dev-lead      (top-level, persistent, stream-json)
|   |   |-- content-writer (top-level, persistent, stream-json)
|   |   +-- ops            (top-level, persistent, stream-json)
|   |
|   |-- Org: Company B (optional grouping)
|   |   +-- dev-lead       (top-level, persistent, stream-json)
|   |
|   |                                          -- Or flat: --
|   +-- Standalone agents (no org required)
|       |-- dev-lead       (top-level, persistent, stream-json)
|       |-- researcher     (top-level, persistent, stream-json)
|       +-- personal-asst  (top-level, persistent, stream-json)
|
|-- Message Router
|   Binding rules map channels/users/commands to agents
|
|-- Process Manager
|   stream-json bidirectional pipes to persistent claude CLI processes
|   (one process per top-level agent)
|
|-- Inter-Agent Message Bus
|   File-based: inbox/ -> inflight/ -> processed/
|   Org isolation enforced at the bus level
|
|-- Scheduler
|   Cron jobs, health checks, session refresh
|
+-- State Store
    Sessions, config, logs — all file-based under ~/.flowclaw/
```

### Context Model (Two or Three Layers — Your Choice)

FlowClaw uses a composable context hierarchy. The organization layer is **entirely optional** — if you don't use orgs, context composition is simply Global + Agent. If you do, it's Global + Org + Agent.

**Flat structure (no orgs):**
```
Effective system prompt = global/CONTEXT.md + agents/{name}/SYSTEM.md
```

**With organizations:**
```
Effective system prompt = global/CONTEXT.md + orgs/{org}/CONTEXT.md + agents/{name}/SYSTEM.md
```

Detailed view:

```
+---------------------------------------------+
|  Layer 1: GLOBAL (always)                   |
|  global/CONTEXT.md                          |
|  Your personal preferences, cross-cutting   |
|  knowledge, shared conventions              |
+---------------------------------------------+
           |
           v
+---------------------------------------------+
|  Layer 2: ORGANIZATION (optional)           |
|  orgs/company-a/CONTEXT.md                  |
|  Company-specific: brand, repos, domain     |
|  knowledge, credentials, team structure     |
+---------------------------------------------+
           |
           v
+---------------------------------------------+
|  Layer 3: AGENT (always)                    |
|  agents/{name}/SYSTEM.md          — OR —    |
|  orgs/{org}/agents/{name}/SYSTEM.md         |
|  Individual identity, skills, delegation    |
|  rules, specific instructions               |
+---------------------------------------------+
```

This means a solo user who just wants three agents can have a project that looks like:

```
my-flowclaw/
├── flowclaw.config.json
├── global/
│   └── CONTEXT.md
├── agents/
│   ├── assistant/
│   ├── coder/
│   └── researcher/
└── skills/
```

No `orgs/` directory at all. When they later need to separate things into companies or projects, they create `orgs/` and move agents in — or keep a hybrid with some standalone and some org-grouped.

### Agent Hierarchy

**Top-level agents** are persistent Claude processes with their own identity (system prompt, skills, config). Any top-level agent can be connected to one or more messaging channels (Telegram, future Slack, etc.). Any top-level agent can function as an orchestrator, a specialist, or a standalone worker — FlowClaw doesn't prescribe roles. You can have multiple orchestrators across different organizations, or even within the same org.

**Subagents** are ephemeral Claude processes spawned by any top-level agent to execute a specific task. They run in a configurable directory (e.g., a project folder), complete their task, report back to the parent, and exit. Subagents don't have their own messaging channels — they communicate only with their parent.

**Organizations** are an **optional** grouping and context-sharing layer above agents. When used, agents within an org share context (CONTEXT.md) and can communicate freely with each other. Cross-org communication is disabled by default but can be explicitly allowed in config. If you don't need orgs, just put all agents in the root `agents/` directory — the framework works identically, minus the org context layer.

```
User (Telegram Bot A) --> Company A / Dev Lead (top-level, persistent)
                              |
                              |-- Coder Subagent (ephemeral, in /projects/company-a/app)
                              +-- Reviewer Subagent (ephemeral, in /projects/company-a/app)

User (Telegram Bot A) --> Company A / Content Writer (top-level, persistent)
                              |
                              +-- Researcher Subagent (ephemeral, in /docs/company-a)

User (Telegram Bot B) --> Company B / Dev Lead (top-level, persistent)
                              |
                              +-- Coder Subagent (ephemeral, in /projects/company-b/api)

User (Telegram Bot A) --> Personal Assistant (standalone, no org, persistent)
```

Delegation strategy is **prompt-driven**: the framework provides spawn/message/kill tools to agents. Each agent's system prompt decides when and how to use them. Users can override with explicit commands (e.g., `/ask coder fix the login bug`). The framework also supports a "propose before delegating" mode where agents ask for confirmation before spawning subagents.

### Organization Isolation

By default, agents can only communicate within their own organization:

```json
{
  "crossOrgCommunication": {
    "enabled": false,
    "allowedPairs": [
      { "from": "company-a", "to": "company-b", "agents": ["dev-lead"] }
    ]
  }
}
```

When `enabled: false` (default), agents in Company A cannot see or message agents in Company B. The `allowedPairs` list creates explicit exceptions. Standalone agents (no org) can communicate with any agent by default (configurable).

---

## 3. Process Management — stream-json Bidirectional Pipes

Each top-level agent is a persistent `claude` CLI process spawned via Node.js `child_process.spawn()` with bidirectional JSON communication.

### Spawn Command

```bash
claude -p \
  --input-format stream-json \
  --output-format stream-json \
  --verbose \
  --dangerously-skip-permissions \
  --model <model> \
  --system-prompt "<global + org + agent context>" \
  --allowedTools "<tool list>" \
  --mcp-config '<flowclaw mcp server config>'
```

The `--system-prompt` is assembled by concatenating: `global/CONTEXT.md` + `orgs/{org}/CONTEXT.md` + `orgs/{org}/agents/{name}/SYSTEM.md`. For standalone agents: `global/CONTEXT.md` + `agents/{name}/SYSTEM.md`.

### Message Protocol

**Sending messages to Claude** (write to stdin):
```json
{
  "type": "user",
  "session_id": "",
  "message": {
    "role": "user",
    "content": "User's message here"
  },
  "parent_tool_use_id": null
}
```

- `session_id`: empty for new session, or set to resume an existing one
- `parent_tool_use_id`: used to route messages to a specific sub-agent/task context

**Receiving from Claude** (read from stdout, newline-delimited JSON):
```json
{"type": "system", "subtype": "init", "session_id": "...", "tools": [...], ...}
{"type": "assistant", "message": {"content": [{"type": "text", "text": "..."}]}, ...}
{"type": "result", "result": "...", "session_id": "...", "total_cost_usd": 0.01, ...}
```

### Process Lifecycle

```
FlowClaw starts
  |
  |-- Read flowclaw.config.json
  |-- Read global/CONTEXT.md
  |-- For each org in orgs/:
  |   |-- Read orgs/{org}/org.json
  |   |-- Read orgs/{org}/CONTEXT.md
  |   |-- For each agent in orgs/{org}/agents/:
  |   |   |-- Read agent.json + SYSTEM.md
  |   |   |-- Assemble system prompt (global + org + agent)
  |   |   |-- Spawn claude process with stream-json flags
  |   |   |-- Wait for "system:init" event
  |   |   |-- Register in AgentManager
  |   |   +-- Start health monitor
  |   +--
  |
  |-- For each standalone agent in agents/:
  |   (same as above, but with global + agent context only)
  |
  |-- Start ChannelManager (connect Telegram bots)
  |-- Start Scheduler (cron jobs)
  |-- Start MessageRouter (bind channels -> agents)
  +-- Enter main event loop
```

### Crash Recovery

```
Agent process exits unexpectedly
  |
  |-- Log crash event (org, agent, exit code, signal, stderr)
  |-- Increment crash counter for today
  |-- If crash count >= MAX_CRASHES_PER_DAY (default 5):
  |   |-- Alert via Telegram: "Agent {org}/{name} halted after {n} crashes"
  |   |-- Set agent state to "halted"
  |   +-- Do not restart
  |
  |-- If rate limit detected in stderr:
  |   |-- Calculate exponential backoff (5min, 10min, 15min, 20min max)
  |   +-- Schedule restart after backoff
  |
  +-- Otherwise:
      |-- Wait 5 seconds
      +-- Respawn with session continuity
```

### Subagent Spawning

Subagents use `-p` mode (not stream-json) since they're ephemeral:

```bash
claude -p \
  --output-format json \
  --dangerously-skip-permissions \
  --system-prompt "<subagent prompt>" \
  --session-id "<generated-uuid>" \
  "Execute task: <task description>"
```

For multi-turn subagent tasks, subsequent turns use `--resume <session-id>`.

The parent agent spawns subagents via a custom tool registered in its toolset (see §6).

---

## 4. Directory Structure

### Flat Layout (no orgs — simplest setup)

```
my-flowclaw/
├── flowclaw.config.json              # Global configuration
├── global/
│   └── CONTEXT.md                    # Global context (your preferences, shared knowledge)
├── agents/                           # All agents live here
│   ├── dev-lead/
│   │   ├── agent.json                # Agent config (model, permissions, tools, crons)
│   │   ├── SYSTEM.md                 # Agent identity and instructions
│   │   └── skills/                   # Agent-specific skills
│   ├── content-writer/
│   │   ├── agent.json
│   │   └── SYSTEM.md
│   └── personal-assistant/
│       ├── agent.json
│       └── SYSTEM.md
├── templates/                        # Subagent templates
├── skills/                           # Shared skills (available to all agents)
└── package.json                      # FlowClaw as dependency
```

Context: `global/CONTEXT.md` + `agents/{name}/SYSTEM.md`. Agent IDs: `dev-lead`, `content-writer`, etc. No org prefix, no isolation logic. All agents can communicate freely.

### Multi-Org Layout (when you need separation)

```
my-flowclaw/
├── flowclaw.config.json              # Global configuration
├── global/
│   └── CONTEXT.md                    # Global context (your preferences, cross-org knowledge)
├── orgs/
│   ├── company-a/
│   │   ├── org.json                  # Org config (shared telegram, defaults)
│   │   ├── CONTEXT.md               # Org context (brand, repos, domain knowledge)
│   │   ├── skills/                   # Org-wide shared skills
│   │   │   └── brand-voice/SKILL.md
│   │   └── agents/
│   │       ├── dev-lead/
│   │       │   ├── agent.json        # Agent config (model, permissions, tools, crons)
│   │       │   ├── SYSTEM.md         # Agent identity and instructions
│   │       │   └── skills/           # Agent-specific skills
│   │       ├── content-writer/
│   │       │   ├── agent.json
│   │       │   └── SYSTEM.md
│   │       └── ops/
│   │           ├── agent.json
│   │           └── SYSTEM.md
│   └── company-b/
│       ├── org.json
│       ├── CONTEXT.md
│       └── agents/
│           └── dev-lead/
│               ├── agent.json
│               └── SYSTEM.md
├── agents/                           # Standalone agents (not in any org)
│   └── personal-assistant/
│       ├── agent.json
│       └── SYSTEM.md
├── templates/                        # Subagent templates
│   ├── coder/
│   │   ├── agent.json
│   │   └── SYSTEM.md
│   └── researcher/
│       ├── agent.json
│       └── SYSTEM.md
├── skills/                           # Shared skills (available to all agents)
│   └── comms/SKILL.md
└── package.json                      # FlowClaw as dependency
```

Context: `global/CONTEXT.md` + `orgs/{org}/CONTEXT.md` + `agents/{name}/SYSTEM.md`. Agent IDs: `company-a/dev-lead`, etc. Org isolation enforced. The root `agents/` directory still works for standalone agents outside any org.

**You can mix both**: some agents in `orgs/`, some standalone in `agents/`. The framework discovers both and handles context composition accordingly.

### Runtime State (auto-managed by FlowClaw)

```
~/.flowclaw/{project-id}/
|-- state/
|   |-- agents.json                   # Agent statuses (running, halted, disabled)
|   |-- crash-counts.json             # Per-agent daily crash counters
|   +-- telegram-offsets.json         # Telegram polling offsets per bot
|-- sessions/
|   +-- {org}/{agent}/                # Claude session files (auto-managed by CLI)
|-- inbox/
|   +-- {org}/{agent}/                # Incoming inter-agent messages
|-- inflight/
|   +-- {org}/{agent}/                # Messages being processed
|-- processed/
|   +-- {org}/{agent}/                # Acknowledged messages
|-- logs/
|   +-- {org}/{agent}/
|       |-- activity.log              # Session starts, ends, events
|       |-- crashes.log               # Crash events
|       |-- turns.jsonl               # Per-turn structured logs (cost, duration, tools)
|       +-- stderr.log                # Claude process stderr
+-- pid                               # FlowClaw process PID file
```

For standalone agents, `{org}` is replaced with `_standalone`.

---

## 5. Configuration

### flowclaw.config.json (Global)

```json
{
  "projectId": "my-setup",
  "defaultModel": "sonnet",
  "defaultPermissionMode": "bypassPermissions",

  "telegram": {
    "bots": {
      "main": {
        "botToken": "${FLOWCLAW_TELEGRAM_BOT_TOKEN}",
        "allowedUsers": ["${FLOWCLAW_TELEGRAM_USER_ID}"]
      },
      "company-b": {
        "botToken": "${COMPANY_B_BOT_TOKEN}",
        "allowedUsers": ["${FLOWCLAW_TELEGRAM_USER_ID}"]
      }
    }
  },

  "bindings": [
    {
      "match": { "channel": "telegram", "bot": "main", "command": "/companya" },
      "agentId": "company-a/dev-lead"
    },
    {
      "match": { "channel": "telegram", "bot": "main", "chatType": "private" },
      "agentId": "_standalone/personal-assistant"
    },
    {
      "match": { "channel": "telegram", "bot": "company-b" },
      "agentId": "company-b/dev-lead"
    }
  ],

  "crossOrgCommunication": {
    "enabled": false,
    "allowedPairs": []
  },

  "scheduler": {
    "healthCheckInterval": "30s",
    "sessionRefreshInterval": "71h"
  },

  "logging": {
    "level": "info",
    "file": true
  }
}
```

Agent IDs use the format `{org}/{agent-name}` for org agents and `_standalone/{agent-name}` for standalone agents.

Environment variable substitution (`${VAR}`) is supported throughout the config. Secrets never go in config files directly.

### orgs/{name}/org.json

```json
{
  "orgName": "Company A",
  "orgId": "company-a",
  "defaultModel": "sonnet",
  "defaultWorkingDirectory": "/projects/company-a",
  "telegram": {
    "bot": "main",
    "chatId": "${COMPANY_A_CHAT_ID}"
  }
}
```

Org-level defaults are inherited by all agents within the org unless overridden in agent.json.

### orgs/{org}/agents/{name}/agent.json

```json
{
  "agentName": "dev-lead",
  "enabled": true,
  "model": "sonnet",
  "permissionMode": "bypassPermissions",
  "maxTurnTimeout": 300,
  "startupDelay": 0,

  "workingDirectory": "/projects/company-a/main-app",

  "telegram": {
    "bot": "main",
    "chatId": "${COMPANY_A_CHAT_ID}"
  },

  "tools": {
    "allowed": ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebSearch", "WebFetch"],
    "disallowed": []
  },

  "subagentTemplates": ["coder", "researcher", "reviewer"],

  "crons": [
    { "name": "inbox-check", "interval": "5m", "prompt": "Check your inbox for new messages from other agents" },
    { "name": "daily-summary", "interval": "24h", "prompt": "Send a daily summary to Telegram" }
  ]
}
```

### System Prompt Assembly

The agent's effective system prompt is assembled by FlowClaw at spawn time:

```
[Contents of global/CONTEXT.md]

---

[Contents of orgs/company-a/CONTEXT.md]

---

[Contents of orgs/company-a/agents/dev-lead/SYSTEM.md]
```

For standalone agents, the org layer is skipped. Skills from all three levels (global, org, agent) are also made available.

---

## 6. Tool System

FlowClaw injects custom tools into each agent's toolset via MCP servers. These tools are how agents interact with FlowClaw's infrastructure.

### 6.1 Telegram Tools (injected into agents with Telegram bindings)

```
flowclaw_send_telegram(chat_id, text, keyboard?)
  -> Send a message to Telegram. Optional inline keyboard for buttons.

flowclaw_send_telegram_photo(chat_id, image_path, caption?)
  -> Send a photo to Telegram.

flowclaw_edit_telegram(chat_id, message_id, text, keyboard?)
  -> Edit an existing Telegram message.
```

### 6.2 Agent Coordination Tools (injected into all agents)

```
flowclaw_spawn_subagent(template, working_directory, task, options?)
  -> Spawn an ephemeral subagent from a template.
  -> Options: model, timeout, allowed_tools
  -> Returns: { subagent_id, session_id }

flowclaw_subagent_status(subagent_id)
  -> Check if a subagent is still running, get progress.
  -> Returns: { status: "running"|"completed"|"failed", result?, elapsed_ms }

flowclaw_kill_subagent(subagent_id)
  -> Kill a running subagent.

flowclaw_message_agent(to_agent_id, message, priority?, reply_to?)
  -> Send a message to another top-level agent's inbox.
  -> to_agent_id format: "company-a/content-writer" or "_standalone/personal-asst"
  -> Priority: urgent, high, normal, low
  -> Org isolation enforced: will reject cross-org messages unless explicitly allowed

flowclaw_check_inbox()
  -> Check for new messages from other agents.
  -> Returns: array of { from, message, priority, timestamp, id }

flowclaw_ack_message(message_id)
  -> Acknowledge a processed inbox message.
```

### 6.3 System Tools (injected into all agents)

```
flowclaw_get_config()
  -> Read the current agent's config and FlowClaw state.

flowclaw_list_agents(scope?)
  -> List agents and their statuses.
  -> scope: "org" (same org only, default), "all" (if cross-org allowed)

flowclaw_log(level, message)
  -> Write to the agent's activity log.
```

### Implementation: MCP Server

These tools are implemented as a FlowClaw-internal MCP server that's automatically connected to each agent process:

```bash
claude -p \
  --mcp-config '{"flowclaw": {"command": "node", "args": ["mcp-server.js"], "env": {"AGENT_ID": "company-a/dev-lead", "ORG_ID": "company-a"}}}' \
  ...
```

The MCP server runs as a child process of the FlowClaw core, shares state via the file-based message bus, and has direct access to the Telegram API and agent manager. The `ORG_ID` env var allows the MCP server to enforce org isolation on message routing.

---

## 7. Channel System

### 7.1 Channel Interface

```typescript
interface ChannelAdapter {
  id: string;                          // "telegram", "slack", etc.

  // Lifecycle
  connect(config: ChannelConfig): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;

  // Inbound
  onMessage(handler: (msg: InboundMessage) => void): void;
  onCallback(handler: (cb: CallbackQuery) => void): void;

  // Outbound
  sendText(chatId: string, text: string, options?: SendOptions): Promise<SentMessage>;
  sendPhoto(chatId: string, path: string, caption?: string): Promise<SentMessage>;
  editMessage(chatId: string, messageId: string, text: string, options?: SendOptions): Promise<void>;
  answerCallback(callbackId: string, text?: string): Promise<void>;

  // Registration
  registerCommands(commands: BotCommand[]): Promise<void>;
}

type InboundMessage = {
  channelId: string;                   // "telegram"
  botId: string;                       // "main", "company-b"
  chatId: string;
  senderId: string;
  senderName: string;
  text: string;
  type: "text" | "photo" | "command" | "callback";
  mediaPath?: string;
  raw: unknown;                        // Platform-specific raw data
};
```

### 7.2 Telegram Adapter (MVP)

Uses Telegram Bot API with long-polling (webhook mode as future option). Supports multiple bots within one adapter instance.

Capabilities:
- Text messages with Markdown formatting
- Photo sending/receiving
- Inline keyboards (buttons) for approvals, confirmations, quick actions
- Callback query handling (button presses)
- Typing indicators ("Agent is working...")
- Command registration (autocomplete in Telegram)
- Multiple bots (one per org or shared)

Security:
- `allowedUsers` whitelist per bot config (numeric Telegram user IDs)
- All messages from non-allowed users are silently dropped
- Bot tokens stored in environment variables, never in config files

### 7.3 Message Routing

When an inbound message arrives from any channel:

```
Inbound message (from bot "main", user 12345, text "/companya deploy the app")
  |
  |-- Authenticate sender (allowedUsers check for this bot)
  |
  |-- Check for system commands (/status, /stop, /restart, /agents, /cancel)
  |   +-- Handle internally, don't route to agent
  |
  |-- Match against bindings (in order, first match wins):
  |   1. Bot + command binding (bot:main + /companya -> company-a/dev-lead)
  |   2. Bot + chat binding (bot:company-b + any -> company-b/dev-lead)
  |   3. Bot + chatType binding (bot:main + private -> _standalone/personal-assistant)
  |   4. Default agent fallback
  |
  +-- Deliver to matched agent:
      |-- If agent is idle -> send immediately via stream-json stdin
      |-- If agent is busy -> queue message, show "Queued" indicator
      +-- If agent is halted/crashed -> notify user, offer /restart
```

### 7.4 Telegram UX Details

**Normal conversation**: User sends text -> routed to agent -> agent responds via `flowclaw_send_telegram` -> user sees response.

**Approval flow**: Agent wants to do something sensitive -> sends Telegram message with inline keyboard [Approve] [Deny] -> user taps -> callback routed back to agent as a message.

**Status indicators**:
- Working message sent when agent starts processing
- Edited to done/failed when turn completes
- Queued messages show position in queue

**System commands** (handled by FlowClaw core, not agents):
- `/status` — Show all agents and their states (grouped by org)
- `/agents` — List configured agents across all orgs
- `/restart <agent-id>` — Restart an agent (e.g., `/restart company-a/dev-lead`)
- `/stop <agent-id>` — Stop an agent
- `/cancel` — Kill current agent turn, optionally with reason
- `/logs <agent-id>` — Show recent logs
- `/orgs` — List organizations and their agents

---

## 8. Inter-Agent Message Bus

File-based, same pattern as CRM but managed by Node.js instead of bash. Org isolation enforced at the bus level.

### Message Format

```json
{
  "id": "msg_1711234567890_company-a_dev-lead_a1b2c3",
  "from": "company-a/dev-lead",
  "to": "company-a/content-writer",
  "priority": "normal",
  "timestamp": "2026-03-27T12:00:00.000Z",
  "text": "Please write a blog post about our new feature",
  "replyTo": null,
  "metadata": {}
}
```

### File Naming

```
{priority_num}-{epoch_ms}-from-{org}-{sender}-{random6}.json
```

Priority mapping: urgent=0, high=1, normal=2, low=3. Files sort naturally by priority then time.

### Org Isolation Enforcement

When `flowclaw_message_agent` is called:
1. Extract sender's org from agent ID
2. Extract target's org from `to_agent_id`
3. If orgs differ and cross-org is disabled -> reject with clear error
4. If orgs differ but this specific pair is in `allowedPairs` -> allow
5. If same org or standalone -> allow

### Delivery Flow

```
Agent "company-a/dev-lead" calls flowclaw_message_agent("company-a/content-writer", "hello")
  |
  |-- Org isolation check: same org (company-a) -> allowed
  |
  |-- MCP server creates: ~/.flowclaw/{project}/inbox/company-a/content-writer/{filename}.json
  |   (atomic write: .tmp file, then rename)
  |
  |-- Content-writer's inbox poller detects new message (checks every 5s)
  |   |-- Moves file: inbox -> inflight
  |   +-- Injects message into content-writer's stdin via stream-json
  |
  |-- Content-writer processes and calls flowclaw_ack_message(msg_id)
  |   +-- Moves file: inflight -> processed
  |
  +-- Stale recovery: messages in inflight > 5 minutes -> moved back to inbox
```

---

## 9. Scheduler

Node-native scheduling (no `/loop` dependency).

```typescript
interface ScheduledJob {
  id: string;
  agentId: string;                    // "company-a/dev-lead"
  schedule: {
    type: "interval" | "cron" | "once";
    value: string;                    // "5m", "0 9 * * 1-5", ISO timestamp
  };
  prompt: string;                     // Injected as a user message to the agent
  enabled: boolean;
  lastRun?: string;
  nextRun?: string;
  consecutiveErrors: number;
}
```

Jobs are defined in `agent.json` under `crons` and materialized in memory by the Scheduler service. On trigger, the job's prompt is sent to the agent as a regular message via the stream-json pipe.

The scheduler also handles:
- **Health checks**: Periodic heartbeat to each agent (send a lightweight message, expect response within timeout)
- **Session refresh**: Every `sessionRefreshInterval` (default 71h), gracefully restart the agent to prevent session bloat
- **Inbox polling**: Check each agent's inbox for new inter-agent messages

---

## 10. CLI & Developer Experience

### Setup Flow

```bash
# 1. Create a new FlowClaw project
npx flowclaw init my-agents
cd my-agents

# 2. Add an organization
npx flowclaw add-org company-a
# -> Creates orgs/company-a/ with template org.json and CONTEXT.md

# 3. Add an agent to the org
npx flowclaw add-agent company-a/dev-lead
# -> Creates orgs/company-a/agents/dev-lead/ with template agent.json and SYSTEM.md
# -> Prompts for Telegram bot token (or reuse existing), chat ID, allowed user ID

# 4. Add a standalone agent (no org)
npx flowclaw add-agent personal-assistant --standalone
# -> Creates agents/personal-assistant/

# 5. Edit identities
# (User edits CONTEXT.md and SYSTEM.md files, agent.json configs)

# 6. Start FlowClaw
npx flowclaw start
# -> Reads config, assembles contexts, spawns agents, connects Telegram, starts scheduler

# 7. Run as a daemon (optional)
npx flowclaw daemon install   # Install as system service (launchd/systemd/schtasks)
npx flowclaw daemon start
```

### Other CLI Commands

```bash
flowclaw status                         # Show all orgs, agents, statuses
flowclaw status company-a               # Show agents in a specific org
flowclaw logs company-a/dev-lead        # View agent logs
flowclaw restart company-a/dev-lead     # Restart a specific agent
flowclaw stop [agent-id]                # Stop one or all agents
flowclaw config                         # Validate and display effective config
flowclaw doctor                         # Check dependencies (claude CLI, node, env vars)
```

---

## 11. Module Architecture (Node.js)

```
src/
|-- index.ts                          # Main entry point
|-- cli/                              # CLI commands
|   |-- init.ts                       # flowclaw init
|   |-- add-org.ts                    # flowclaw add-org
|   |-- add-agent.ts                  # flowclaw add-agent
|   |-- start.ts                      # flowclaw start
|   |-- status.ts                     # flowclaw status
|   +-- daemon.ts                     # flowclaw daemon
|-- core/
|   |-- config.ts                     # Config loading, validation, env substitution
|   |-- context-assembler.ts          # Three-layer context composition (global + org + agent)
|   |-- state.ts                      # Runtime state management
|   |-- logger.ts                     # Structured logging
|   +-- errors.ts                     # Error types
|-- agents/
|   |-- agent-manager.ts              # Agent registry, lifecycle orchestration (org-aware)
|   |-- agent-process.ts              # Single agent process (spawn, monitor, communicate)
|   |-- subagent-process.ts           # Ephemeral subagent process (-p mode)
|   |-- message-queue.ts              # Per-agent message queue (for when busy)
|   +-- turn-tracker.ts              # Track active turns, costs, durations
|-- orgs/
|   |-- org-manager.ts                # Organization discovery, config, isolation rules
|   +-- org-isolation.ts              # Cross-org communication enforcement
|-- channels/
|   |-- channel-manager.ts            # Channel lifecycle orchestration
|   |-- channel-adapter.ts            # Base adapter interface
|   +-- telegram/
|       |-- telegram-adapter.ts       # Telegram Bot API implementation (multi-bot)
|       |-- telegram-poller.ts        # Long-polling for updates
|       |-- telegram-sender.ts        # Message sending, editing, keyboards
|       +-- telegram-commands.ts      # Bot command registration
|-- routing/
|   |-- message-router.ts             # Inbound message -> agent routing
|   +-- bindings.ts                   # Binding rule matching (org-aware)
|-- bus/
|   |-- message-bus.ts                # Inter-agent message bus (org-isolation aware)
|   |-- inbox.ts                      # Inbox management (read, move, ack)
|   +-- outbox.ts                     # Message sending
|-- mcp/
|   |-- mcp-server.ts                 # FlowClaw MCP server (tools for agents)
|   |-- tools/
|   |   |-- telegram-tools.ts         # flowclaw_send_telegram, etc.
|   |   |-- agent-tools.ts            # flowclaw_spawn_subagent, etc.
|   |   +-- system-tools.ts           # flowclaw_get_config, etc.
|   +-- mcp-bridge.ts                 # Bridge between MCP server and FlowClaw core
|-- scheduler/
|   |-- scheduler.ts                  # Cron/interval job runner
|   |-- health-monitor.ts             # Agent health checks
|   +-- session-refresher.ts          # Periodic session refresh
+-- utils/
    |-- file-utils.ts                 # Atomic writes, file locking
    |-- process-utils.ts              # Process spawning helpers
    +-- telegram-utils.ts             # Telegram API helpers, chunking
```

---

## 12. MVP Scope — What Ships in v1

### Must Have (MVP)

| Feature | Description |
|---------|-------------|
| Agent spawning | Persistent top-level agents via stream-json pipes |
| Subagent spawning | Ephemeral subagents via -p mode |
| Organization layer | Orgs with shared context, agent grouping, isolation |
| Three-layer context | Global + Org + Agent context composition |
| Telegram integration | Long-polling, text/photo, inline keyboards, multi-bot |
| Inter-agent messaging | File-based inbox with priority, ACK, stale recovery, org isolation |
| Working directory override | Agents can run in specific project folders |
| Crash recovery | Auto-restart with daily limits and rate-limit detection |
| CLI tools | init, add-org, add-agent, start, stop, status, doctor |
| Config system | JSON config with env var substitution |
| MCP tool injection | FlowClaw tools available to all agents |
| Scheduler | Cron jobs, health checks, session refresh |
| Message routing | Binding rules: bot+command+chat -> agent (org-aware) |
| Message queue | Queue messages when agent is busy, deliver on idle |
| Turn management | /cancel, timeout, status indicators |

### v2 (Post-MVP)

| Feature | Description |
|---------|-------------|
| Slack adapter | Second channel adapter |
| Web UI | Dashboard for monitoring agents, viewing sessions, org overview |
| Memory system | Key-value store for persistent agent facts (per-org and per-agent) |
| Hot reload | Watch config files, apply changes without restart |
| WhatsApp adapter | Third channel adapter |
| YAML workflows | Declarative multi-agent pipeline definitions |
| Kanban integration | Agents watch columns, pick up tasks |
| Plugin system | Third-party channel/tool/middleware extensions |

---

## 13. Implementation Phases

### Phase 1: Foundation (Week 1)

**Goal**: A single agent running persistently, controllable via Telegram.

1. Project scaffolding (package.json, tsconfig, directory structure)
2. Config loader (JSON + env var substitution)
3. Context assembler (global + org + agent composition)
4. AgentProcess class (spawn claude with stream-json, stdin/stdout handling, event parsing)
5. TelegramAdapter (long-polling, send/receive text, inline keyboards, single bot)
6. Basic MessageRouter (single agent, direct routing)
7. CLI: `flowclaw init`, `flowclaw start`
8. Basic crash recovery (restart on exit, daily counter)

**Deliverable**: Send a Telegram message -> agent responds via Telegram.

### Phase 2: Multi-Agent + Orgs (Week 2)

**Goal**: Multiple agents across orgs with inter-agent communication.

1. OrgManager (org discovery, config inheritance, isolation rules)
2. AgentManager (multi-agent lifecycle, org-aware)
3. MessageBus (file-based inbox/inflight/processed, org isolation)
4. MCP server with agent coordination tools (spawn_subagent, message_agent, etc.)
5. SubagentProcess class (-p mode, session persistence)
6. Message queue (for busy agents)
7. Binding rules with org-aware routing, multi-bot support
8. CLI: `flowclaw add-org`, `flowclaw add-agent`, `flowclaw status`, `flowclaw restart`

**Deliverable**: Orchestrator in Org A delegates to subagent, reports result. Org B agents isolated.

### Phase 3: Robustness (Week 3)

**Goal**: Production-ready reliability.

1. Scheduler (cron jobs, health checks, session refresh)
2. Turn management (/cancel, timeout, status indicators)
3. Rate limit detection and exponential backoff
4. Structured logging (turns.jsonl with cost tracking per org)
5. Working directory override (agents in project folders)
6. Telegram command registration from skills
7. CLI: `flowclaw logs`, `flowclaw doctor`, `flowclaw daemon`
8. Cross-platform daemon support (launchd/systemd/schtasks)

**Deliverable**: System runs 24/7 as a daemon, recovers from crashes, tracks costs per org.

### Phase 4: Polish (Week 4)

**Goal**: Developer experience and documentation.

1. Agent templates (starter orchestrator, coder, researcher)
2. Org templates (dev team, content team)
3. Interactive setup wizard (`flowclaw init` with prompts)
4. Configuration validation with helpful error messages
5. README, quick-start guide, architecture docs
6. Example project (multi-org, multi-agent setup)
7. npm package publishing

**Deliverable**: Anyone can `npx flowclaw init` and have a working multi-agent system in 5 minutes.

---

## 14. Key Design Decisions & Rationale

### Why stream-json over tmux?

- Cross-platform (Windows, Linux, macOS) — tmux doesn't work on Windows
- Structured JSON I/O — no text scraping or regex parsing
- Clean process lifecycle — Node child_process API is battle-tested
- Lower maintenance — no tmux version issues, PTY bugs, or buffer limits
- The `--input-format stream-json` mode is the official Claude CLI mechanism for programmatic control

### Why file-based state over a database?

- Zero dependencies — no Postgres, Redis, or SQLite to install
- Debuggable — you can `cat` any state file
- Git-friendly — config and agent identities can be version controlled
- Proven pattern — both OpenClaw and CRM use file-based state successfully

### Why MCP for tool injection over --append-system-prompt?

- Structured tool definitions — MCP provides typed schemas, not just text instructions
- Separation of concerns — tools are executable code, not prompt engineering
- Extensible — adding a new tool means adding a handler to the MCP server
- Standard protocol — MCP is widely supported and documented

### Why custom scheduling over Claude's /loop?

- `/loop` expires after 72 hours — requires session refresh workarounds
- FlowClaw's scheduler is Node-native — no CLI dependency, survives agent restarts
- Configurable — cron expressions, intervals, one-time jobs
- Observable — last run, next run, error tracking

### Why organizations as a first-class concept?

- Real-world use case — users run agents across multiple companies/projects
- Context isolation — Company A's brand guidelines don't leak into Company B
- Communication boundaries — prevent accidental cross-org data sharing
- Shared knowledge — global context (your preferences) flows to all agents
- Convention-based — directory structure makes the hierarchy visible and editable

### Why bindings over one-bot-per-agent?

- Default: one Telegram bot for everything (simplest setup)
- Users can configure additional bots per org (isolation between companies)
- Bindings decouple routing from bot identity — same bot can route to different agents based on command, chat, or user
- Mirrors OpenClaw's binding system which is proven and flexible

---

## 15. Future Architecture Considerations

### Web UI (v2)

The core architecture supports this naturally:
- FlowClaw already has structured event streams from agents (stream-json output)
- Add an HTTP/WebSocket server alongside the Telegram adapter
- Web UI connects via WebSocket, receives the same events as Telegram
- Org-aware dashboard: view agents grouped by org, cross-org activity, cost per org
- No architectural changes needed — just a new ChannelAdapter

### YAML Workflows (v3)

Declarative pipeline definitions:
```yaml
name: code-review-pipeline
org: company-a
trigger: { channel: telegram, command: /review }
steps:
  - template: coder
    workingDirectory: /projects/company-a/app
    task: "Analyze the PR at {url}"
    output: analysis
  - template: reviewer
    workingDirectory: /projects/company-a/app
    task: "Review this analysis: {analysis}"
    output: review
  - agent: company-a/dev-lead
    task: "Summarize and send to Telegram: {review}"
```

FlowClaw would parse YAML workflows into subagent spawn sequences. Workflows are scoped to an org for isolation.

### Kanban Integration (v3)

Agents watch a kanban board (Trello, Linear, GitHub Projects) for tasks in specific columns:
- "Ready for Coder" -> spawns a coder subagent
- "Ready for Review" -> spawns a reviewer subagent
- Results posted back to the card and moved to "Done"

This is a specialized ChannelAdapter that polls a project management API. Each org can have its own kanban integration pointing to different boards.
