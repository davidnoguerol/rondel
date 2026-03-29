# Rondel vs OpenClaw — Full System Audit

> Single prompt. Paste into a fresh chat. It will spawn 8 parallel research agents, collect their reports, and produce a unified verdict.

---

```
You are going to conduct a comprehensive audit comparing Rondel (our project) against OpenClaw (the reference architecture we draw patterns from). This audit covers every subsystem in our codebase.

## How to work

1. First, read these files to understand our project at a high level:
   - /Users/neo/projects/rondel/CLAUDE.md
   - /Users/neo/projects/rondel/ARCHITECTURE.md

2. Then spawn 8 parallel research agents (using the Agent tool), one for each subsystem below. Each agent should read the specified files for both Rondel and OpenClaw, then produce a detailed comparison report.

3. After ALL 8 agents return their reports, synthesize a single unified verdict that:
   - Ranks ALL findings by priority (critical → important → nice-to-have)
   - Groups them into: "fix now" (blocking production readiness), "build next" (high-leverage improvements), "defer" (good ideas we don't need yet)
   - Calls out the top 5 things Rondel does BETTER than OpenClaw (so we don't regress)
   - Identifies the top 10 gaps that would hurt us most if left unaddressed
   - Proposes a concrete 3-phase roadmap for closing the critical gaps

## Agent 1: Process Management & Lifecycle

Read Rondel:
- /Users/neo/projects/rondel/src/agent-process.ts
- /Users/neo/projects/rondel/src/subagent-process.ts
- /Users/neo/projects/rondel/src/agent-manager.ts
- /Users/neo/projects/rondel/src/types.ts
- /Users/neo/projects/rondel/CLI-REFERENCE.md

Read OpenClaw:
- /opt/homebrew/lib/node_modules/openclaw/docs/concepts/agent-loop.md
- /opt/homebrew/lib/node_modules/openclaw/docs/concepts/session-tool.md
- /opt/homebrew/lib/node_modules/openclaw/docs/concepts/queue.md
- /opt/homebrew/lib/node_modules/openclaw/dist/plugin-sdk/src/agents/ (all .d.ts files)
- /opt/homebrew/lib/node_modules/openclaw/dist/plugin-sdk/src/infra/restart.d.ts
- Search dist/ for files matching *orphan*, *recovery*, *lifecycle*, *heartbeat*

Compare:
- Process spawning (persistent vs ephemeral, per-conversation vs per-agent)
- State machines (agent states, transitions, what triggers each)
- Crash recovery (restart logic, backoff, rate limit detection, daily limits)
- Session continuity (--session-id, --resume, session persistence across restarts)
- Heartbeat / health monitoring
- Orphan recovery (in-flight work when gateway restarts)
- Concurrency control (OpenClaw's lane system — main lane, subagent lane, max concurrency)
- Graceful shutdown (drain in-flight work, signal handling, cleanup)

For each area: what OpenClaw does, what Rondel does, gap analysis, concrete recommendations with priority.

## Agent 2: Channel System & Message Routing

Read Rondel:
- /Users/neo/projects/rondel/src/channel.ts
- /Users/neo/projects/rondel/src/telegram.ts
- /Users/neo/projects/rondel/src/router.ts
- /Users/neo/projects/rondel/src/types.ts

Read OpenClaw:
- /opt/homebrew/lib/node_modules/openclaw/docs/channels/ (ALL files)
- /opt/homebrew/lib/node_modules/openclaw/docs/concepts/queue.md
- /opt/homebrew/lib/node_modules/openclaw/docs/gateway/configuration-reference.md
- /opt/homebrew/lib/node_modules/openclaw/dist/plugin-sdk/src/channels/ (all .d.ts files)
- /opt/homebrew/lib/node_modules/openclaw/dist/plugin-sdk/src/config/types.channels.d.ts
- /opt/homebrew/lib/node_modules/openclaw/dist/plugin-sdk/src/config/types.bindings.d.ts
- Search dist/ for files matching *telegram*, *outbound*, *chunker*, *delivery*

Compare:
- Channel adapter interface (our ChannelAdapter vs their ChannelPlugin with ~15 composable adapters)
- Message normalization (our ChannelMessage vs their MsgContext)
- Routing / bindings (our bot-token-based routing vs their binding rules)
- Outbound delivery (chunking, markdown fallback, retry, delivery confirmation)
- Multi-account management
- Security (our allowedUsers vs their DM allowlist + pairing flow + command authorization)
- Message queue (our per-conversation queue vs their lane-aware FIFO with followup modes)
- Typing indicators, status messages, inline keyboards, callback queries

## Agent 3: Subagent System & Task Delegation

Read Rondel:
- /Users/neo/projects/rondel/src/subagent-process.ts
- /Users/neo/projects/rondel/src/agent-manager.ts
- /Users/neo/projects/rondel/src/hooks.ts
- /Users/neo/projects/rondel/src/index.ts
- /Users/neo/projects/rondel/src/mcp-server.ts
- /Users/neo/projects/rondel/src/bridge.ts
- /Users/neo/projects/rondel/src/router.ts (the sendOrQueue method)

Read OpenClaw:
- /opt/homebrew/lib/node_modules/openclaw/docs/tools/subagents.md
- /opt/homebrew/lib/node_modules/openclaw/docs/concepts/session-tool.md
- /opt/homebrew/lib/node_modules/openclaw/dist/plugin-sdk/src/agents/ (all .d.ts files)
- /opt/homebrew/lib/node_modules/openclaw/dist/plugin-sdk/src/agents/tools/ (all .d.ts files)
- Search dist/ for files matching *subagent*, *announce*, *spawn*, *delivery*, *orphan*

Compare:
- Spawn mechanics, async model, result delivery
- What happens when parent is busy (our queue vs their retry + followup modes)
- Subagent registry (our in-memory Map vs their persistent registry with orphan recovery)
- Templates, budget control, nested subagents
- ANNOUNCE_SKIP pattern, idempotency, progress reporting
- Tool availability in subagents

## Agent 4: Scheduling & Automation

Read Rondel:
- /Users/neo/projects/rondel/src/scheduler.ts
- /Users/neo/projects/rondel/src/types.ts
- /Users/neo/projects/rondel/src/agent-manager.ts
- /Users/neo/projects/rondel/src/hooks.ts
- /Users/neo/projects/rondel/src/index.ts

Read OpenClaw:
- /opt/homebrew/lib/node_modules/openclaw/docs/automation/cron-jobs.md
- /opt/homebrew/lib/node_modules/openclaw/docs/automation/ (ALL files)
- /opt/homebrew/lib/node_modules/openclaw/dist/plugin-sdk/src/cron/ (ALL .d.ts files)
- /opt/homebrew/lib/node_modules/openclaw/dist/plugin-sdk/src/config/types.cron.d.ts
- Search dist/ for files matching *heartbeat*, *schedule*, *timer*

Compare:
- Schedule types, session targets, delivery modes, payload types
- Heartbeat system, wake modes
- Error handling (our backoff vs their transient/permanent classification)
- State persistence, run history, config hot-reload
- Runtime job management, failure alerts, session retention
- Concurrent job execution, missed job recovery

## Agent 5: Tool System, MCP & Bridge

Read Rondel:
- /Users/neo/projects/rondel/src/mcp-server.ts
- /Users/neo/projects/rondel/src/bridge.ts
- /Users/neo/projects/rondel/src/agent-process.ts (MCP config, FRAMEWORK_DISALLOWED_TOOLS)
- /Users/neo/projects/rondel/src/agent-manager.ts (MCP config assembly)
- /Users/neo/projects/rondel/src/types.ts

Read OpenClaw:
- /opt/homebrew/lib/node_modules/openclaw/docs/tools/ (ALL files)
- /opt/homebrew/lib/node_modules/openclaw/dist/plugin-sdk/src/agents/tools/ (ALL .d.ts files)
- /opt/homebrew/lib/node_modules/openclaw/dist/plugin-sdk/src/config/types.mcp.d.ts
- /opt/homebrew/lib/node_modules/openclaw/dist/plugin-sdk/src/config/types.tools.d.ts
- Search docs/ for MCP, tools, sandbox, tool profiles

Compare:
- Tool injection (our MCP separate process vs their native registration)
- Bridge architecture, tool profiles, sandbox mode
- Per-agent tool config, framework-disallowed tools
- MCP config lifecycle, tool result size limits
- Tool execution hooks, gap between our 8 tools and their full suite

## Agent 6: Configuration, State & Resilience

Read Rondel:
- /Users/neo/projects/rondel/src/config.ts
- /Users/neo/projects/rondel/src/context-assembler.ts
- /Users/neo/projects/rondel/src/logger.ts
- /Users/neo/projects/rondel/src/hooks.ts
- /Users/neo/projects/rondel/src/types.ts
- /Users/neo/projects/rondel/src/scheduler.ts (hot-reload parts)
- /Users/neo/projects/rondel/rondel.config.json

Read OpenClaw:
- /opt/homebrew/lib/node_modules/openclaw/docs/gateway/ (ALL files)
- /opt/homebrew/lib/node_modules/openclaw/docs/concepts/ (ALL files)
- /opt/homebrew/lib/node_modules/openclaw/dist/plugin-sdk/src/config/ (ALL .d.ts files)
- /opt/homebrew/lib/node_modules/openclaw/dist/plugin-sdk/src/infra/ (ALL .d.ts files)
- Search docs/ for *hot-reload*, *secrets*, *credentials*, *validation*, *error*, *logging*, *transcript*

Compare:
- Config loading, validation, hot-reload
- Secrets management, state persistence, session persistence
- Structured logging, error classification
- Context engine, file operations (atomic writes), lock-based concurrency
- Signal handling, plugin system

## Agent 7: Hook System & Cross-Cutting Concerns

Read Rondel:
- /Users/neo/projects/rondel/src/hooks.ts
- /Users/neo/projects/rondel/src/index.ts (hook listener wiring)
- /Users/neo/projects/rondel/src/agent-manager.ts (hook emission)
- /Users/neo/projects/rondel/src/scheduler.ts (hook emission)

Read OpenClaw:
- /opt/homebrew/lib/node_modules/openclaw/docs/automation/ (ALL files)
- /opt/homebrew/lib/node_modules/openclaw/dist/plugin-sdk/src/config/types.hooks.d.ts
- Search docs/ for *hook*, *lifecycle*, *event*, *subscriber*
- Search dist/plugin-sdk/ for *hook* in filenames and type definitions

Compare:
- Hook inventory (our 5 hooks vs their ~25)
- Hook execution modes (fire-and-forget/parallel vs sequential/modifying)
- Hook registration (our hardcoded index.ts vs their plugin-based registerHook)
- Internal vs external hooks
- Missing hook categories: model/LLM, message, session, tool, compaction, dispatch
- Which hooks would give us the most leverage?
- Hook composition patterns, error handling in hooks

## Agent 8: Session Persistence & Conversation History

Read Rondel:
- /Users/neo/projects/rondel/src/transcript.ts
- /Users/neo/projects/rondel/src/agent-process.ts (session-aware spawn, transcript capture, resume failure detection)
- /Users/neo/projects/rondel/src/subagent-process.ts (transcript capture)
- /Users/neo/projects/rondel/src/agent-manager.ts (session index lifecycle, transcript creation, resetSession)
- /Users/neo/projects/rondel/src/router.ts (/new command)
- /Users/neo/projects/rondel/src/types.ts (SessionEntry, SessionIndex, Transcript types)
- /Users/neo/projects/rondel/src/index.ts (session loading on startup, persistence on shutdown)

Read OpenClaw:
- /opt/homebrew/lib/node_modules/openclaw/docs/concepts/session-tool.md
- /opt/homebrew/lib/node_modules/openclaw/docs/gateway/configuration-reference.md (session.* config section)
- /opt/homebrew/lib/node_modules/openclaw/dist/plugin-sdk/src/config/sessions/ (ALL .d.ts files)
- /opt/homebrew/lib/node_modules/openclaw/dist/plugin-sdk/src/config/types.session.d.ts
- /opt/homebrew/lib/node_modules/openclaw/dist/plugin-sdk/src/agents/ (session initialization, context engine)
- Search docs/ for *session*, *transcript*, *compaction*, *memory*, *reset*, *maintenance*
- Search dist/ for files matching *session-store*, *transcript*, *context-engine*, *compaction*

Compare:
- Session store format, ID generation, key routing, resume mechanism
- Session reset (our /new vs their daily/idle/per-type/per-channel resets)
- Resume failure handling
- Transcript format, what gets captured, location, subagent/cron transcripts
- Session maintenance & cleanup (pruning, retention, stale detection)
- Context engine & compaction (our two-layer concat vs their pluggable ContextEngine)
- Auto-compaction, token tracking
- Long-term memory & search (our JSONL on disk vs their SQLite + FTS + embeddings)
- Session metadata richness (our 5 fields vs their ~40+ fields)
- Focus on: what gaps are critical for production reliability, what unlocks the most powerful agent capabilities, what can we defer vs what will be painful to retrofit

## Instructions for each agent

- Be specific — reference file paths and line numbers
- Don't be vague — concrete findings only
- For each area produce: what OpenClaw does, what Rondel does, gap analysis, recommendation with priority (critical / important / nice-to-have)
- Note things Rondel does BETTER than OpenClaw (simpler, cleaner, more appropriate for our architecture)

## Final synthesis

After all 8 agents return, produce the unified verdict:

1. **Top 5 Rondel advantages** — things we do better, don't regress on these
2. **Top 10 critical gaps** — ranked by impact, with concrete fix descriptions
3. **Loose ends** — edge cases, unhandled states, missing error paths discovered across all reports
4. **3-phase roadmap**:
   - Phase A: "Fix now" — blocking production readiness
   - Phase B: "Build next" — high-leverage improvements
   - Phase C: "Defer" — good ideas we don't need yet
5. **CLAUDE.md recommendations** — any patterns or conventions that should be added based on findings
6. **Architecture debt** — structural issues that will get harder to fix as we add features
```
