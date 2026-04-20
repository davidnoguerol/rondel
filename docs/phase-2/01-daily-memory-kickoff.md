# Phase 2 Kickoff — Daily Memory + 3-Layer Memory Protocol

## Your job in this chat

Design the **daily-memory + MEMORY.md discipline** for Rondel, to spec-level quality, following our modularity contract. **Do not implement it.** Produce a design document I can review, iterate on, and then hand to a future implementation chat. You will: (1) load context, (2) run two parallel research subagents to study OpenClaw and CortexOS, (3) study Rondel's patterns, (4) synthesize a clean design proposal.

---

## Context

### Rondel, in one paragraph
Rondel is a multi-agent orchestration framework built on the Claude CLI. It bridges messaging channels (Telegram today, a loopback web channel for the dashboard) to Claude processes with per-conversation isolation, durable scheduling, memory, approvals, and inter-agent messaging — all via first-class MCP tools. Today it is reactive. The long-term vision is an **agentic self-evolving harness** that manages real operations — a team of agents that wake up on their own, share a task board, cascade goals from a coordinator down to specialists, run nightly experiments to improve themselves, and give the user a daily rhythm of morning briefings and evening recaps.

### What Phase 2 is
Phase 2 adds the **intelligence substrate**: three layers of memory (daily log, long-term learnings, semantic KB) and a self-improving guardrails loop. After Phase 2, agents accumulate institutional knowledge, query it before doing work, and actively detect when they're about to repeat past failures. Full plan: [`docs/PHASE-1-PLAN.md`](../PHASE-1-PLAN.md) (sibling file for Phase 1), and the gap analysis at [`docs/GAP-ANALYSIS-CORTEXTOS.md`](../GAP-ANALYSIS-CORTEXTOS.md) sections 3, 6.

### This item — Daily memory + MEMORY.md protocol
Today Rondel has **one** flat `MEMORY.md` per agent, read on every spawn. That's the long-term layer — durable patterns, user preferences, decisions and their reasoning. It's valuable but incomplete. Agents also need a **daily log**: `memory/YYYY-MM-DD.md`, a per-day operational file where agents write at session start ("resuming X"), at each heartbeat ("4h in, current focus is Y"), and at session end ("today I shipped X, Y is pending, decisions made were Z"). The daily log gives a fresh session enough context to resume work without re-reading everything; MEMORY.md distills the durable learnings from those daily logs. Together they're two of the three layers CortexOS uses; the third (semantic KB) is the next kickoff brief. Details: [`docs/GAP-ANALYSIS-CORTEXTOS.md`](../GAP-ANALYSIS-CORTEXTOS.md) section 3.

### Dependencies
Phase 1 items 1 (heartbeat) and 4 (orchestrator role) should be assumed built. The heartbeat skill is where daily-memory writes happen on the 4h cadence.

### Files to read if you need depth
- `CLAUDE.md` — coding standards, user-space vs framework-space boundary (memory is **user-space**)
- `ARCHITECTURE.md` — current MEMORY.md mechanics
- `docs/GAP-ANALYSIS-CORTEXTOS.md` — sections 3 and 6
- `docs/PHASE-1-PLAN.md` — heartbeat section (where daily-memory writes fire)

---

## Step 1 — Parallel research (dispatch two subagents)

Dispatch two `Explore` subagents **in a single message so they run in parallel**. Concise findings, file paths, no code dumps. Do not read external codebases yourself.

### Subagent A — OpenClaw
**Path**: `/Users/david/Code/openclaw`
**Focus**: how does OpenClaw handle per-agent memory across sessions? Is there a long-term memory store? A per-session checkpoint? Any separation between ephemeral session state and durable learnings? How does a fresh session resume knowing "where I was"? How is memory injected into the system prompt? Any compaction / summarization patterns?

### Subagent B — CortexOS
**Path**: `/Users/david/Code/cortextos`
**Focus**: map the daily-memory + MEMORY.md protocol. Key files: `templates/agent/MEMORY.md` (template), `templates/agent/memory/` directory convention (daily files `YYYY-MM-DD.md`), `templates/agent/.claude/skills/memory/SKILL.md` (the protocol — session start / heartbeat / session end entries), `AGENTS.md` steps 2 / 7 / 8 / 13 (memory read + write points), `src/bus/knowledge-base.ts` re-ingestion logic (Layer 3 — KB is the next kickoff brief, but the auto-reindex of memory files is relevant here). Cover: entry formats, write triggers, read triggers, how much memory is injected into the prompt vs queried on demand, checkpoint guidance for session end before restart.

### Shared output schema (both subagents must use this)

```
## 1. Concept presence
Yes / Partial / No — 1-sentence summary

## 2. Layer taxonomy
- How many memory layers?
- What each layer is for (ephemeral, daily, long-term, semantic)
- Read vs write frequency per layer

## 3. Data model
- File paths on disk
- Format (Markdown sections, JSON, free prose)
- Append-only vs mutable

## 4. Write surfaces
- Who writes (agent, skill, daemon)?
- When (session start, heartbeat, session end, ad hoc)?
- Structured template for each entry type?

## 5. Read surfaces
- What gets injected into system prompt on spawn?
- How much (full file, N most recent days, summary)?
- On-demand read via tool vs always-injected?

## 6. Session-continuity semantics
- How does a fresh session know where it was?
- Checkpoint format for "about to restart — here's what the next me needs"
- Resume protocol

## 7. Discipline / contract
- Rules for what goes in long-term vs daily
- Rules for what gets promoted from daily to long-term
- Where encoded (skill prose, guardrails)

## 8. Lifecycle / retention
- Are old daily files pruned? Compacted? Archived?
- Does MEMORY.md grow forever?

## 9. Integration points
- Heartbeat writes
- Morning/evening reviews writes
- KB ingestion (downstream — see Phase 2 item 2)

## 10. Strengths worth adopting for Rondel
## 11. Anti-patterns / not to copy
## 12. Key file paths (absolute)
```

---

## Step 2 — Rondel codebase research

1. **Existing MEMORY.md mechanics** — `apps/daemon/src/config/prompt/bootstrap.ts` (how MEMORY.md is loaded) and the MCP tools `rondel_memory_read` / `rondel_memory_save`.
2. **Per-agent file conventions** — `apps/daemon/templates/context/` for scaffolded files; where a new `memory/` subdirectory would slot in.
3. **Prompt modes** — `apps/daemon/src/config/prompt/types.ts`. Decide which modes inject daily memory (main yes; cron probably; agent-mail probably no; subagent no).
4. **Heartbeat skill** — the soon-to-exist Phase 1 skill; daily-memory writes happen inside it.
5. **Session resume** — `apps/daemon/src/agents/conversation-manager.ts`. Session-end checkpoint matters here — where does the agent write "here's what the next me needs to know" before a restart?
6. **User-space vs framework-space** — memory files are **user-space** (the user owns them, the agent writes to them at runtime, the framework must not depend on specific phrasing).
7. **Prompt assembly** — `apps/daemon/src/config/prompt/assemble.ts` + `sections/` for where a new daily-memory section builder slots in.
8. **Existing MCP surface** — `rondel_memory_read` / `rondel_memory_save` today. Decide: extend these, or add `rondel_memory_daily_*` siblings? Keep the surface small.

---

## Step 3 — Synthesize the design

1. **Scope** — Phase 2 memory: 2 layers (daily log + MEMORY.md). Semantic KB is a sibling kickoff (item 2). No compaction / LLM summarization for Phase 2.
2. **Layer contract** — what belongs in daily log vs MEMORY.md. Plain-language rules the discipline enforces.
3. **Data model** — file layout (`<agentDir>/memory/YYYY-MM-DD.md`, `<agentDir>/MEMORY.md`), entry templates for session-start / heartbeat / session-end, how a day's file is initialized (on first write of the day? scaffolded empty?).
4. **Prompt injection** — which daily files get injected (e.g., today + last 2 days), section order, size budget, token cost estimate.
5. **MCP tool surface** — `rondel_memory_read` (extend?), `rondel_memory_save` (extend?), new `rondel_memory_daily_append`, `rondel_memory_checkpoint` for session-end. Decide minimal surface.
6. **Heartbeat integration** — the heartbeat skill's memory step. Prose for that step.
7. **Session-end checkpoint** — when does it fire? Before context-rotation? Before `/new`? Only on explicit session end? Mechanism.
8. **Retention policy** — how long daily files live. Archive to `<agentDir>/memory/archive/YYYY/` after N days? Never prune? Document intent even if policy = "grows forever for now."
9. **Framework skill** — `rondel-memory-protocol/SKILL.md`: the 3-entry discipline (session-start, heartbeat, session-end) + the "promote from daily to MEMORY.md" rule.
10. **User-space invariants** — guarantees: framework never deletes a user's MEMORY.md or daily file without explicit action; framework never silently rewrites prose; only appends.
11. **Testing strategy** — unit (entry-template rendering), integration (daily file creation + injection + heartbeat append).
12. **Migration** — existing installs: new empty `memory/` directory on next spawn; no breaking changes.
13. **Open questions** — does daily memory inject by date or by most-recent-activity? Is the session-end checkpoint agent-authored or semi-automated (e.g., the framework injects a "checkpoint now" prompt before context rotation)? How does the KB (item 2) consume daily-memory writes — subscribe or re-ingest?

---

## Deliverable

Save to `docs/phase-2/01-daily-memory-design.md`. Editable, for iteration.

---

## Guardrails for this chat

- **Do not implement.** Design only.
- **Follow Rondel patterns** (CLAUDE.md). Memory files are user-space — framework never mutates prose without explicit user/agent action.
- **Do not over-engineer.** No LLM summarization, no vector anything in this doc (that's item 2).
- **Flag every trade-off** — I'll decide.
- **Preserve what Rondel has** — extend `rondel_memory_*` tools; do not fork into a second memory system.
- **Minimize this chat's context** — rely on subagents for external research.
