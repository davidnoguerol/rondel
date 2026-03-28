# FlowClaw — Next Increment Proposal

## 1. Understand the Project (read in order)

1. `/Users/neo/projects/flowclaw/CLAUDE.md` — coding standards, key concepts, project direction
2. `/Users/neo/projects/flowclaw/ARCHITECTURE.md` — current architecture as built

## 2. Where We Are

| Phase | Status | What |
|-------|--------|------|
| 0 | Done | Single agent, single bot, core loop |
| 1 | Done | Multi-agent, TelegramAdapter (multi-account), per-conversation process spawning |
| 1.5 | Done | MCP tool injection (send_telegram, send_telegram_photo, per-agent MCP config) |
| 2 | Done | HTTP bridge (list_agents, agent_status) on localhost |
| 2.5 | Done | Subagent spawning + lifecycle hooks + result delivery + templates |
| 3 | Done | Cron scheduler (3-way separation, backoff, hot-reload, missed job recovery) |
| 3.5 | Done | Session persistence (session index + JSONL transcripts + --resume + /new) |
| 4 | Done | Decomposed agent-manager into ConversationManager + SubagentManager + CronRunner |
| 4.1 | Done | Hardening (atomic writes, PID lock, error boundaries, queue cap, crash backoff) |
| 5 | Done | Context bootstrap (6-file system + BOOTSTRAP.md) + agent memory via MCP tools |
| 6 | Done | CLI (init, add agent, status, doctor) + single installation model (~/.flowclaw/) + agent auto-discovery + typing indicator lifecycle + onboarding UX (verification code, BOOTSTRAP.md first-run ritual) |
| 7 | Done | Daemonization + OS service integration (launchd/systemd/schtasks). .env auto-loading, dual-transport logger, service-aware stop/restart. No user-facing `start` — service is the only run mode, `npm start` for dev only |

## 3. Settled Decisions (don't re-propose)

- Bot token IS the routing — each agent gets its own Telegram bot, no chat IDs or bindings
- Processes spawn per conversation, not per agent — agent config is a template
- MCP is our only tool injection path (we don't control the Claude CLI runtime)
- MCP server calls Telegram API directly for Telegram tools (no bridge needed)
- MCP server calls HTTP bridge for FlowClaw state queries, subagent lifecycle, and memory
- Per-agent MCP config diverges from OpenClaw's global model (agents have different roles/tools)
- Node `http` module for the bridge, not NestJS — Fastify is the upgrade path when needed
- No Swagger -> MCP codegen — shared TypeScript types instead, revisit at ~15+ tools
- Bridge is localhost-only, no auth — same-machine, same-user IPC
- Async subagent spawning with push-based result delivery (OpenClaw model)
- Lifecycle hooks (typed EventEmitter with per-listener error boundary) for cross-cutting concerns
- Framework always disallows built-in `Agent` tool — in both AgentProcess and SubagentProcess
- Subagent templates in `templates/` — optional blueprints, any agent can use any template
- Three-way separation for cron jobs (session target / payload / delivery) — adopted from OpenClaw
- Cron runs reuse SubagentProcess — no new process abstraction
- Config hot-reload for cron jobs via `fs.watch` with 300ms debounce — no restart needed
- Backoff schedule from OpenClaw: [30s, 1m, 5m, 15m, 60m] on consecutive cron errors
- Crash restart backoff: [5s, 15s, 30s, 60s, 2m] — escalating, /restart overrides immediately
- Session index invariant: entry exists = CLI has a resumable session on disk. `/new` deletes the entry.
- Transcripts are append-only JSONL with raw stream-json events — no transformation, maximum fidelity
- `stop()` sets state to "stopped" before SIGTERM so `handleExit()` skips crash recovery
- Atomic writes (write-to-temp + rename) for all JSON state files — never bare writeFile()
- PID lockfile singleton guard — prevents two instances corrupting shared state
- Queue cap (50/conversation) — backpressure instead of unbounded memory growth
- Agent-manager decomposed into facade + ConversationManager + SubagentManager + CronRunner
- Context bootstrap: 6-file system (AGENT.md + SOUL.md + IDENTITY.md + USER.md + MEMORY.md + BOOTSTRAP.md) with SYSTEM.md fallback
- Agent memory: MEMORY.md per agent, read/write via MCP tools, included in main session system prompt only (stripped from subagent/cron)
- Single installation at `~/.flowclaw/` (override with FLOWCLAW_HOME) — not per-project
- Agent auto-discovery: recursive scan of `workspaces/` for `agent.json` files — no agent list in config
- `workspaces/` is user-organized, git-committed content; `state/` is runtime ephemera
- Templates at `~/.flowclaw/templates/`, not inside workspaces — framework-level subagent blueprints
- Scaffold reads from `templates/context/` with `{{agentName}}` substitution — single source of truth, no hardcoded prompts
- Typing indicator lifecycle: `startTypingIndicator`/`stopTypingIndicator` on ChannelAdapter interface, TelegramAdapter refreshes every 4s
- Verification code for user discovery during init — drain pending updates after to prevent stale messages reaching agent
- Templates (SOUL.md, IDENTITY.md, USER.md, BOOTSTRAP.md) identical to OpenClaw; AGENT.md adapted (see DEVLOG for detailed changelog)
- OS service is the only user-facing run mode — no `flowclaw start` command. `npm start` for development only
- `FLOWCLAW_DAEMON=1` env var triggers file logging — set by service manifests (plist/unit/PowerShell wrapper)
- .env auto-loaded at top of `startOrchestrator()` before config resolution — critical for service context
- Service-aware stop: uses service manager (launchctl/systemctl/taskkill) when service is installed
- Platform backends: launchd (macOS), systemd (Linux), Task Scheduler + PowerShell restart wrapper (Windows)

## 4. Reference (read only if needed for your proposal)

These files are large. Read in chunks. Only pull what's relevant to the increment you're proposing.

- `/Users/neo/projects/flowclaw/DEVLOG.md` — decision history, what worked, what didn't
- `/Users/neo/projects/flowclaw/FLOWCLAW-PLAN.md` — north star vision (not a spec)
- `/Users/neo/projects/flowclaw/docs/CLI-REFERENCE.md` — Claude CLI flags and protocols
- `/Users/neo/projects/flowclaw/docs/openclaw/openclaw-core-architecture.md` — OpenClaw reference patterns
- `/Users/neo/projects/flowclaw/docs/openclaw/OPENCLAW-INDEX.md` — comprehensive index of all OpenClaw source locations

## 5. Task

Follow these steps in order. Do NOT skip ahead.

### Step 1: Propose the next increment

Propose the next increment to the user.

NOTE: Check DEVLOG.md Future Considerations for pending items. Consider what unlocks the most value with the least complexity.

Constraints:

- Same philosophy as Phase 0-7: minimal, validate, then improve
- Consider what unlocks the most value with the least complexity
- List exact files to create/modify
- Define "done" (what proves it works)
- Note any deviations from the plan
- **DO NOT update DEVLOG.md yet** — present the proposal to the user first and wait for approval

### Step 2: Wait for approval

Present the proposal and ask the user if they approve. Do not proceed until the user says yes.

### Step 3: Investigate OpenClaw reference

After the user approves the increment:

1. Read `/Users/neo/projects/flowclaw/docs/openclaw/OPENCLAW-INDEX.md` to find how OpenClaw solves the same problem
2. Read the relevant OpenClaw source files identified in the index
3. Present findings to the user: "Here's how OpenClaw solves this, and here's what it means for FlowClaw"
4. Identify patterns to adopt, adapt, or skip — with reasoning

### Step 4: Update DEVLOG.md

Only after the OpenClaw investigation is reviewed by the user, update DEVLOG.md with the full proposal (including OpenClaw findings and any adjustments based on the investigation).

### Step 5: Build

Implement the approved increment.
