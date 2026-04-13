# Rondel

Multi-agent orchestration framework built on the Claude CLI. Define agents, configure identities and skills, and Rondel handles lifecycle, communication, and messaging integration.

## Quick Start

### Prerequisites

- **Node.js 22+**
- [Claude CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated
- Telegram bot token(s) from [@BotFather](https://t.me/BotFather)

### Install

```bash
# Clone and build
git clone <repo-url> rondel
cd rondel
npm install
npm run build

# Make the CLI available globally
npm link

# First-time setup
rondel init
```

During `init` you'll be asked for an agent name, bot token, your Telegram user ID (auto-detected — just message the bot), and default model. At the end you'll be offered to install Rondel as an OS service.

**Say yes.** Rondel will auto-start on login and auto-restart on crash. No terminal needed — it just works.

## How It Works

Rondel bridges Telegram bots to Claude CLI processes. Each agent is a Telegram bot backed by one or more Claude CLI instances — one per conversation. Agents have persistent identity, memory, and tools via MCP.

```
User (Telegram) → Rondel → Claude CLI (stream-json) → MCP Tools → Telegram API
```

**Key concepts:**
- **Agents** are templates (identity + config + tools). No processes run until someone messages the bot.
- **Per-conversation isolation** — 3 users messaging the same bot = 3 independent Claude instances.
- **Context composition** — system prompts assembled from `AGENT.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`, `MEMORY.md`.
- **First-run bootstrap** — new agents run an onboarding ritual on first message, then delete `BOOTSTRAP.md`.

## CLI Commands

| Command | What |
|---------|------|
| `rondel init` | First-time setup — creates `~/.rondel/`, config, first agent, installs service |
| `rondel add agent [name]` | Add a new agent |
| `rondel add org [name]` | Add a new organization |
| `rondel stop` | Stop the running orchestrator |
| `rondel restart` | Restart the OS service |
| `rondel logs [-f] [-n N]` | View orchestrator logs |
| `rondel status` | Show running instance status |
| `rondel doctor` | Validate your installation |
| `rondel service install` | Install as OS service (auto-start on login) |
| `rondel service uninstall` | Remove OS service |
| `rondel service status` | Show OS service status |

## OS Service

Rondel runs as a background service managed by your OS:

- **macOS** — launchd (`~/Library/LaunchAgents/dev.rondel.orchestrator.plist`)
- **Linux** — systemd user unit (`~/.config/systemd/user/rondel.service`)
- **Windows** — Task Scheduler with PowerShell restart wrapper for crash recovery

The service auto-starts on login and auto-restarts on crash (5s delay). Install it during `rondel init` or later with `rondel service install`.

`rondel stop` is service-aware — it uses `launchctl`/`systemctl` to stop properly so the supervisor doesn't restart it.

## Directory Structure

Rondel installs to `~/.rondel/` (override with `RONDEL_HOME`):

```
~/.rondel/
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
    ├── rondel.lock        # PID + bridge URL
    └── rondel.log         # Daemon log output
```

Agents are discovered automatically — any directory under `workspaces/` containing `agent.json` is an agent. Organize however you want.

## Adding an Agent

```bash
rondel add agent ops-bot
```

Or manually: create a directory with `agent.json` anywhere under `~/.rondel/workspaces/`. Rondel discovers it on next restart.

Minimum `agent.json`:
```json
{
  "agentName": "ops-bot",
  "enabled": true,
  "model": "sonnet",
  "permissionMode": "bypassPermissions",
  "workingDirectory": null,
  "channels": [
    {
      "channelType": "telegram",
      "accountId": "ops-bot",
      "credentialEnvVar": "OPS_BOT_TELEGRAM_TOKEN"
    }
  ],
  "tools": { "allowed": ["Bash", "Read", "Write", "Edit"], "disallowed": [] },
  "crons": []
}
```

Credentials live in `~/.rondel/.env` (e.g. `OPS_BOT_TELEGRAM_TOKEN=...`). Each `channels` entry names the env var holding its primary secret.

## Channels

Rondel is built around a pluggable channel architecture — each adapter lives in its own folder under `src/channels/` and exposes the same `ChannelAdapter` interface. Today Telegram is the only shipped adapter; additional channels (Slack, Discord, WhatsApp) slot into the same pattern when needed.

### Telegram

Get a bot token from [@BotFather](https://t.me/BotFather), set `OPS_BOT_TELEGRAM_TOKEN=...` in `~/.rondel/.env`, and add the binding shown above.

## Status

Active development. See [ARCHITECTURE.md](ARCHITECTURE.md) for how the system is built.
