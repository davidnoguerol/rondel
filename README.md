# FlowClaw

Multi-agent orchestration framework built on the Claude CLI. Define agents, configure identities and skills, and FlowClaw handles lifecycle, communication, and messaging integration.

## Quick Start

### Prerequisites

- **Node.js 22+**
- [Claude CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated
- Telegram bot token(s) from [@BotFather](https://t.me/BotFather)

### Install

```bash
# Clone and build
git clone <repo-url> flowclaw
cd flowclaw
npm install
npm run build

# Make the CLI available globally
npm link

# First-time setup
flowclaw init
```

During `init` you'll be asked for an agent name, bot token, your Telegram user ID (auto-detected — just message the bot), and default model. At the end you'll be offered to install FlowClaw as an OS service.

**Say yes.** FlowClaw will auto-start on login and auto-restart on crash. No terminal needed — it just works.

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
| `flowclaw start [--foreground]` | Start the orchestrator (daemon by default) |
| `flowclaw stop` | Stop the running orchestrator |
| `flowclaw restart` | Restart the orchestrator |
| `flowclaw logs [-f] [-n N]` | View orchestrator logs |
| `flowclaw status` | Show running instance status |
| `flowclaw doctor` | Validate your installation |
| `flowclaw service install` | Install as OS service (auto-start on login) |
| `flowclaw service uninstall` | Remove OS service |
| `flowclaw service status` | Show OS service status |

## OS Service

FlowClaw runs as a background service managed by your OS:

- **macOS** — launchd (`~/Library/LaunchAgents/dev.flowclaw.orchestrator.plist`)
- **Linux** — systemd user unit (`~/.config/systemd/user/flowclaw.service`)
- **Windows** — Task Scheduler with PowerShell restart wrapper for crash recovery

The service auto-starts on login and auto-restarts on crash (5s delay). Install it during `flowclaw init` or later with `flowclaw service install`.

`flowclaw stop` is service-aware — it uses `launchctl`/`systemctl` to stop properly so the supervisor doesn't restart it.

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
    ├── flowclaw.lock        # PID + bridge URL
    └── flowclaw.log         # Daemon log output
```

Agents are discovered automatically — any directory under `workspaces/` containing `agent.json` is an agent. Organize however you want.

## Adding an Agent

```bash
flowclaw add agent ops-bot
```

Or manually: create a directory with `agent.json` anywhere under `~/.flowclaw/workspaces/`. FlowClaw discovers it on next restart.

Minimum `agent.json`:
```json
{
  "agentName": "ops-bot",
  "enabled": true,
  "model": "sonnet",
  "permissionMode": "bypassPermissions",
  "workingDirectory": null,
  "telegram": { "botToken": "${OPS_BOT_BOT_TOKEN}" },
  "tools": { "allowed": ["Bash", "Read", "Write", "Edit"], "disallowed": [] },
  "crons": []
}
```

Bot tokens go in `~/.flowclaw/.env` as `OPS_BOT_BOT_TOKEN=...` and are referenced with `${VAR}` syntax in agent.json.

## Status

Active development. See [DEVLOG.md](DEVLOG.md) for current progress and [ARCHITECTURE.md](ARCHITECTURE.md) for how the system is built.
