# Phase 1 Kickoff — Heartbeat Domain

## Your job in this chat

Design the **heartbeat** capability for Rondel, to spec-level quality, following our modularity contract. **Do not implement it.** Produce a design document I can review, iterate on, and then hand to a future implementation chat. You will: (1) load the necessary context, (2) run two parallel research subagents to study how OpenClaw and CortexOS handle this concept, (3) study Rondel's own patterns, (4) synthesize a clean design proposal.

---

## Context

### Rondel, in one paragraph
Rondel is a multi-agent orchestration framework built on the Claude CLI. It bridges messaging channels (Telegram today, a loopback web channel for the dashboard) to Claude processes with per-conversation isolation, durable scheduling, memory, approvals, and inter-agent messaging — all via first-class MCP tools. Today it is **reactive**: an agent process only exists while a user is talking to it. The long-term vision is an **agentic self-evolving harness** that manages real operations — a team of agents that wake up on their own, share a task board, cascade goals from a coordinator down to specialists, run nightly experiments to improve themselves, and give the user a daily rhythm of morning briefings and evening recaps.

### What Phase 1 is
Phase 1 adds the five foundations that turn Rondel proactive: **heartbeat ritual, task board, goal system, orchestrator role, morning/evening reviews**. Each sits atop Rondel's existing scheduler / ledger / bridge / memory foundation. Full plan: [`docs/PHASE-1-PLAN.md`](../PHASE-1-PLAN.md). The gap analysis that motivated this plan: [`docs/GAP-ANALYSIS-CORTEXTOS.md`](../GAP-ANALYSIS-CORTEXTOS.md).

### This item — Heartbeat
A scheduled wake-up every 4 hours where each agent runs a short discipline checklist (update status, sweep inbox, glance at tasks, verify goals aren't stale, note anything worth remembering, log that it's alive). The *heartbeat* is the record that comes out — a small JSON file saying "agent X was alive at time T, currently working on Y." With this primitive, dormant conversations become agents with a pulse, the orchestrator can see the fleet, and every downstream discipline (stale-task sweeps, memory checkpoints, goal staleness, guardrail self-checks) naturally plugs into the heartbeat turn instead of needing its own cron. Details: [`docs/PHASE-1-PLAN.md`](../PHASE-1-PLAN.md) section 1.

### Files to read if you need depth
- `CLAUDE.md` — coding standards, modularity contract, user-space vs framework-space boundary
- `ARCHITECTURE.md` — what exists in code today
- `docs/PHASE-1-PLAN.md` — section 1 (Heartbeat)
- `docs/GAP-ANALYSIS-CORTEXTOS.md` — the "why"

---

## Step 1 — Parallel research (dispatch two subagents)

Dispatch two `Explore` subagents **in a single message so they run in parallel**. Each subagent produces a structured report using the shared schema below. Ask them to keep findings **concise — facts and file paths, not code dumps**. Do not read either external codebase yourself; rely on the subagents so this chat's context stays clean.

### Subagent A — OpenClaw
**Path**: `/Users/david/Code/openclaw`
**Focus**: does OpenClaw give its agents a pulse / liveness signal / scheduled wake-up / discipline cycle? If yes, how. If not, what's the nearest mechanism — watchdog, health check, scheduled task, lifecycle hook? How does it detect dead / stuck agents? Is there any equivalent of a "discipline checklist the agent runs periodically"?

### Subagent B — CortexOS
**Path**: `/Users/david/Code/cortextos`
**Focus**: map the full heartbeat implementation. Key files: `src/bus/heartbeat.ts`, `templates/orchestrator/HEARTBEAT.md` (the 10-step checklist), `src/daemon/fast-checker.ts` (the idle-session watchdog around lines 93–102), `templates/agent/.claude/skills/heartbeat/SKILL.md`, and any consumers (orchestrator fleet-health, dashboard fleet grid).

### Shared output schema (both subagents must use this)

```
## 1. Concept presence
Yes / Partial / No — 1-sentence summary

## 2. Data model
- Exact on-disk paths
- Schema (field list + types)
- Per-agent / per-org / global?
- Mutable or append-only?

## 3. Code surface
- Modules that own data + logic
- Key functions / APIs (names only)
- Store vs service vs tool separation (if any)

## 4. Trigger
- What fires an update (cron, event, user, watchdog)
- Where the trigger is defined

## 5. Read / write surface
- Who writes?
- Who reads (agents, coordinators, subsystems)?
- How the record reaches an agent's context (prompt injection, tool call, event)?

## 6. Discipline / contract
- Behavioral rules agents follow when heartbeating
- Where those rules are encoded (skill file, guardrails, system prompt)

## 7. Lifecycle
- Creation / update / staleness detection / cleanup

## 8. Integration points
- Hooks, events, shared state touching this

## 9. Strengths worth adopting for Rondel
- Specific patterns, decisions, file structures

## 10. Anti-patterns / not to copy
- Specific choices that would not fit Rondel's architecture

## 11. Key file paths (absolute)
```

---

## Step 2 — Rondel codebase research

Once both subagent reports are in, study Rondel itself to find the clean integration point. Look at:

1. **Existing domains with the store/service/tool pattern** — `apps/daemon/src/approvals/`, `apps/daemon/src/scheduling/`, `apps/daemon/src/ledger/`. Treat these as templates.
2. **Scheduler** — `apps/daemon/src/scheduling/scheduler.ts`, `schedule-service.ts`, `schedule-store.ts`, `watchdog.ts`. The heartbeat cron will ride on this.
3. **Ledger** — `apps/daemon/src/ledger/ledger-writer.ts`, `ledger-types.ts`. Heartbeat events will emit here.
4. **Streams** — `apps/daemon/src/streams/` pattern for SSE to the web UI.
5. **Prompt composition** — `apps/daemon/src/config/prompt/` for how a cron-triggered turn composes its prompt (see `cron-preamble.ts`).
6. **Session resume** — `apps/daemon/src/agents/conversation-manager.ts` — the `--resume` mechanism that lets a cron fire into an agent's main session with full context.
7. **Bridge endpoints** — `apps/daemon/src/bridge/bridge.ts` pattern for exposing read-only state to the web UI.
8. **Shared types** — `apps/daemon/src/shared/types/` conventions (zero runtime imports, barrel export).
9. **Framework skills** — `apps/daemon/templates/framework-skills/.claude/skills/` — shape of an existing skill (look at `rondel-delegation` or `rondel-create-agent`).
10. **Hooks system** — `apps/daemon/src/shared/hooks.ts` — the event bus for cross-cutting emissions.

---

## Step 3 — Synthesize the design

Produce a design document that answers:

1. **Scope** — what's in, what's explicitly out for Phase 1.
2. **Data model** — `HeartbeatRecord` shape, file layout on disk, Zod schema.
3. **Module layout** — file tree under `apps/daemon/src/heartbeats/`, barrel exports, public vs internal API.
4. **MCP tool surface** — tool names, input/output schemas, privilege level (admin / orchestrator / any agent).
5. **Bridge endpoints** — routes, schemas, consumers.
6. **Stream source** — event shape, where it hooks into the service.
7. **Ledger events** — event names and payload shapes (`heartbeat:updated`, `heartbeat:stale`).
8. **Framework skill** — prose content of `rondel-heartbeat/SKILL.md` — the discipline checklist agents run on every heartbeat turn.
9. **Default cron installation** — how `rondel add agent` gets a heartbeat cron installed. Is it in `agent.json` `crons` field? Scaffolded? Auto-installed on first boot?
10. **Session resume decision** — does the cron fire into the agent's main session via `--resume`, or as an ephemeral one-shot? Trade-offs (context continuity vs cost vs collision with live user conversations).
11. **Staleness thresholds** — default "stale" cutoff, how it's configured.
12. **Testing strategy** — unit (pure functions), integration (file I/O + scheduler), end-to-end.
13. **Migration** — does this need state-directory creation, agent.json changes for existing installs?
14. **Open questions** — anything you want me to decide before implementation.

---

## Deliverable

Save to `docs/phase-1/01-heartbeat-design.md`. Structure matching the synthesis sections. Keep it editable — this is a working document we'll iterate on before implementation.

---

## Guardrails for this chat

- **Do not implement.** Design only.
- **Follow Rondel patterns** (CLAUDE.md): store/service/tool split, hooks over direct calls, user-space vs framework-space boundary, domain directories with barrels, Zod at boundaries, strict TypeScript, branded types for composite keys, no backwards-compatibility shims.
- **Do not over-engineer.** If CortexOS does something fancy we don't need in Phase 1, call it out and defer.
- **Flag every trade-off** rather than silently choosing — I'll decide.
- **Preserve what Rondel has** — don't rebuild the scheduler, ledger, or bridge. Use them.
- **Minimize this chat's context** — rely on subagents for external-codebase research; do not read OpenClaw or CortexOS source yourself.
