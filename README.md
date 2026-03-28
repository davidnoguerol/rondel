# FlowClaw

Multi-agent orchestration framework built on the Claude CLI. Define agents, configure identities and skills, and FlowClaw handles lifecycle, communication, and messaging integration.

## Quick Start

```bash
# Install dependencies
npm install

# Build
npm run build

# First-time setup (creates ~/.flowclaw/)
npx flowclaw init

# Start the orchestrator
npx flowclaw start
```

## How It Works

FlowClaw bridges Telegram bots to Claude CLI processes. Each agent is a Telegram bot backed by one or more Claude CLI instances — one per conversation. Agents have persistent identity, memory, and tools via MCP.

```
User (Telegram) → FlowClaw → Claude CLI (stream-json) → MCP Tools → Telegram API
```

**Key concepts:**
- **Agents** are templates (identity + config + tools). No processes run until someone messages the bot.
- **Per-conversation isolation** — 3 users messaging the same bot = 3 independent Claude instances.
- **Context composition** — system prompts assembled from `AGENT.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`, `MEMORY.md`.
- **First-run bootstrap** — new agents run an onboarding ritual on first message, then delete `BOOTSTRAP.md`.

## CLI Commands

| Command | What |
|---------|------|
| `flowclaw init` | First-time setup — creates `~/.flowclaw/`, config, first agent |
| `flowclaw add agent [name]` | Add a new agent |
| `flowclaw start` | Run the orchestrator (foreground) |
| `flowclaw status` | Show running instance status |
| `flowclaw doctor` | Validate your installation |

## Directory Structure

FlowClaw installs to `~/.flowclaw/` (override with `FLOWCLAW_HOME`):

```
~/.flowclaw/
├── config.json              # Global settings
├── .env                     # Secrets (bot tokens)
├── workspaces/              # Your agents and content (git this)
│   ├── global/
│   │   ├── CONTEXT.md       # Shared across all agents
│   │   └── agents/
│   │       └── assistant/   # Agent directory
│   │           ├── agent.json
│   │           ├── AGENT.md, SOUL.md, IDENTITY.md
│   │           ├── USER.md, MEMORY.md
│   │           └── BOOTSTRAP.md
│   └── {org}/               # Optional org grouping
│       └── agents/...
├── templates/               # Subagent blueprints
└── state/                   # Runtime state (don't commit)
```

Agents are discovered automatically — any directory under `workspaces/` containing `agent.json` is an agent. Organize however you want.

## Adding an Agent

```bash
flowclaw add agent ops-bot
```

Or manually: create a directory with `agent.json` anywhere under `~/.flowclaw/workspaces/`. FlowClaw discovers it on next start.

Minimum `agent.json`:
```json
{
  "agentName": "ops-bot",
  "enabled": true,
  "model": "sonnet",
  "permissionMode": "bypassPermissions",
  "workingDirectory": null,
  "telegram": { "botToken": "YOUR_BOT_TOKEN" },
  "tools": { "allowed": ["Bash", "Read", "Write", "Edit"], "disallowed": [] },
  "crons": []
}
```

## Requirements

- Node.js 22+
- [Claude CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated
- Telegram bot token(s) from [@BotFather](https://t.me/BotFather)

## Status

Active development. See [DEVLOG.md](DEVLOG.md) for current progress and [ARCHITECTURE.md](ARCHITECTURE.md) for how the system is built.
