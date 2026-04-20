# Phase 1 Kickoff — Goal System Domain

## Your job in this chat

Design the **goal system** capability for Rondel, to spec-level quality, following our modularity contract. **Do not implement it.** Produce a design document I can review, iterate on, and then hand to a future implementation chat. You will: (1) load context, (2) run two parallel research subagents to study OpenClaw and CortexOS, (3) study Rondel's patterns, (4) synthesize a clean design proposal.

---

## Context

### Rondel, in one paragraph
Rondel is a multi-agent orchestration framework built on the Claude CLI. It bridges messaging channels (Telegram today, a loopback web channel for the dashboard) to Claude processes with per-conversation isolation, durable scheduling, memory, approvals, and inter-agent messaging — all via first-class MCP tools. Today it is **reactive**: an agent process only exists while a user is talking to it. The long-term vision is an **agentic self-evolving harness** that manages real operations — a team of agents that wake up on their own, share a task board, cascade goals from a coordinator down to specialists, run nightly experiments to improve themselves, and give the user a daily rhythm of morning briefings and evening recaps.

### What Phase 1 is
Phase 1 adds the five foundations that turn Rondel proactive: **heartbeat ritual, task board, goal system, orchestrator role, morning/evening reviews**. Each sits atop Rondel's existing scheduler / ledger / bridge / memory foundation. Full plan: [`docs/PHASE-1-PLAN.md`](../PHASE-1-PLAN.md). Gap analysis: [`docs/GAP-ANALYSIS-CORTEXTOS.md`](../GAP-ANALYSIS-CORTEXTOS.md).

### This item — Goal system
An explicit objectives layer. One **north-star** per org (long-term mission), one **daily-focus** per org (what we're pushing today), and **per-agent daily goals** (what this specific agent should care about today). Goals are set by the user through the orchestrator each morning and cascade down to specialists — each agent's daily goals are injected into that agent's system prompt on every main-mode turn, so they see it without having to query anything. Today, agents have durable identity (who they are) and memory (what they've learned), but no explicit *today* layer — no answer to "what am I supposed to be doing right now?" The goal system fills that gap with a machine-readable state the whole fleet respects and that the user can edit live when priorities shift. Details: [`docs/PHASE-1-PLAN.md`](../PHASE-1-PLAN.md) section 3.

### Files to read if you need depth
- `CLAUDE.md` — coding standards, modularity contract
- `ARCHITECTURE.md` — what exists in code today
- `docs/PHASE-1-PLAN.md` — section 3 (Goal system)
- `docs/GAP-ANALYSIS-CORTEXTOS.md` — the "why"

---

## Step 1 — Parallel research (dispatch two subagents)

Dispatch two `Explore` subagents **in a single message so they run in parallel**. Each subagent produces a structured report using the shared schema below. Ask them for **concise findings — facts, schemas, file paths; no code dumps**. Do not read the external codebases yourself; rely on subagents.

### Subagent A — OpenClaw
**Path**: `/Users/david/Code/openclaw`
**Focus**: does OpenClaw have a concept of objectives, goals, priorities, or focus? Per-agent directives? A way to tell an agent "today you care about X"? If no explicit goal layer, what's the nearest analogue (identity-based scoping, system-prompt variables, per-session context)? How does OpenClaw communicate priority or objectives to an agent?

### Subagent B — CortexOS
**Path**: `/Users/david/Code/cortextos`
**Focus**: map the full goal system. Key files: `templates/orchestrator/goals.json` (org-level schema), per-agent `goals.json` files, `src/bus/system.ts:checkGoalStaleness()` (staleness detection logic), `templates/orchestrator/.claude/skills/goal-management/SKILL.md`, `templates/orchestrator/.claude/skills/morning-review/SKILL.md` (Phase 1 cascade step), and the `cortextos goals generate-md --agent <name>` command (how GOALS.md gets rendered). Also cover: how goals reach the agent at turn time (prompt injection vs tool query), who can write another agent's goals, how staleness is surfaced.

### Shared output schema (both subagents must use this)

```
## 1. Concept presence
Yes / Partial / No — 1-sentence summary

## 2. Data model
- On-disk layout (exact paths)
- Schema: org-level vs per-agent fields, types
- Nesting (north-star → daily-focus → agent goals)
- Mutable vs append-only

## 3. Code surface
- Modules that own goals
- Key APIs (set / get / cascade / stale-check)
- Store / service / tool separation (if any)

## 4. Propagation model
- How do goals reach an agent at turn time? (system prompt, tool pull, env var, rendered file)
- Per-turn cost (context size) vs per-day cost (cascade step)
- Caching / rendering mechanism

## 5. Authority / write surface
- Who can set org goals? (user via orchestrator, orchestrator directly)
- Who can set another agent's goals?
- Self-edit permitted?

## 6. Staleness semantics
- Definition (e.g., daily_focus_set_at not today)
- Detection trigger (heartbeat, morning-review, dedicated cron)
- What happens on stale (warning, auto-trigger, alert)

## 7. Lifecycle
- Creation (first-time setup, onboarding)
- Daily cascade
- User edits mid-day (does the system respect or overwrite?)
- Archival / history

## 8. Integration points
- Ritual triggers (morning review, heartbeat)
- Ledger / event emission
- Dashboard surfacing

## 9. Strengths worth adopting for Rondel
## 10. Anti-patterns / not to copy
## 11. Key file paths (absolute)
```

---

## Step 2 — Rondel codebase research

Once both subagent reports are in, study Rondel to find the clean integration point. Look at:

1. **Prompt composition pipeline** — `apps/daemon/src/config/prompt/` (the heart of this feature). Study `assemble.ts`, `sections/` subdirectory, `types.ts`. Goals will be a new pure section builder.
2. **Bootstrap / per-agent files** — `apps/daemon/src/config/prompt/bootstrap.ts` — how `AGENT.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`, `MEMORY.md` get loaded. GOALS.md fits here.
3. **Shared context loader** — `apps/daemon/src/config/prompt/shared-context.ts` — how org-level shared context gets injected. North-star + daily-focus fit here.
4. **Existing per-agent files** — `apps/daemon/templates/context/` — the scaffolded user-space files. GOALS.md template goes here.
5. **Domain templates** — `apps/daemon/src/approvals/` again, for mutable state with service + store + stream.
6. **Org config** — how `{org}/shared/CONTEXT.md` vs `global/CONTEXT.md` work today. Goals should compose with these, not replace them.
7. **User space vs framework space** — CLAUDE.md section on this boundary. GOALS.md is user-space (user can hand-edit). The orchestrator-rendered version must respect user edits.
8. **Prompt modes** — `main`, `agent-mail`, `cron`. Decide which modes inject goals.
9. **MCP admin tool pattern** — how admin-only tools are gated (`admin: true` flag). Orchestrator-only goal-setting tools follow this pattern or the new role-based one from item 4.
10. **Shared types** — `apps/daemon/src/shared/types/` and how org/agent config types are organized.

---

## Step 3 — Synthesize the design

Produce a design document that answers:

1. **Scope** — what's in for Phase 1 (north-star, daily-focus, per-agent goals, staleness, prompt injection), what's explicitly deferred (OKR progress tracking, multi-horizon planning, KPI measurement).
2. **Data model** — `OrgGoals` + `AgentGoals` schemas, on-disk layout (`state/goals/{org}/goals.json` + `state/goals/{org}/agents/{name}.json`), Zod definitions.
3. **Relationship between stored goals (JSON) and rendered goals (`GOALS.md`)** — is the Markdown auto-generated, user-editable, or both? If collaborative, how conflicts resolve (last-writer-wins, service-respects-user-edits, diff-and-merge).
4. **Module layout** — file tree under `apps/daemon/src/goals/`, barrel exports, store/service/tool separation.
5. **Prompt section integration** — new file `apps/daemon/src/config/prompt/sections/goals.ts`, pure builder signature, which `PromptMode`s include it, where it slots into the section order.
6. **MCP tool surface** — `rondel_goals_set_north_star`, `rondel_goals_set_daily_focus`, `rondel_goals_set_agent_goals`, `rondel_goals_get`. Privileges (orchestrator-only writes? role-based gating that anticipates item 4?). Input/output schemas.
7. **Bridge endpoints** — `GET /goals/:org`, `GET /goals/:org/:agent`, any mutation routes.
8. **Stream source** — live updates for the web UI (goal changes).
9. **Ledger events** — `goals:north_star_set`, `goals:daily_focus_set`, `goals:cascaded`, `goals:stale`.
10. **Staleness model** — definition, detection (inside heartbeat skill? standalone cron?), escalation path.
11. **Cascade mechanics** — how the orchestrator writes N agents' goals in one ritual step. Atomicity concerns. What happens if one write fails.
12. **User-edit semantics** — what happens when the user opens `GOALS.md` and edits it mid-day? Orchestrator must detect and respect.
13. **First-time setup** — how does a new install get its first north-star? Onboarding flow (CLI prompt? orchestrator bootstrap? user's first conversation?).
14. **Testing strategy** — unit (section builder is pure), integration (prompt assembly with/without goals, staleness detection).
15. **Migration** — new state directory, no breaking changes for existing installs.
16. **Open questions** — which modes include goals (main yes; cron maybe; agent-mail no?), whether goals should also flow into `MEMORY.md` checkpoints, what the onboarding UX is, how goals interact with tasks (goal → generates tasks automatically? loose coupling?).

---

## Deliverable

Save to `docs/phase-1/03-goal-system-design.md`. Structure matching the synthesis sections. Editable, for iteration.

---

## Guardrails for this chat

- **Do not implement.** Design only.
- **Follow Rondel patterns** (CLAUDE.md): user-space vs framework-space boundary is especially important for this feature (GOALS.md is user-space).
- **Do not over-engineer.** Skip OKR progress tracking, multi-horizon goals, KPI measurement for now.
- **Flag every trade-off** — I'll decide.
- **Preserve what Rondel has** — use prompt pipeline as-is, extend via a new section.
- **Minimize this chat's context** — rely on subagents for external research; no reading OpenClaw or CortexOS source yourself.
