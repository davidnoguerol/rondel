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
pnpm install
pnpm build

# Make the CLI available globally
pnpm link --global

# First-time setup
rondel init
```

Rondel is a pnpm workspace. The daemon lives in [apps/daemon](apps/daemon/) and the (optional) web UI in [apps/web](apps/web/). Build or run the daemon only via `pnpm --filter @rondel/daemon <script>`, or use the root shortcuts (`pnpm build`, `pnpm start`).

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
  "workingDirectory": null,
  "channels": [
    {
      "channelType": "telegram",
      "accountId": "ops-bot",
      "credentialEnvVar": "OPS_BOT_TELEGRAM_TOKEN"
    }
  ],
  "tools": { "allowed": ["Read", "Glob", "Grep", "WebSearch", "WebFetch"], "disallowed": [] },
  "crons": []
}
```

Shell and filesystem access go through first-class MCP tools — `rondel_bash`, `rondel_read_file`, `rondel_write_file`, `rondel_edit_file`, `rondel_multi_edit_file`. Each tool runs its own safety classifier and escalates dangerous calls to a human via Telegram inline buttons or the web UI `/approvals` page. There is no per-agent `permissionMode` — safety is per-tool. Native `Bash` / `Write` / `Edit` / `MultiEdit` / `AskUserQuestion` are framework-disallowed; structured questions go through `rondel_ask_user` instead.

Credentials live in `~/.rondel/.env` (e.g. `OPS_BOT_TELEGRAM_TOKEN=...`). Each `channels` entry names the env var holding its primary secret.

## Channels

Rondel is built around a pluggable channel architecture — each adapter lives in its own folder under [apps/daemon/src/channels/](apps/daemon/src/channels/) and exposes the same `ChannelAdapter` interface. Additional channels (Slack, Discord, WhatsApp) slot into the same pattern when needed.

### Telegram

Get a bot token from [@BotFather](https://t.me/BotFather), set `OPS_BOT_TELEGRAM_TOKEN=...` in `~/.rondel/.env`, and add the binding shown above.

### Web (loopback)

Every agent is automatically reachable from the optional web dashboard in [apps/web](apps/web/) — there is nothing to configure. The daemon registers an in-process `WebChannelAdapter` at startup and creates a synthetic `web:<agentName>` account for each agent, so the dashboard's chat view can talk to any agent via the same `ChannelAdapter` pipeline Telegram uses (routing, queuing, hooks, ledger, memory — all unchanged). The channel is loopback-only and carries no credentials; the web UI's loopback-gated proxy is the only way in.

## Status

Active development. See [ARCHITECTURE.md](ARCHITECTURE.md) for how the system is built.
