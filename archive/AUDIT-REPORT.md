# FlowClaw vs OpenClaw: Comprehensive Audit Verdict

> Generated 2026-03-28. Covers every subsystem in the FlowClaw codebase compared against OpenClaw (the reference architecture).

---

## Top 5 FlowClaw Advantages (Don't Regress)

**1. Per-conversation process isolation.** Each `(agentName, chatId)` gets its own Claude CLI process and MCP server. A crash or resource leak in one conversation cannot affect others. OpenClaw multiplexes everything in a single Gateway process. This is FlowClaw's strongest architectural differentiator.

**2. Explicit state machine with resume failure detection.** `AgentState` is a proper typed union with clear transitions. The `RESUME_FAILURE_WINDOW_MS` heuristic for detecting failed `--resume` and gracefully falling back to a fresh session is a novel resilience pattern OpenClaw doesn't have. The daily crash limit with halt is a clean safety valve.

**3. Template-based subagent context.** FlowClaw's `templates/` directory gives subagents purpose-built system prompts from scratch, while OpenClaw inherits-and-strips parent context. FlowClaw's approach is cleaner, avoids context leakage, and includes `maxTurns` (which OpenClaw lacks).

**4. Clean `sendOrQueue` pattern with typed DI hooks.** The one-writer-per-conversation invariant is enforced at a single clear boundary (the Router). `FlowclawHooks` uses compile-time typed events with `readonly` payloads and dependency injection -- more testable and type-safe than OpenClaw's global singleton hook registry.

**5. Config-driven cron with file-watch hot-reload.** Cron jobs co-located in `agent.json` are simpler than OpenClaw's separate CRUD store. `fs.watch()` with debounce is more natural for a file-based system. ProjectId-scoped state provides multi-project isolation by default.

---

## Top 10 Critical Gaps

| # | Gap | Subsystem | Impact if Unaddressed |
|---|-----|-----------|----------------------|
| 1 | **No atomic writes or file locking** for `sessions.json` / `cron-state.json` | Config & State | Data corruption on crash or concurrent write -- silent data loss |
| 2 | **No singleton instance guard** -- two FlowClaw instances on same project corrupt shared state | Config & State | Undetectable state corruption |
| 3 | **Hook `emit()` has no error boundary** -- a throwing listener crashes the emitter module | Hooks | Violates stated CLAUDE.md invariant; can crash the entire system |
| 4 | **Subagent registry is in-memory only** -- all tracking lost on restart, orphaned work unrecoverable | Subagents | Wasted API cost, silent result loss, no post-restart recovery |
| 5 | **No outbound delivery retry** -- failed Telegram `sendMessage` permanently loses the response | Channels | User never sees agent's answer; no indication of failure |
| 6 | **Infinite subagent recursion possible** -- subagents can spawn subagents without depth tracking | Tools/MCP | Runaway API spend, process exhaustion |
| 7 | **No exponential backoff on crash restart** -- fixed 5s delay causes rapid restart loops | Process Mgmt | Burns API credits on persistent failures |
| 8 | **No session maintenance** -- sessions and transcripts grow unbounded forever | Sessions | Disk exhaustion over weeks/months of operation |
| 9 | **No workspace-based agent memory** -- agents lose all knowledge on session reset/compaction | Sessions | Agents cannot learn or remember across sessions |
| 10 | **No schema-based config validation** -- typos and invalid types pass silently at load time | Config | Runtime crashes from misconfiguration that should be caught at startup |

---

## Loose Ends (Edge Cases & Unhandled States)

- **Bridge JSON parse bug**: Malformed POST body causes silent HTTP hang (no response sent, client blocks forever) -- `bridge.ts`
- **Missing parent in `sendOrQueue`**: If parent process died/restarted, subagent result delivery silently fails with a log warning
- **`FRAMEWORK_DISALLOWED_TOOLS` not applied to subagents**: SubagentProcess doesn't strip the built-in `Agent` tool -- subagents bypass FlowClaw's delegation system
- **`persistSessionIndex()` errors swallowed**: Empty `.catch(() => {})` hides session data loss
- **No stalled-process watchdog**: A `busy` process producing no stdout for hours goes undetected
- **No typing indicator refresh**: Telegram typing expires after ~5s; long agent turns show no activity
- **Queue is unbounded**: No cap on queued messages per conversation -- memory grows without limit under message flood
- **Orphaned MCP temp files**: If FlowClaw crashes, `/tmp/flowclaw-mcp/` files are never cleaned up
- **No channel prefix in session keys**: Adding a second channel adapter will cause `chatId` namespace collisions
- **Cron alert spam**: No cooldown on failure notifications -- a job failing every 30s sends a Telegram message every 30s
- **Named cron sessions never pruned**: `session:<name>` conversations accumulate context forever with no retention policy

---

## 3-Phase Roadmap

### Phase A: "Fix Now" -- Blocking Production Readiness

These are correctness and data integrity issues. Ship nothing to real users without these.

| # | Item | Files Affected | Effort |
|---|------|---------------|--------|
| A1 | **Atomic writes** -- write-to-temp + rename for all JSON state files | New utility + `agent-manager.ts`, `scheduler.ts` | S |
| A2 | **File locking** -- advisory lockfile for `sessions.json`, `cron-state.json` | New utility + same files | S |
| A3 | **Singleton instance guard** -- PID lockfile at `~/.flowclaw/{projectId}/flowclaw.lock` | `index.ts` | S |
| A4 | **Error boundary on `FlowclawHooks.emit()`** -- wrap each listener in try/catch | `hooks.ts` | S |
| A5 | **Fix bridge JSON parse bug** -- return 400 on malformed body | `bridge.ts` | S |
| A6 | **Outbound delivery retry** -- retry with backoff for 429/5xx on Telegram sends | `telegram.ts` | M |
| A7 | **Exponential backoff on crash restart** -- 5s -> 10s -> 30s -> 60s, reset on successful turn | `agent-process.ts` | S |
| A8 | **Spawn depth tracking** -- add `FLOWCLAW_SPAWN_DEPTH` env var, strip spawn tools at depth >= 1 | `mcp-server.ts`, `agent-manager.ts` | M |
| A9 | **Apply `FRAMEWORK_DISALLOWED_TOOLS` to subagents** | `subagent-process.ts` | S |
| A10 | **Schema-based config validation** -- Zod schemas for `FlowclawConfig` and `AgentConfig` | `config.ts` | M |
| A11 | **Graceful shutdown with drain timeout** -- wait up to 30s for busy agents before force kill | `index.ts` | S |
| A12 | **Queue cap** -- max 20 messages per conversation, drop oldest with notification | `router.ts` | S |

### Phase B: "Build Next" -- High-Leverage Improvements

These unlock significant capability or observability. Build after Phase A stabilizes.

| # | Item | Files Affected | Effort |
|---|------|---------------|--------|
| B1 | **Persist subagent registry to disk** with orphan detection on startup | `agent-manager.ts`, new state file | M |
| B2 | **Workspace-based agent memory** -- `memory/` per agent, `MEMORY.md` in system prompt | `context-assembler.ts`, agent workspace | M |
| B3 | **Session maintenance** -- stale pruning, transcript retention, idle/daily reset options | `agent-manager.ts`, `scheduler.ts` | M |
| B4 | **Token/cost tracking in session index** -- parse from `result` events, accumulate per session | `agent-process.ts`, `types.ts` | S |
| B5 | **Add `message:received` and `message:sending` hooks** | `hooks.ts`, `router.ts`, `telegram.ts` | S |
| B6 | **Add `session:start` / `session:reset` hooks** | `hooks.ts`, `agent-manager.ts` | S |
| B7 | **Composite session keys with channel prefix** (`telegram:dm:12345`) | `agent-manager.ts`, `types.ts` | M |
| B8 | **Cron expression schedules** with timezone support (use `croner`) | `scheduler.ts`, `types.ts` | M |
| B9 | **One-shot (`at`) schedule kind** with auto-delete | `scheduler.ts`, `types.ts` | M |
| B10 | **File-based logging** -- JSONL to `~/.flowclaw/{projectId}/logs/` | `logger.ts` | M |
| B11 | **Typing indicator lease** -- auto-refresh every 5s while agent is busy | `telegram.ts`, `router.ts` | S |
| B12 | **Subagent concurrency limits** -- `maxConcurrent` (global) + `maxChildrenPerAgent` (per parent) | `agent-manager.ts` | S |
| B13 | **Per-agent `allowedUsers`** instead of global-only | `types.ts`, `telegram.ts` | S |
| B14 | **Alert threshold and cooldown** for cron failure notifications | `scheduler.ts`, `types.ts` | S |
| B15 | **Message coalescing** -- combine queued messages into single turn on drain | `router.ts` | M |
| B16 | **Per-job cron run history** -- append-only JSONL with auto-pruning | `scheduler.ts` | M |
| B17 | **Stalled-process watchdog** -- kill and restart if no stdout for N minutes | `agent-process.ts` | S |
| B18 | **Reusable `BackoffPolicy` utility** -- extract from scheduler for cross-cutting use | New module | S |
| B19 | **Tool result size limits** on bridge responses (truncate at 50K chars) | `bridge.ts` | S |

### Phase C: "Defer" -- Good Ideas We Don't Need Yet

| Item | Reason to Defer |
|------|----------------|
| Full plugin/extension SDK | No external plugin consumers exist yet |
| Docker sandboxing | Single-user system; per-process isolation suffices |
| Vector search / embeddings for memory | Start with keyword search; add when it proves insufficient |
| Full ContextEngine abstraction | Fights the CLI-based architecture; Claude CLI owns context |
| Tool loop detection | Per-conversation isolation limits blast radius |
| Channel plugin registry | Only one channel exists; interface seam is sufficient |
| OpenClaw-style binding rules engine | 1:1 agent-to-bot model is simpler and correct for now |
| Heartbeat system with HEARTBEAT.md | Requires architectural decisions about "main session" concept |
| `steer` queue mode (inject into running turn) | Requires streaming support not yet built |
| External webhook ingress | Agents interact via MCP tools, not inbound webhooks |
| Session identity linking across channels | No multi-channel yet |
| Pre-compaction memory flush | Blocked by lack of compaction visibility from CLI |
| ANNOUNCE_SKIP pattern | Subagents are task-oriented; suppression not needed yet |

---

## CLAUDE.md Recommendations

Based on audit findings, add these conventions:

1. **Under "Patterns to Follow"**: *All JSON state file writes must use atomic write (write-to-temp + rename). Never `writeFile` directly to a state file.*

2. **Under "Error Handling Patterns"**: *Hook listeners must be wrapped in error boundaries at the emit site. Use the safe `emit()` override in `FlowclawHooks` -- never raw `EventEmitter.emit()` for hooks.*

3. **Under "Lifecycle and State"**: *Every new state file needs: (a) atomic writes, (b) advisory file locking if multi-writer is possible, (c) a documented retention/pruning strategy in ARCHITECTURE.md.*

4. **Under "What to Avoid"**: *Never pass unbounded data through the bridge or inject unbounded text into agent context. All bridge responses and subagent result deliveries must respect size limits.*

5. **Under "Patterns to Follow"**: *Subagent processes must always apply `FRAMEWORK_DISALLOWED_TOOLS` and spawn-depth restrictions. The MCP server must check `FLOWCLAW_SPAWN_DEPTH` and strip delegation tools at the configured max depth.*

---

## Architecture Debt -- Gets Harder to Fix Over Time

| Debt | Why It Gets Worse | When to Fix |
|------|-------------------|-------------|
| **Session keys lack channel prefix** | Every new channel adapter, session migration, and routing rule will assume the current `agentName:chatId` format. Retrofitting requires migrating `sessions.json` and all transcripts. | Before adding any second channel |
| **No message provenance in transcripts** | As more sources inject messages (subagents, cron, inter-agent, webhooks), it becomes impossible to distinguish user intent from system injections. Every consumer of transcripts will need retroactive classification. | Before the second injection source beyond subagents |
| **Hardcoded hook wiring in `index.ts`** | Every new hook adds lines to `main()`. At ~15 hooks this becomes a maintenance burden. Extracting later requires untangling dependency order. | Before adding more than 3 new hooks |
| **No entry IDs in transcripts** | Future features (compaction targeting, message referencing, undo, branching) all need stable entry IDs. Adding them later creates a format break in existing JSONL files. | Before transcripts are relied on for anything beyond debugging |
| **Global `allowedUsers` only** | Per-agent access control becomes a migration when agents have different security requirements. Every new agent inherits the global set. | Before deploying agents with different trust boundaries |
| **MCP server is a monolith** | All 8 tools in one file. As tools grow (inter-agent messaging, cron management, memory search), this becomes unmaintainable. No way for users to add custom tools. | Before adding more than 3 new MCP tools |

---

## Detailed Subsystem Reports

### 1. Process Management & Lifecycle

#### Process Spawning

**OpenClaw**: Runs an embedded pi-agent-core runtime inside its gateway process. Agent runs are function calls, not child processes. All runs are per-session-key, not per-process.

**FlowClaw**: Spawns external `claude` CLI child processes via `child_process.spawn()`. Two distinct types: `AgentProcess` (persistent, per-conversation) and `SubagentProcess` (ephemeral, single task). Per-conversation isolation is a stated correctness invariant.

**Verdict**: Intentional architectural difference. FlowClaw's approach trades startup cost and resource overhead for stronger isolation. No action needed -- document the expected process count ceiling.

#### State Machine

**OpenClaw**: Event-stream based lifecycle, no formal state machine. Uses lifecycle stream events and session metadata. Subagents have rich terminal states.

**FlowClaw**: Explicit `AgentState` union: `starting -> idle <-> busy`, with `crashed`, `halted`, `stopped`. SubagentProcess: `running -> completed | failed | killed | timeout`.

**Gaps**:
- No `rate_limited` state -- `api_retry` events from stdout are not parsed (Important)
- No `aborting` transitional state for graceful shutdown (Nice-to-have)

**FlowClaw advantage**: Explicit typed state machine is more transparent and testable than OpenClaw's implicit lifecycle tracking.

#### Crash Recovery

| Feature | OpenClaw | FlowClaw |
|---------|----------|----------|
| Restart coordination | SIGUSR1 with coalescing + cooldown | Direct SIGTERM + setTimeout |
| Drain before restart | `deferGatewayRestartUntilIdle()` | None |
| Backoff strategy | Exponential (5s->10s->30s->60s) | Fixed 5s delay |
| Stalled process detection | CLI watchdog with timeouts | None |
| Daily crash limit | N/A (in-process) | 5/day, then halt |
| Resume failure fallback | N/A (embedded) | Yes -- graceful degradation |

**Recommendations**:
1. Add exponential backoff (Critical)
2. Add stalled-process watchdog (Important)
3. Parse `api_retry` events for rate limit awareness (Important)

#### Session Continuity

**FlowClaw**: Two-layer persistence (session index + transcripts). Clean separation of session identity from session state. `sessionEstablished` event confirms/updates session IDs. Resume failure detection with fresh-session fallback.

**Gaps**: No session metadata (tokens, cost), no cross-session messaging, no queryable session history.

**Recommendations**: Add session metadata tracking (Important), `--continue` fallback (Nice-to-have).

#### Heartbeat / Health Monitoring

**OpenClaw**: Full heartbeat system with configurable interval, HEARTBEAT.md, smart skipping, wake system, visibility control.

**FlowClaw**: No heartbeat or health monitoring. Only health signal is the state machine.

**Recommendations**: Add basic liveness check for idle processes (Important), defer full heartbeat system (Nice-to-have).

#### Orphan Recovery

**OpenClaw**: Dedicated orphan recovery with post-restart scan, synthetic resume messages, exponential backoff retries.

**FlowClaw**: No orphan recovery. Running subagents are killed on restart, results never delivered, queued messages lost.

**Recommendations**:
1. Persist subagent registry to disk (Critical)
2. Persist message queue (Important)
3. Emit `subagent:failed` with `gateway_shutdown` reason before killing (Critical)

#### Concurrency Control

**OpenClaw**: Lane-aware FIFO queue with configurable concurrency per lane, queue modes (collect/steer/followup/interrupt), debounce, cap, overflow policy.

**FlowClaw**: Per-conversation state machine + simple FIFO queue. `sendOrQueue` pattern. No global concurrency cap, no debouncing, no coalescing.

**FlowClaw advantage**: Dramatically simpler while preserving the critical invariant (one writer per conversation).

**Recommendations**: Queue cap (Important), global concurrency limit (Important), collect mode (Nice-to-have).

#### Graceful Shutdown

**OpenClaw**: SIGUSR1 restart with drain-before-restart, max wait timeout, abort propagation, stale PID detection.

**FlowClaw**: `SIGINT`/`SIGTERM` handlers call `shutdown()` which stops adapter, scheduler, bridge, kills all processes, persists session index, exits.

**Gaps**: No drain timeout (kills busy agents immediately), no queue persistence, no user notification, no orphan detection on startup.

**Recommendations**: Drain timeout (Critical), orphan detection on startup (Important), queue persistence (Nice-to-have).

---

### 2. Channel System & Message Routing

#### Channel Adapter Interface

**OpenClaw**: Plugin-based with `ChannelPlugin`, 25+ channels, ~15 composable sub-adapters per channel, plugin registry.

**FlowClaw**: Clean minimal `ChannelAdapter` interface with one implementation (`TelegramAdapter`). Multi-account via `Map<string, TelegramAccount>`.

**Recommendations**: Split outbound delivery into separate concern (Important), add `sendMedia` to interface (Important), defer plugin registry (Nice-to-have).

#### Message Normalization

**OpenClaw**: Rich `MsgContext` with chat type, reply context, media, mentions, location, threads, sender label.

**FlowClaw**: Minimal `ChannelMessage` with 6 fields: `accountId`, `chatId`, `senderId`, `senderName`, `text`, `messageId`.

**Recommendations**: Add `channelType` and `chatType` (Important), add `replyToMessageId` (Important), add optional media fields (Important).

#### Routing / Bindings

**OpenClaw**: 8-level priority cascade with declarative binding rules, broadcast groups, stateful binding targets.

**FlowClaw**: Simple 1:1 account-to-agent mapping. Bot token = routing.

**FlowClaw advantage**: 1:1 agent-to-bot model provides natural isolation and simpler reasoning.

**Recommendations**: Add optional `bindings` config for group routing (Important). Keep 1:1 as primary mode (Nice-to-have).

#### Outbound Delivery

| Aspect | OpenClaw | FlowClaw |
|--------|----------|----------|
| Chunking | Configurable min/max, streaming-aware | Fixed 4096, newline/space preference |
| Markdown fallback | Per-account config | Auto-retry on parse failure |
| Streaming/draft previews | 4 modes with lane delivery | None |
| Persistent delivery queue | Disk-backed with recovery | In-memory only |
| Retry with backoff | Configurable, exponential | None (fire-and-forget) |

**FlowClaw advantage**: Markdown-with-fallback approach is pragmatic and cleaner than per-account config.

**Recommendations**: Add retry logic for transient failures (Critical), persistent delivery queue (Important), streaming support (Important).

#### Security

**OpenClaw**: 4 DM policies, pairing flow with one-time codes, per-agent allowlists, group policies, per-group tool restrictions, exec approval.

**FlowClaw**: Single global `allowedUsers` set. Silent drop for unauthorized users.

**Recommendations**: Per-agent allowedUsers (Important), send rejection message instead of silent drop (Important), `dmPolicy` config (Nice-to-have).

#### Message Queue

**FlowClaw advantage**: `sendOrQueue` pattern is cleaner and more explicit than OpenClaw's multi-phase dispatch.

**Recommendations**: Queue cap (Important), message coalescing (Important), `steer` mode (Nice-to-have).

#### Typing & Status

**Recommendations**: Typing indicator lease with auto-refresh (Important), basic ack reaction (Nice-to-have), status reactions (Nice-to-have).

**FlowClaw advantage**: Text-based crash/halt notifications are more informative than emoji reactions.

---

### 3. Subagent System & Task Delegation

#### Spawn Mechanics & Result Delivery

**OpenClaw**: Non-blocking spawn via `sessions_spawn`. Dedicated announce step (separate LLM turn in child session). Multi-phase delivery pipeline (direct -> queue -> retry with backoff). Stable idempotency keys.

**FlowClaw**: Non-blocking spawn via MCP tool + Bridge. Hook-based delivery via `sendOrQueue`. Simple text block delivery with instruction to parent to summarize.

**Recommendations**: Add delivery retry with backoff (Important), consider announce step later (Nice-to-have), add idempotency tracking (Important).

#### Parent Busy Handling

**FlowClaw advantage**: `sendOrQueue` is simpler and more debuggable than OpenClaw's multi-phase dispatch.

**Critical gap**: If parent process is gone, result delivery silently fails. Need to auto-spawn or persist for later.

#### Subagent Registry

**OpenClaw**: Disk-persisted with versioned format, orphan recovery, ancestry tracking, completion lifecycle, 30+ field records.

**FlowClaw**: In-memory `Map` with 10-field records, 1-hour TTL pruning.

**Recommendations**: Persist to disk (Critical), add concurrency limits (Important), add per-parent child limit (Important).

#### Templates & Budget Control

**FlowClaw advantages**: Template-based context is cleaner. `maxTurns` parameter gives explicit loop control OpenClaw lacks.

**Gaps**: No spawn depth tracking, no depth-based tool policy, no cascade kill.

**Recommendations**: Add spawn depth tracking and limits (Important), add cascade kill (Nice-to-have).

#### Tool Availability in Subagents

**Gap**: Subagents get full FlowClaw MCP server including spawn tools. No depth-based restriction.

**Recommendations**: Strip spawn tools from subagent MCP (Important), consider stripping list/status tools (Nice-to-have).

---

### 4. Scheduling & Automation

#### Schedule Types

**OpenClaw**: Three kinds (`at`, `every`, `cron`) with timezone, stagger, anchor. Four session targets. Two payload types. Three delivery modes including webhook.

**FlowClaw**: One kind (`every`) with human-readable durations. Two session targets. One payload type. Two delivery modes (none, announce).

**Recommendations**: Add `at` (Critical), add `cron` expressions (Important), add `webhook` delivery (Important).

#### Heartbeat System

**OpenClaw**: Full heartbeat with HEARTBEAT.md, active hours, wake modes, heartbeat suppression.

**FlowClaw**: No heartbeat system.

**Recommendation**: Design heartbeat system (Important, depends on broader architecture decisions).

#### Error Handling

**OpenClaw**: Transient/permanent classification, auto-disable on permanent error, configurable retry policy.

**FlowClaw**: Single backoff strategy (identical delays to OpenClaw), no error classification, no auto-disable.

**FlowClaw advantage**: Simpler backoff implementation with identical delays in a fraction of the code.

**Recommendations**: Add transient/permanent classification (Important), add max-error-count auto-disable (Important).

#### State Persistence & Run History

**FlowClaw advantages**: Config-driven jobs in `agent.json` (simpler), file-watch hot-reload (more natural), projectId-scoped state.

**Gaps**: No per-job run history, no runtime CRUD API, no file locking.

**Recommendations**: Add per-job run history (Important), add runtime job management via Bridge API (Important).

#### Runtime Job Management & Alerts

**Gaps**: No runtime add/edit/remove, no manual trigger, no alert cooldown, no alert threshold, no session retention.

**Recommendations**: Alert threshold and cooldown (Important), Bridge API endpoints for job management (Important), session retention policy (Important).

#### Concurrent Execution & Missed Jobs

**FlowClaw advantages**: Sequential execution avoids concurrency bugs. Clear missed-job stagger. No cumulative catch-up.

**Gaps**: No stuck job detection, no scheduler-level safety timeout.

**Recommendations**: Add stuck job detection with `runningAtMs` marker (Important), add safety timeout (Important).

---

### 5. Tool System, MCP & Bridge

#### Tool Injection

**OpenClaw**: In-process plugin registration with full runtime context, typed schemas, dynamic loading.

**FlowClaw**: Separate MCP server process with HTTP bridge, per-conversation isolation, env-var context.

**FlowClaw advantage**: Per-conversation process isolation is genuinely better for security. Keep the MCP sidecar architecture.

**Recommendations**: Define tool registration interface (Important), enrich MCP env vars (Important).

#### Bridge & Sandbox

**Critical bug**: Bridge JSON parse failure causes silent HTTP hang. Fix immediately.

**Recommendations**: Fix bridge bug (Critical), add tool profiles (Important), defer sandboxing (Nice-to-have).

#### Per-Agent Tool Config

**OpenClaw**: 8-layer filtering pipeline with deny-wins-over-allow, depth-based policies.

**FlowClaw**: 2-layer filtering. Subagents have no tool restrictions beyond template config.

**Recommendations**: Add spawn depth tracking (Critical), apply `FRAMEWORK_DISALLOWED_TOOLS` to subagents (Critical), add `maxSpawnDepth` and `maxChildrenPerAgent` (Important).

#### MCP Config Lifecycle

**Gaps**: Orphaned temp files on crash, no tool result size limits, no loop detection.

**Recommendations**: Startup sweep for orphaned files (Important), tool result size limits (Important).

#### Tool Surface

FlowClaw's 8 tools + Claude CLI built-ins provide good coverage. The effective gap is smaller than it appears.

**Recommendations**: Abstract Telegram tools into channel-agnostic messaging (Important), add inter-agent messaging tool (Important), do NOT replicate OpenClaw's full suite -- lean on Claude CLI's built-ins.

---

### 6. Configuration, State & Resilience

#### Config Loading & Validation

**OpenClaw**: JSON5 with TypeBox schema validation, `$include` directive, 4 hot-reload modes, config RPC with optimistic concurrency.

**FlowClaw**: Plain JSON with manual imperative validation, env substitution, scheduler-only hot-reload.

**Recommendations**: Schema validation with Zod (Critical), classify config fields as hot-reloadable vs restart-required (Important).

#### Secrets & State

**OpenClaw**: Full SecretRef system (env/file/exec), fail-fast validation, atomic swap on reload, file locking, session store maintenance.

**FlowClaw**: Env-var-only secrets. No file locking. No maintenance. Fire-and-forget session persistence.

**Recommendations**: Atomic writes (Critical), file locking (Critical), session/transcript pruning (Important), make persistence errors visible (Important).

**FlowClaw advantage**: Simpler state model with flat key scheme is more transparent and debuggable.

#### Logging & Errors

**OpenClaw**: Rolling JSON Lines files, console + file levels, redaction, rich error utilities, typed backoff policy.

**FlowClaw**: Console-only with color, level filtering, component prefix, `child()` for scoped sub-loggers.

**FlowClaw advantage**: Interface-based logger with DI via `child()` is cleaner and more testable.

**Recommendations**: File-based logging (Important), log redaction (Important), reusable backoff utility (Important).

#### Context Engine & File Operations

**OpenClaw**: Pluggable ContextEngine with 4 lifecycle hooks, root-scoped file safety, atomic writes with pinned identity, file locking.

**FlowClaw**: Two-layer context concatenation, direct `readFile`/`writeFile`, no locking.

**FlowClaw advantage**: Simpler context model is immediately understandable and fully predictable.

**Recommendations**: Atomic writes (Critical), file locking (Critical), context file size limits (Important).

#### Signal Handling & Plugins

**OpenClaw**: Gateway lock via TCP port, child process bridging, graceful per-channel shutdown, full plugin SDK.

**FlowClaw**: `SIGINT`/`SIGTERM` handlers, ordered shutdown sequence.

**Recommendations**: Singleton instance guard (Critical), graceful shutdown with drain (Important), channel adapter interface extraction (Important).

---

### 7. Hook System & Cross-Cutting Concerns

#### Hook Inventory

**OpenClaw**: ~40+ distinct hook points across two systems (internal EventEmitter + plugin registry with 26 named hooks).

**FlowClaw**: 5 hooks on a single EventEmitter: `subagent:spawning`, `subagent:completed`, `subagent:failed`, `cron:completed`, `cron:failed`.

**Verdict**: FlowClaw covers the right things for the current feature set. Don't try to reach 40 hooks.

#### Execution Modes

**OpenClaw**: Fire-and-forget (internal) + sequential pipeline with return values (plugin). Plugin hooks can modify behavior (block tools, rewrite messages, override model).

**FlowClaw**: Fire-and-forget only. No pipeline/reducer pattern.

**Recommendation**: Add pipeline mode when the first modifying hook is needed (Important, defer until then).

#### Registration

**OpenClaw**: Plugin-based discovery, per-hook enable/disable, CLI management, workspace hooks.

**FlowClaw**: Hardcoded in `index.ts`. No registration API.

**Recommendation**: Extract to `src/hook-wiring.ts` (Important). Defer discovery system (Nice-to-have).

#### Error Handling in Hooks

**Critical finding**: FlowClaw's `EventEmitter.emit()` has no error boundary. A throwing listener will crash the emitter (AgentManager or Scheduler), prevent other listeners from running, and potentially crash the entire system. This violates the stated CLAUDE.md invariant.

**Recommendation**: Override `emit()` in `FlowclawHooks` to wrap each listener in try/catch (Critical).

#### Missing Hook Categories

Prioritized by leverage:
1. `message:received` -- logging, filtering, analytics (Important)
2. `session:start` / `session:reset` -- memory snapshots, audit (Important)
3. `message:sending` -- outbound transformation, delivery logging (Important)
4. `agent:bootstrap` -- dynamic system prompt injection (Important)
5. `before_dispatch` -- message rewriting, routing overrides (Nice-to-have)
6. `gateway:start/stop` -- health checks, operator notification (Nice-to-have)
7. LLM/tool/compaction hooks -- architecturally constrained by CLI boundary (Nice-to-have)

#### FlowClaw Hook Advantages

1. **Simplicity**: Single EventEmitter with 5 typed events vs two-tier system with 40+ hooks
2. **Type safety**: Compile-time checking on emit and listen sides
3. **Dependency injection**: Created via `createHooks()`, passed through constructors (vs OpenClaw's global singleton)
4. **Queue-safe delivery**: Hook listeners use `sendOrQueue` respecting one-writer invariant
5. **Payload immutability**: `readonly` fields prevent accidental mutation

---

### 8. Session Persistence & Conversation History

#### Session Store

**OpenClaw**: Per-agent JSON with ~90+ fields per entry, hierarchical keys, DM scoping modes, identity links, rich origin metadata.

**FlowClaw**: Single `sessions.json` with 5 fields, simple `agentName:chatId` keys.

**FlowClaw advantage**: Simple key model is easy to reason about, debug, and operate manually.

**Critical recommendation**: Adopt composite keys with channel prefix before adding any second channel adapter.

#### Session Reset

**OpenClaw**: Manual (`/new`, `/reset`), daily (4 AM), idle-based, per-type/per-channel overrides. Lazy evaluation on next inbound message.

**FlowClaw**: Manual `/new` only. No automatic reset. Sessions live forever.

**Recommendations**: Add idle-based reset (Important), add daily reset option (Important).

#### Resume Failure Handling

**FlowClaw advantage**: `RESUME_FAILURE_WINDOW_MS` heuristic is pragmatic and well-adapted to CLI-based architecture. OpenClaw doesn't need this (different architecture) but FlowClaw handles it cleanly.

**Gap**: Resume failure silently loses context without user notification.

**Recommendation**: Notify user when resume fails (Important).

#### Transcript Format

**OpenClaw**: JSONL with tree structure (`id` + `parentId`), typed entries, compaction records, provenance metadata, live streaming API.

**FlowClaw**: Flat JSONL with session header, user entries, and raw stream-json events.

**FlowClaw advantage**: Raw event capture preserves full Claude CLI protocol fidelity.

**Recommendations**: Add message provenance tagging (Important), add entry IDs (Important), keep raw event capture.

#### Session Maintenance

**OpenClaw**: Configurable pruning (30 days), entry caps (500), file rotation (10MB), disk budgets, archive management.

**FlowClaw**: No maintenance whatsoever. Sessions and transcripts grow unbounded.

**Recommendations**: Add stale session pruning (Critical), add transcript retention (Important).

#### Context Engine & Compaction

**OpenClaw**: Pluggable ContextEngine with ingest/assemble/compact/afterTurn lifecycle. Legacy engine with adaptive compaction.

**FlowClaw**: Two-layer concatenation at spawn time. Claude CLI owns context management.

**Recommendation**: Do NOT build a full ContextEngine. Monitor compaction events from CLI output (Important). Add dynamic system prompt injection (Important).

#### Token Tracking

**OpenClaw**: Full tracking: input/output/total/context tokens, cache read/write, estimated cost, compaction count.

**FlowClaw**: Only `total_cost_usd` from result events, not persisted.

**Recommendation**: Parse and persist token/cost data (Important). Track cumulative session cost (Important).

#### Long-Term Memory

**OpenClaw**: Workspace-based memory files, `memory_search` with BM25 + vector hybrid search, multiple embedding providers, pre-compaction memory flush.

**FlowClaw**: Transcript-only persistence. No memory tools. Agents lose all knowledge on reset/compaction.

**This is the largest capability gap.**

**Recommendations**: Workspace-based memory files with `MEMORY.md` (Critical), MCP tool for memory search (Important), defer vector search (Nice-to-have).

#### Session Metadata

**OpenClaw**: ~90+ fields. **FlowClaw**: 5 fields.

**Recommendations**: Add `model`, `totalCostUsd`, `channel` fields (Important). Add fields as features need them -- do NOT add 90 fields preemptively.
