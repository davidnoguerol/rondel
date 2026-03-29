# Claude Remote Manager — Complete Architecture & Internals Guide

A comprehensive deep-dive into every mechanism, file, and data flow in the system. Written so that a developer can understand how all pieces connect, extend the system, or build their own version from scratch.

---

## Table of Contents

1. [High-Level Overview](#1-high-level-overview)
2. [Directory Structure & File Map](#2-directory-structure--file-map)
3. [Installation & Bootstrap Flow](#3-installation--bootstrap-flow)
4. [Agent Lifecycle in Detail](#4-agent-lifecycle-in-detail)
5. [The Fast-Checker Daemon](#5-the-fast-checker-daemon)
6. [Telegram Integration](#6-telegram-integration)
7. [Claude Code Hook System](#7-claude-code-hook-system)
8. [Inter-Agent Message Bus](#8-inter-agent-message-bus)
9. [Cron / Scheduled Task System](#9-cron--scheduled-task-system)
10. [Restart Mechanics (Soft vs Hard)](#10-restart-mechanics-soft-vs-hard)
11. [Crash Recovery & Rate Limiting](#11-crash-recovery--rate-limiting)
12. [Working Directory Override](#12-working-directory-override)
13. [Local Override Pattern](#13-local-override-pattern)
14. [Security Model](#14-security-model)
15. [Skills System](#15-skills-system)
16. [Telegram Command Registration](#16-telegram-command-registration)
17. [Configuration Reference](#17-configuration-reference)
18. [Data Flow Diagrams](#18-data-flow-diagrams)
19. [Extending the System](#19-extending-the-system)
20. [Building Your Own Version](#20-building-your-own-version)

---

## 1. High-Level Overview

Claude Remote Manager (CRM) turns Claude Code CLI sessions into persistent, 24/7 headless agents that you control from Telegram. The core idea:

```
You (Telegram)  <-->  fast-checker.sh (polls Telegram every ~3s)  <-->  tmux session  <-->  Claude Code CLI
                                                                            ^
                                                                       launchd (keeps alive forever)
```

The system is built entirely from bash scripts, JSON config files, and macOS launchd plists. There are zero external runtime dependencies beyond `claude`, `tmux`, `jq`, `curl`, and `python3` (for timestamps and settings merging).

**Key design decisions:**

- **tmux provides the PTY** — Claude Code requires an interactive terminal (PTY) to stay alive and support `/loop` crons. tmux provides this even when no human is attached.
- **launchd provides persistence** — macOS's init system restarts the agent-wrapper if it ever exits. The `KeepAlive: true` flag means the process is always respawned.
- **`--dangerously-skip-permissions`** is required because Claude Code cannot run non-interactively without it. Permission boundaries are enforced via Telegram hooks instead (advisory, not CLI-level).
- **File-based message bus** — Inter-agent communication uses JSON files in `~/.claude-remote/{instance}/inbox/`. No databases, no network services.
- **tmux send-keys for injection** — The fast-checker injects messages into the running Claude Code session by pasting text into the tmux pane. This is the fundamental mechanism that makes remote control possible.

---

## 2. Directory Structure & File Map

### Repository (source code)

```
claude-remote-manager/
├── .env                              # Instance ID (created by install.sh)
├── .env.example                      # Template: just CRM_INSTANCE_ID=default
├── .gitignore                        # Ignores .env, agent local dirs, logs
├── .claude/
│   ├── settings.json                 # Repo-level hooks (SessionEnd crash alert)
│   └── commands/
│       └── claude-remote-manager-setup.md   # Interactive onboarding slash command
├── core/
│   ├── bus/                          # Message bus scripts (Telegram + inter-agent)
│   │   ├── _telegram-curl.sh         # Shared curl wrapper (hides BOT_TOKEN from traces)
│   │   ├── check-telegram.sh         # Poll Telegram getUpdates API
│   │   ├── send-telegram.sh          # Send message/photo to Telegram
│   │   ├── edit-message.sh           # Edit existing Telegram message
│   │   ├── answer-callback.sh        # Answer Telegram callback query (dismiss loading)
│   │   ├── send-ask-question.sh      # Send Nth question from ask state to Telegram
│   │   ├── check-inbox.sh            # Read inter-agent inbox, move to inflight
│   │   ├── ack-inbox.sh              # Acknowledge processed message (inflight -> processed)
│   │   ├── send-message.sh           # Send message to another agent's inbox
│   │   ├── hook-permission-telegram.sh    # PermissionRequest hook -> Telegram approve/deny
│   │   ├── hook-ask-telegram.sh           # PreToolUse hook for AskUserQuestion -> Telegram
│   │   ├── hook-planmode-telegram.sh      # ExitPlanMode hook -> Telegram plan review
│   │   ├── self-restart.sh           # Soft restart (--continue, preserves history)
│   │   └── hard-restart.sh           # Hard restart (fresh session, no history)
│   ├── scripts/
│   │   ├── agent-wrapper.sh          # Main entry point: launchd -> tmux -> claude
│   │   ├── fast-checker.sh           # Telegram + inbox polling daemon
│   │   ├── generate-launchd.sh       # Generate and load macOS launchd plist
│   │   ├── crash-alert.sh            # SessionEnd hook: alert on Telegram
│   │   └── register-telegram-commands.sh  # Register skills as Telegram /commands
│   └── skills/
│       ├── comms/SKILL.md            # Message handling reference
│       └── cron-management/SKILL.md  # Cron setup and persistence guide
├── agents/
│   └── agent-template/               # Template copied for each new agent
│       ├── CLAUDE.md                 # Agent system prompt / instructions
│       ├── config.json               # Agent config (crons, model, session duration)
│       ├── .env.example              # Template for BOT_TOKEN, CHAT_ID, ALLOWED_USER
│       ├── .claude/settings.json     # Hook configuration (permission, ask, plan, crash)
│       └── skills/                   # Agent-local copies of core skills
│           ├── comms/SKILL.md
│           └── cron-management/SKILL.md
├── install.sh                        # Create ~/.claude-remote state directories
├── setup.sh                          # Interactive agent onboarding wizard
├── enable-agent.sh                   # Start/restart an agent via launchd
└── disable-agent.sh                  # Stop an agent, unload launchd, kill tmux
```

### Runtime state (`~/.claude-remote/{instance}/`)

```
~/.claude-remote/default/
├── config/
│   └── enabled-agents.json           # Which agents are enabled/disabled
├── state/
│   ├── .telegram-offset-{agent}      # Last Telegram update_id per agent
│   └── {agent}.force-fresh           # Marker file: next boot uses fresh start
├── inbox/{agent}/                    # Incoming inter-agent messages (JSON files)
├── outbox/{agent}/                   # (Reserved, not currently used)
├── inflight/{agent}/                 # Messages being processed (awaiting ACK)
├── processed/{agent}/                # Acknowledged messages (archive)
└── logs/{agent}/
    ├── activity.log                  # Session starts, ends, general events
    ├── crashes.log                   # Crash events, rate limiting, session refreshes
    ├── restarts.log                  # Soft and hard restart events
    ├── fast-checker.log              # Fast-checker daemon output
    ├── stdout.log                    # launchd stdout capture
    ├── stderr.log                    # launchd stderr capture
    ├── .crash_count_today            # Format: "YYYY-MM-DD:N" — crash counter
    ├── .launch.sh                    # Generated launch script for fresh starts
    ├── .local-prompt                 # Concatenated local/*.md overrides
    └── .merged-settings.json         # Merged project + agent settings
```

---

## 3. Installation & Bootstrap Flow

### Step 1: `install.sh`

Creates the runtime state directory tree at `~/.claude-remote/{instance}/`. The instance ID defaults to `"default"` but can be overridden via argument or `.env`.

What it does:
1. Checks dependencies: `tmux`, `jq`, `claude` CLI
2. Verifies `claude --version` works (ensures CLI is authenticated)
3. Creates `~/.claude-remote/{id}/` with subdirs: `config`, `state`, `inbox`, `outbox`, `processed`, `inflight`, `logs` (all chmod 700)
4. Writes empty `enabled-agents.json` to config/
5. Writes `.env` to repo root with `CRM_INSTANCE_ID` and `CRM_ROOT`
6. Makes all scripts executable

### Step 2: `setup.sh`

Interactive wizard that creates a new agent from the template:

1. Prompts for agent name (validates: lowercase, alphanumeric, hyphens, underscores)
2. Copies `agents/agent-template/` to `agents/{name}/`
3. Prompts for Telegram bot token (from @BotFather)
4. Prompts for Chat ID (instructs user how to get it)
5. Prompts for Allowed User ID (defaults to Chat ID for private chats)
6. Writes `.env` to agent directory (chmod 600)
7. Updates `config.json` with agent name via jq
8. Creates per-agent state directories (inbox, outbox, processed, inflight, logs)
9. Runs `generate-launchd.sh` to create and load the macOS service
10. Updates `enabled-agents.json`

After setup, the agent is immediately live and running.

---

## 4. Agent Lifecycle in Detail

### Entry point: `agent-wrapper.sh`

This is the script that launchd actually runs. It receives two arguments: `<agent_name>` and `<template_root>`.

**Full lifecycle:**

```
launchd starts agent-wrapper.sh
    │
    ├─ Load .env (BOT_TOKEN, CHAT_ID, etc.)
    ├─ Export CRM_* environment variables
    ├─ Check crash count for today
    │   └─ If >= 3 crashes today → alert via Telegram, sleep 24h, exit
    ├─ Apply startup_delay from config.json (stagger multiple agents)
    ├─ Read max_session_seconds from config.json (default: 255600 = 71 hours)
    ├─ Read model override from config.json
    ├─ Handle working_directory override (see Section 12)
    ├─ Handle local/ directory overrides (see Section 13)
    ├─ Determine start mode:
    │   ├─ If force-fresh marker exists → "fresh" (delete marker)
    │   ├─ If no conversation .jsonl files exist → "fresh"
    │   └─ Otherwise → "continue"
    ├─ Register Telegram bot commands (skills/commands autocomplete)
    ├─ Start caffeinate (prevent Mac sleep)
    ├─ Kill any stale tmux session for this agent
    ├─ Create tmux session: `tmux new-session -d -s crm-{instance}-{agent} bash`
    ├─ Send initial claude command into tmux:
    │   ├─ Fresh: `claude --dangerously-skip-permissions [flags] "STARTUP_PROMPT"`
    │   └─ Continue: `claude --continue --dangerously-skip-permissions [flags] "CONTINUE_PROMPT"`
    ├─ Start background timer (session refresh every MAX_SESSION seconds)
    ├─ Start fast-checker.sh daemon
    ├─ Enter watchdog loop:
    │   ├─ Check if tmux session still exists
    │   ├─ If fast-checker died → restart it
    │   └─ Sleep 5s, repeat
    │
    └─ On tmux session end:
        ├─ Kill timer and fast-checker
        ├─ Check for rate limiting in stderr.log → exponential backoff
        ├─ Check if this was a planned session refresh → exit 0
        └─ Otherwise: log crash, increment crash counter, exit 1
            └─ launchd sees exit 1 → respawns agent-wrapper.sh
```

**The STARTUP_PROMPT** (fresh start) tells Claude to:
1. Read all bootstrap files listed in CLAUDE.md
2. Read config.json and set up crons via `/loop`
3. Send a Telegram message saying it's online

**The CONTINUE_PROMPT** (resuming) tells Claude to:
1. Re-read all bootstrap files (configs may have changed)
2. Re-create crons (lost when CLI restarted)
3. Check inbox for pending messages
4. Resume normal operations

### The session refresh timer

A background subshell runs in a while loop. Every `MAX_SESSION` seconds (default 71 hours), it:

1. Sends Ctrl-C to the tmux pane to interrupt Claude
2. Sends `/exit` to cleanly shut down
3. Waits 3 seconds, then kills any remaining Claude child processes
4. Kills the old fast-checker, starts a fresh one
5. Relaunches Claude with `--continue` (preserves conversation history)

The 71-hour default is chosen because Claude Code's `/loop` crons expire after 72 hours. By restarting at 71h, crons are recreated from config.json before they would expire.

---

## 5. The Fast-Checker Daemon

`fast-checker.sh` is the bridge between the outside world and the Claude Code session. It runs alongside the main tmux session.

### Boot sequence

1. Wait up to 30 seconds for Claude Code to fully initialize (detects "permissions" text in tmux pane output)
2. Source `.env` for BOT_TOKEN and Telegram helpers
3. Enter main poll loop

### Main poll loop (runs every ~1-4 seconds)

Each iteration:

1. **Check tmux** — Exit if the session is gone
2. **Poll Telegram** — Run `check-telegram.sh` to get new messages
3. **Process each Telegram update:**
   - **Text messages**: Wrap in a formatted block with metadata header and reply instructions
   - **Photos**: Include local file path (downloaded by check-telegram.sh)
   - **Callback queries** (inline button presses): Route to appropriate handler:
     - `perm_allow_{id}` / `perm_deny_{id}` — Write decision to response file (for hook-permission-telegram.sh)
     - `askopt_{qIdx}_{optIdx}` — Navigate Claude Code's TUI (Down keys + Enter)
     - `asktoggle_{qIdx}_{optIdx}` — Toggle multi-select option in state file
     - `asksubmit_{qIdx}` — Submit multi-select (Space for each chosen, navigate to Submit, Enter)
   - **CLI commands** (`/compact`, `/clear`, etc.): Inject raw (no wrapping)
4. **Check inter-agent inbox** — Run `check-inbox.sh` to get pending messages
5. **Build message block** — Concatenate all messages into a single text block
6. **Inject into tmux** — Use `tmux load-buffer` + `tmux paste-buffer` + `Enter`
7. **ACK inbox messages** after successful injection

### The injection mechanism

This is the most critical mechanism in the system:

```bash
# 1. Write message content to a temp file
printf '%s' "$content" > "$tmpfile"

# 2. Load into tmux's paste buffer
tmux load-buffer -b "crm-${AGENT}" "$tmpfile"

# 3. Paste into the active pane (bracketed paste mode)
tmux paste-buffer -t "${TMUX_SESSION}:0.0" -b "crm-${AGENT}"

# 4. Wait briefly for content to land in PTY buffer
sleep 0.3

# 5. Press Enter to submit
tmux send-keys -t "${TMUX_SESSION}:0.0" Enter
```

Using `load-buffer` + `paste-buffer` instead of `send-keys` for the content is important because:
- `send-keys` has character limits and can mangle special characters
- `paste-buffer` handles raw bytes correctly via bracketed paste
- The temp file ensures content integrity

### AskUserQuestion TUI navigation

When Claude Code calls `AskUserQuestion`, it renders a terminal UI (TUI) with selectable options. The fast-checker navigates this TUI programmatically:

**Single-select:** For option index N, send `Down` key N times, then `Enter`.

**Multi-select:** For each chosen option, navigate to it with `Down` keys and press `Space` to toggle it. After all selections, navigate past all options (including the auto-added "Other") to the Submit button and press `Enter`.

**Multi-question flows:** A state file at `/tmp/crm-ask-state-{agent}.json` tracks which question we're on, what options are available, and which multi-select choices have been toggled. After answering one question, the system checks if there are more and sends the next one to Telegram.

---

## 6. Telegram Integration

### Polling: `check-telegram.sh`

Uses Telegram Bot API's long-polling (`getUpdates` with 5s timeout). Key behaviors:

1. Sources agent `.env` to get `BOT_TOKEN`
2. Requires `ALLOWED_USER` — rejects all messages if not set
3. Reads last offset from `~/.claude-remote/{instance}/state/.telegram-offset-{agent}`
4. Calls `getUpdates?offset={offset}&timeout=5`
5. Filters results: only updates from the `ALLOWED_USER` (by numeric user ID)
6. Outputs three types of JSON lines:
   - Text messages: `{chat_id, from, text, date, type: "message"}`
   - Photos: downloads largest size via `getFile` API, saves to `agents/{agent}/telegram-images/`, outputs `{..., image_path, type: "photo"}`
   - Callback queries: `{chat_id, from, callback_data, callback_query_id, message_id, type: "callback"}`
7. Updates offset file so processed messages aren't re-fetched

### Sending: `send-telegram.sh`

Supports three modes:
- **Text**: `send-telegram.sh <chat_id> "<message>"` — uses Markdown parse mode
- **Text with keyboard**: `send-telegram.sh <chat_id> "<message>" '<keyboard_json>'` — adds inline buttons
- **Photo**: `send-telegram.sh <chat_id> "<caption>" --image /path/to/file.jpg`

Strips MarkdownV2 backslash escapes that Claude sometimes adds. Returns the message_id of the sent message.

### Helper scripts

- **`_telegram-curl.sh`**: Sourced (not executed) by other scripts. Provides `telegram_api_post`, `telegram_api_get`, and `telegram_file_download` functions. Wraps curl calls in subshells with `set +x` to prevent BOT_TOKEN from leaking into shell traces.
- **`edit-message.sh`**: Edits an existing message (used to update button labels after a decision is made). Can also update the inline keyboard.
- **`answer-callback.sh`**: Calls `answerCallbackQuery` to dismiss the loading spinner on inline buttons.

---

## 7. Claude Code Hook System

Claude Code supports hooks — external scripts that run when specific events occur. CRM configures three hook types in each agent's `.claude/settings.json`:

### 7a. PermissionRequest hook (`hook-permission-telegram.sh`)

**Trigger:** Claude Code wants to use a tool (Edit, Write, Bash, etc.) that requires permission.

**Mechanism:**
1. Reads JSON from stdin containing `tool_name` and `tool_input`
2. Skips `ExitPlanMode` and `AskUserQuestion` (handled by other hooks)
3. Builds a human-readable summary of the operation:
   - `Edit`: shows file path, old string, new string (truncated to 300 chars each)
   - `Write`: shows file path and content preview
   - `Bash`: shows the command
   - Others: shows raw tool_input JSON
4. Generates a unique ID (16 random hex bytes)
5. Sends to Telegram with Approve/Deny inline buttons (callback_data: `perm_allow_{id}` / `perm_deny_{id}`)
6. **Polls for response file** at `/tmp/crm-hook-response-{agent}-{id}.json` every 2 seconds
7. The fast-checker writes this file when the user taps a button
8. Returns JSON to Claude Code: `{"behavior": "allow"}` or `{"behavior": "deny"}`
9. **Timeout: 30 minutes** — auto-denies and notifies user

**The response file bridge:** This is how the blocking hook (which must return a decision to Claude Code) communicates with the non-blocking fast-checker (which receives the Telegram callback). The hook polls a temp file; the fast-checker writes to it.

### 7b. PreToolUse hook for AskUserQuestion (`hook-ask-telegram.sh`)

**Trigger:** Claude Code is about to call `AskUserQuestion`.

**Mechanism:**
1. Reads the `tool_input.questions` array from stdin
2. Creates a state file at `/tmp/crm-ask-state-{agent}.json` containing:
   - All questions with their options, headers, multiSelect flags
   - `current_question: 0` and `total_questions: N`
   - `multi_select_chosen: []` for tracking multi-select toggles
3. Sends the first question to Telegram with inline keyboard buttons
4. **Exits immediately (non-blocking)** — the TUI navigation happens later via fast-checker callbacks

This hook is non-blocking (`timeout: 10`) because it only needs to *send* the question. The actual answer comes through callback processing in fast-checker.sh.

### 7c. ExitPlanMode hook (`hook-planmode-telegram.sh`)

**Trigger:** Claude Code enters plan mode and wants to exit it (execute the plan).

**Mechanism:**
1. Reads plan file path from stdin or finds the latest plan in `~/.claude/plans/`
2. Reads plan content (up to 100 lines, truncated to 3600 chars for Telegram's 4096 limit)
3. Sends to Telegram with Approve Plan / Deny Plan buttons
4. Polls for response file (same mechanism as permission hook)
5. **Timeout: 30 minutes** — **auto-approves** (unlike permissions which auto-deny). This design choice means agents aren't blocked if the user is away.

### 7d. SessionEnd hook (`crash-alert.sh`)

**Trigger:** Claude Code session ends (crash, exit, or planned shutdown).

**Mechanism:**
1. Reads session info from stdin (session_id)
2. Logs to activity.log
3. Checks today's crash count for context
4. Sends a notification to the agent's Telegram chat

Configured in both the repo-level `.claude/settings.json` (for development sessions) and each agent's `.claude/settings.json`.

---

## 8. Inter-Agent Message Bus

The message bus is a file-based system for agents to communicate with each other. It uses a classic inbox/inflight/processed pattern.

### Sending: `send-message.sh`

```bash
send-message.sh <to_agent> <priority> '<message text>' [reply_to]
```

1. Validates sender agent name (alphanumeric + hyphens/underscores only)
2. Auto-creates target inbox directory if it doesn't exist
3. Maps priority to sort number: urgent=0, high=1, normal=2, low=3
4. Generates unique filename: `{priority}-{epoch_ms}-from-{sender}-{random}.json`
5. Builds JSON message with: id, from, to, priority, timestamp, text, reply_to
6. Atomic write: writes to `.tmp.{filename}`, then `mv` to final path
7. If replying, auto-ACKs the original message
8. Returns the message ID

**Filename format matters:** Files are sorted by `ls | sort`, so the priority prefix ensures urgent messages sort first, then by timestamp.

### Receiving: `check-inbox.sh`

1. Uses `mkdir`-based locking (portable, works on macOS without `flock`)
2. **Recovers stale inflight messages:** Any message in inflight/ older than 5 minutes gets moved back to inbox for re-delivery
3. Collects all `.json` files in inbox, sorted (priority then timestamp)
4. Validates each file with `jq empty` (moves corrupt files to `.errors/`)
5. Moves valid messages from inbox → inflight (atomically)
6. Outputs JSON array of all messages

### Acknowledging: `ack-inbox.sh`

Moves a message from inflight → processed by matching the message ID. Idempotent — exits 0 if already processed or not found.

### Message flow

```
Agent A calls send-message.sh "agentB" normal "hello"
    │
    ├─ Creates: ~/.claude-remote/default/inbox/agentB/2-1711234567890-from-agentA-ab12c.json
    │
    ├─ Agent B's fast-checker runs check-inbox.sh
    │   └─ Moves file to: inflight/agentB/
    │   └─ Returns message as JSON
    │
    ├─ Fast-checker injects message into Agent B's tmux session:
    │   "=== AGENT MESSAGE from agentA [msg_id: 1711234567890-agentA-ab12c] ===
    │    hello
    │    Reply using: bash ../../core/bus/send-message.sh agentA normal '<reply>' 1711234567890-agentA-ab12c"
    │
    ├─ Agent B processes and replies
    │   └─ send-message.sh auto-ACKs the original (moves inflight → processed)
    │
    └─ If Agent B doesn't reply within 5 minutes:
        └─ check-inbox.sh recovers the message back to inbox for re-delivery
```

---

## 9. Cron / Scheduled Task System

CRM uses Claude Code's built-in `/loop` command for recurring tasks, with a persistence layer on top.

### How `/loop` works

`/loop {interval} {prompt}` creates a recurring task inside Claude Code that fires every `{interval}` (e.g., "5m", "1h"). However, these have a built-in 3-day (72-hour) expiry.

### CRM's persistence mechanism

1. Crons are defined in each agent's `config.json`:
   ```json
   {
     "crons": [
       {"name": "check-inbox", "interval": "5m", "prompt": "Check inbox for new messages"},
       {"name": "daily-summary", "interval": "24h", "prompt": "Send daily summary to Telegram"}
     ]
   }
   ```

2. On every session start (fresh or continue), the STARTUP/CONTINUE prompt tells Claude to re-read config.json and recreate all `/loop` entries.

3. The 71-hour session refresh (agent-wrapper timer) restarts Claude with `--continue` before the 72-hour expiry, triggering cron recreation.

4. This creates effectively permanent crons that survive crashes, restarts, and the native 3-day limit.

### Adding/removing crons

The CLAUDE.md instructions tell Claude to:
- **Add**: Create the `/loop` immediately, then persist to config.json
- **Remove**: Cancel the `/loop`, then remove from config.json

---

## 10. Restart Mechanics (Soft vs Hard)

### Soft restart: `self-restart.sh`

Preserves conversation history. Used for config reloads, clearing stuck states.

1. Logs the restart reason
2. Schedules a restart after 5-second delay (so current Claude turn can finish):
   - Sends Ctrl-C to interrupt Claude
   - Sends `/exit` to shut down cleanly
   - Kills remaining child processes
   - Kills and restarts fast-checker
   - Launches `claude --continue --dangerously-skip-permissions "CONTINUE_PROMPT"`
3. The nohup + disown ensures the restart runs even after the current script exits

### Hard restart: `hard-restart.sh`

Starts a completely fresh session with no conversation history.

1. Logs the restart reason
2. Resets crash counter (so launchd doesn't throttle)
3. Writes a force-fresh marker file: `~/.claude-remote/{instance}/state/{agent}.force-fresh`
4. Schedules `launchctl unload` then `launchctl load` after 10 seconds
5. When agent-wrapper.sh starts again, it sees the force-fresh marker and uses `STARTUP_PROMPT` instead of `--continue`

### Timer-based refresh (automatic)

The background timer in agent-wrapper.sh does a soft restart every MAX_SESSION seconds. This is a modified soft restart that happens within the wrapper itself:

1. Ctrl-C → `/exit` → kill child processes
2. Kill and restart fast-checker
3. Relaunch `claude --continue` in the same tmux session

---

## 11. Crash Recovery & Rate Limiting

### Crash counting

`agent-wrapper.sh` maintains a crash counter in `{log_dir}/.crash_count_today`:
- Format: `YYYY-MM-DD:N` (date and count on one line)
- Resets daily (if stored date doesn't match today)
- If count >= 3: halts the agent, alerts via Telegram, sleeps 24 hours
- On each unexpected exit: increments counter and exits with code 1

### launchd respawn

The plist has `KeepAlive: true` and `ThrottleInterval: 10`. When agent-wrapper exits with non-zero, launchd waits 10 seconds then restarts it. The crash counter prevents infinite restart loops.

### Rate limit detection

After the tmux session ends, agent-wrapper checks `stderr.log` for rate-limiting indicators (`rate.limit`, `429`, `capacity`). If found:
- Logs a `RATE_LIMITED` event
- Calculates exponential backoff: `300 * min(count + 1, 4)` seconds (5min, 10min, 15min, 20min max)
- Sleeps for the backoff period
- Exits 0 (so launchd restarts cleanly after backoff)

### Session refresh detection

If the crash log's last entry is `SESSION_REFRESH`, it was a planned restart (from the timer), so the wrapper exits 0 cleanly.

---

## 12. Working Directory Override

Agents can operate in a different project directory while keeping their identity (CLAUDE.md, hooks, .env) centralized in the repo.

Set `"working_directory": "/path/to/project"` in config.json.

When active, agent-wrapper.sh:

1. Sets `LAUNCH_DIR` to the working directory instead of the agent directory
2. Uses `--append-system-prompt-file` to inject CLAUDE.md as a system prompt
3. Merges settings: takes the target project's `.claude/settings.json` as base, overlays the agent's settings on top (deep merge with Python). This preserves the project's hooks/permissions while adding CRM's Telegram hooks.
4. Uses `--add-dir` to give Claude read access back to the template root (for bus scripts, etc.)

The Python merge logic handles three cases:
- **Dicts**: Deep merge (recurse)
- **Lists**: Concatenate, deduplicate
- **Scalars**: Override (agent wins)

---

## 13. Local Override Pattern

For per-agent customizations that survive `git pull`:

1. Place `.md` files in `agents/{agent}/local/`
2. The `local/` directory is gitignored
3. On startup, agent-wrapper.sh concatenates all `.md` files in `local/` (sorted alphabetically)
4. The combined content is passed to Claude via `--append-system-prompt`

This lets you add custom instructions, personality, goals, or context without modifying tracked files.

---

## 14. Security Model

### Telegram authentication

- `ALLOWED_USER` in `.env` restricts which Telegram user ID can send commands
- If not configured, the agent rejects ALL messages (fail-closed)
- `check-telegram.sh` filters updates by `from.id` at the API response level
- Agent names are sanitized to `[a-zA-Z0-9_ -]` to prevent header injection

### File permissions

- All state directories: chmod 700 (owner-only)
- `.env` files: chmod 600
- Temp files (responses, messages): chmod 600
- Everything scoped to the user's account on the local filesystem

### Input sanitization

- Telegram usernames: sanitized to alphanumeric only
- Message content: wrapped in code blocks before injection (reduces parsing ambiguity)
- CLI commands: matched against strict whitelist (`/compact`, `/clear`, `/help`, etc.)
- Agent names in send-message.sh: validated against `^[a-z0-9_-]+$`

### BOT_TOKEN protection

`_telegram-curl.sh` wraps all curl calls in subshells with `set +x`, preventing the token from appearing in shell traces or logs.

### Permission model

Claude Code runs with `--dangerously-skip-permissions`. The Telegram-based permission hooks provide advisory oversight — the user can approve/deny from their phone. But this is at the hook level, not enforced by the CLI itself.

---

## 15. Skills System

Skills are markdown files with YAML frontmatter that provide contextual instructions to Claude.

### Structure

```
skills/{skill-name}/SKILL.md
```

Frontmatter fields:
- `name`: Skill identifier
- `description`: When to use this skill
- `user-invocable`: Set to `false` to exclude from Telegram command registration

### Core skills

1. **comms** — Explains message format, how to reply, priority handling
2. **cron-management** — Cron setup, persistence via config.json, troubleshooting

Skills exist both in `core/skills/` (shared) and `agents/agent-template/skills/` (copied to each agent). The agent-local copies ensure Claude can read them from its working directory.

---

## 16. Telegram Command Registration

`register-telegram-commands.sh` runs on agent startup:

1. Scans directories for skill/command files:
   - `.claude/commands/*.md`
   - `.claude/skills/*/SKILL.md`
   - `skills/*/SKILL.md`
2. Parses YAML frontmatter (name, description, user-invocable)
3. Sanitizes names for Telegram (lowercase, underscores, max 32 chars)
4. Deduplicates (first occurrence wins)
5. Registers via Telegram's `setMyCommands` API

This gives users autocomplete when typing `/` in the Telegram chat.

---

## 17. Configuration Reference

### `agents/{name}/config.json`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `agent_name` | string | - | Agent identifier |
| `enabled` | boolean | false | Whether agent should run |
| `startup_delay` | number | 0 | Seconds to wait before starting (stagger multiple agents) |
| `max_session_seconds` | number | 255600 (71h) | Session duration before auto-refresh |
| `model` | string | (none) | Model override (e.g., "claude-haiku-4-5-20251001") |
| `working_directory` | string | "" | Launch Claude in a different project directory |
| `crons` | array | [] | Recurring tasks to set up via `/loop` |

### `agents/{name}/.env`

| Variable | Required | Description |
|----------|----------|-------------|
| `BOT_TOKEN` | Yes | Telegram bot API token |
| `CHAT_ID` | Yes | Telegram chat ID to send messages to |
| `ALLOWED_USER` | Yes | Telegram user ID authorized to control this agent |

### `.env` (repo root)

| Variable | Default | Description |
|----------|---------|-------------|
| `CRM_INSTANCE_ID` | "default" | Instance namespace (supports multiple installs) |

### Environment variables (set by agent-wrapper.sh)

| Variable | Description |
|----------|-------------|
| `CRM_AGENT_NAME` | Current agent's name |
| `CRM_INSTANCE_ID` | Instance namespace |
| `CRM_ROOT` | Path to `~/.claude-remote/{instance}/` |
| `CRM_TEMPLATE_ROOT` | Path to the repo root |

---

## 18. Data Flow Diagrams

### User sends a Telegram message

```
User types "hello" in Telegram
    │
    ▼
Telegram servers store the update
    │
    ▼
fast-checker.sh calls check-telegram.sh
    │
    ▼
check-telegram.sh calls getUpdates API
    ├─ Filters by ALLOWED_USER
    ├─ Updates offset file
    └─ Returns JSON: {type:"message", text:"hello", from:"David", chat_id:12345}
    │
    ▼
fast-checker.sh formats it:
    "=== TELEGRAM from David (chat_id:12345) ===
     ```
     hello
     ```
     Reply using: bash ../../core/bus/send-telegram.sh 12345 \"<your reply>\""
    │
    ▼
inject_messages() writes to tmpfile → tmux load-buffer → paste-buffer → Enter
    │
    ▼
Claude Code receives the text as user input
    │
    ▼
Claude processes and calls: bash ../../core/bus/send-telegram.sh 12345 "Hi! How can I help?"
    │
    ▼
send-telegram.sh calls Telegram sendMessage API
    │
    ▼
User sees "Hi! How can I help?" in Telegram
```

### Permission request flow

```
Claude wants to run: bash rm -rf /tmp/old-files
    │
    ▼
Claude Code triggers PermissionRequest hook
    │
    ▼
hook-permission-telegram.sh starts (blocking)
    ├─ Reads tool_name=Bash, command="rm -rf /tmp/old-files"
    ├─ Generates unique_id=abc123
    ├─ Sends to Telegram: "PERMISSION REQUEST\nAgent: mybot\nTool: Bash\nCommand: rm -rf /tmp/old-files"
    │   with buttons: [Approve] [Deny]
    ├─ Creates response file path: /tmp/crm-hook-response-mybot-abc123.json
    └─ Begins polling every 2s for that file
    │
    ▼
User taps [Approve] in Telegram
    │
    ▼
Telegram sends callback_query with data="perm_allow_abc123"
    │
    ▼
fast-checker.sh receives it via check-telegram.sh
    ├─ Matches regex: perm_allow_abc123
    ├─ Writes {"decision":"allow"} to /tmp/crm-hook-response-mybot-abc123.json
    ├─ Answers callback query ("Got it")
    └─ Edits original message to say "Approved"
    │
    ▼
hook-permission-telegram.sh detects the file
    ├─ Reads decision: "allow"
    └─ Returns: {"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}
    │
    ▼
Claude Code proceeds with the bash command
```

### Inter-agent message flow

```
Agent A runs: bash ../../core/bus/send-message.sh agentB normal "can you review PR #42?"
    │
    ▼
send-message.sh creates:
    ~/.claude-remote/default/inbox/agentB/2-1711234567890-from-agentA-ab12c.json
    containing: {id, from:"agentA", to:"agentB", priority:"normal", text:"can you review PR #42?"}
    │
    ▼
Agent B's fast-checker runs check-inbox.sh
    ├─ Recovers any stale inflight messages (>5 min old)
    ├─ Acquires mkdir-based lock on inbox
    ├─ Moves message to inflight/
    └─ Returns JSON array with the message
    │
    ▼
fast-checker formats and injects into Agent B's tmux session:
    "=== AGENT MESSAGE from agentA [msg_id: 1711234567890-agentA-ab12c] ===
     ```
     can you review PR #42?
     ```
     Reply using: bash ../../core/bus/send-message.sh agentA normal '<reply>' 1711234567890-agentA-ab12c"
    │
    ▼
Agent B processes, reviews PR, replies:
    bash ../../core/bus/send-message.sh agentA normal "PR #42 looks good, approved" 1711234567890-agentA-ab12c
    │
    ▼
send-message.sh:
    ├─ Creates message in agentA's inbox
    └─ Auto-ACKs the original message (inflight → processed)
```

---

## 19. Extending the System

### Adding a new hook type

1. Create a new script in `core/bus/hook-{name}-telegram.sh`
2. Follow the pattern: read stdin JSON, send to Telegram, poll for response (if blocking)
3. Register in the agent template's `.claude/settings.json` under the appropriate event
4. For non-blocking hooks (like AskUserQuestion), use `PreToolUse` with a matcher

### Adding a new bus script

1. Create in `core/bus/`
2. Follow the environment resolution pattern (check `CRM_ROOT`, `CRM_TEMPLATE_ROOT`, etc.)
3. Source `_telegram-curl.sh` if you need Telegram API access
4. Source the agent's `.env` for credentials

### Adding a new skill

1. Create `skills/{name}/SKILL.md` in the agent template
2. Add YAML frontmatter with name, description
3. If it should be user-invocable, it will auto-register as a Telegram command
4. Reference it from CLAUDE.md if Claude should know about it

### Supporting a new chat platform (e.g., Discord, Slack)

You would need to:
1. Replace `check-telegram.sh` with a platform-specific poller
2. Replace `send-telegram.sh` with a platform-specific sender
3. Update the hook scripts to use the new platform's API
4. The rest of the system (tmux injection, inbox, crons) stays the same

### Adding Linux support

Replace the launchd layer:
1. Replace `generate-launchd.sh` with a systemd unit file generator
2. Replace `launchctl load/unload` commands with `systemctl enable/start/stop`
3. Update `stat -f %m` (macOS) to `stat -c %Y` (Linux) in check-inbox.sh
4. Everything else is POSIX-compatible bash

---

## 20. Building Your Own Version

If you want to build a similar system from scratch, here are the essential components and the minimum viable architecture:

### Core requirements

1. **A PTY provider** — tmux, screen, or any tool that provides a pseudo-terminal for Claude Code to run in
2. **A process manager** — launchd (macOS), systemd (Linux), or supervisord (cross-platform) to keep the agent alive
3. **A message poller** — Something that checks for new messages on your chosen platform and injects them into the PTY
4. **A hook bridge** — Scripts that Claude Code's hooks call, which forward decisions to your platform and relay responses back

### Minimum viable implementation

```bash
# 1. Start Claude in tmux
tmux new-session -d -s agent bash
tmux send-keys -t agent "claude --dangerously-skip-permissions 'You are a helpful agent'" Enter

# 2. Poll for messages and inject them
while true; do
    MSG=$(your_platform_check_messages)
    if [[ -n "$MSG" ]]; then
        tmpfile=$(mktemp)
        echo "$MSG" > "$tmpfile"
        tmux load-buffer -b agent "$tmpfile"
        tmux paste-buffer -t agent -b agent
        tmux send-keys -t agent Enter
        rm "$tmpfile"
    fi
    sleep 3
done
```

### What CRM adds on top of this

- **Crash recovery** with daily limits and rate-limit detection
- **Session refresh** to work around `/loop` expiry
- **Permission/plan/question hooks** forwarded to Telegram
- **Inter-agent messaging** with priority, ACKs, and stale recovery
- **Working directory override** with settings merging
- **Local customization** that survives git updates
- **Startup sequencing** (staggered delays, boot detection)
- **Graceful shutdown** on SIGTERM
- **Telegram command registration** from skills
- **Multi-instance support** for isolated deployments

### Key gotchas if building your own

1. **Claude Code needs a PTY** — Without one, it exits immediately. tmux or screen is mandatory for headless operation.
2. **`--dangerously-skip-permissions` is required** — There's no way to run Claude Code non-interactively without it.
3. **`/loop` crons expire after 72 hours** — You need a session refresh mechanism to recreate them.
4. **tmux send-keys has limits** — Use `load-buffer` + `paste-buffer` for reliable multi-line injection.
5. **Hooks are blocking** — `PermissionRequest` hooks must return a decision. If your remote approval takes too long, Claude stalls. Set appropriate timeouts.
6. **Conversation detection** — Claude Code stores conversations as `.jsonl` files in `~/.claude/projects/-{path-with-dashes}/`. Check for these to determine if `--continue` will work.
7. **Environment isolation** — launchd doesn't inherit your shell profile. You must explicitly set PATH in the plist or wrapper script to include the node, claude, and python3 binaries.

---

*This document covers every file, mechanism, and data flow in Claude Remote Manager as of the current version. For the latest changes, check the repository's git log.*
