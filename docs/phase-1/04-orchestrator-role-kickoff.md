# Phase 1 Kickoff — Orchestrator Role + Template

## Your job in this chat

Design the **orchestrator role and template** capability for Rondel, to spec-level quality, following our modularity contract. **Do not implement it.** Produce a design document I can review, iterate on, and then hand to a future implementation chat. You will: (1) load context, (2) run two parallel research subagents to study OpenClaw and CortexOS, (3) study Rondel's patterns, (4) synthesize a clean design proposal.

---

## Context

### Rondel, in one paragraph
Rondel is a multi-agent orchestration framework built on the Claude CLI. It bridges messaging channels (Telegram today, a loopback web channel for the dashboard) to Claude processes with per-conversation isolation, durable scheduling, memory, approvals, and inter-agent messaging — all via first-class MCP tools. Today it is **reactive**: an agent process only exists while a user is talking to it. The long-term vision is an **agentic self-evolving harness** that manages real operations — a team of agents that wake up on their own, share a task board, cascade goals from a coordinator down to specialists, run nightly experiments to improve themselves, and give the user a daily rhythm of morning briefings and evening recaps.

### What Phase 1 is
Phase 1 adds the five foundations that turn Rondel proactive: **heartbeat ritual, task board, goal system, orchestrator role, morning/evening reviews**. Each sits atop Rondel's existing scheduler / ledger / bridge / memory foundation. Full plan: [`docs/PHASE-1-PLAN.md`](../PHASE-1-PLAN.md). Gap analysis: [`docs/GAP-ANALYSIS-CORTEXTOS.md`](../GAP-ANALYSIS-CORTEXTOS.md).

### This item — Orchestrator role + template
A new kind of agent whose contract is "I never do specialist work; I only route, cascade, and unblock." The orchestrator is what the user talks to at 08:00 to set today's focus; it breaks that focus into tasks and dispatches them to specialists; every 4 hours it reads the fleet's heartbeats and intervenes on stale approvals or crashed agents; at 18:00 it reports what shipped. Structurally, "orchestrator" is a `role` field on `agent.json` (default: `specialist`) plus a scaffolded template with its own personality, its own cron set (morning + evening + heartbeat), and access to a pack of orchestrator-only MCP tools (read all heartbeats, set other agents' goals, dispatch tasks). Same binary, same runtime — just a different scaffold and a different tool allowlist. Details: [`docs/PHASE-1-PLAN.md`](../PHASE-1-PLAN.md) section 4.

### Files to read if you need depth
- `CLAUDE.md` — coding standards, modularity contract, user-space vs framework-space boundary
- `ARCHITECTURE.md` — what exists in code today
- `docs/PHASE-1-PLAN.md` — section 4 (Orchestrator role)
- `docs/GAP-ANALYSIS-CORTEXTOS.md` — the "why"

---

## Step 1 — Parallel research (dispatch two subagents)

Dispatch two `Explore` subagents **in a single message so they run in parallel**. Each subagent produces a structured report using the shared schema below. Ask them for **concise findings — facts, schemas, file paths; no code dumps**. Do not read the external codebases yourself; rely on subagents.

### Subagent A — OpenClaw
**Path**: `/Users/david/Code/openclaw`
**Focus**: does OpenClaw distinguish agent roles? Coordinator vs worker vs observer patterns? Is there an agent-vs-subagent hierarchy that maps to this? Any equivalent of an `admin` flag or role gating for privileged tools? How are privileged operations (managing other agents, setting config, spawning work) gated? CLAUDE.md mentions OpenClaw's `ownerOnly` pattern — explore that.

### Subagent B — CortexOS
**Path**: `/Users/david/Code/cortextos`
**Focus**: map the full orchestrator pattern. Key files: `templates/orchestrator/` (the whole directory — `IDENTITY.md`, `SOUL.md`, `CLAUDE.md`, `agent.json`), `templates/orchestrator/.claude/skills/` (all 27 skills), `templates/analyst/` for comparison (the other standing role), how the orchestrator vs specialist distinction is implemented (is it a flag, a template name, a role field?), how orchestrator-only tools are gated, how the CLI scaffolds an orchestrator vs a specialist. Also cover: does CortexOS have any role dimension beyond "orchestrator vs specialist vs analyst"?

### Shared output schema (both subagents must use this)

```
## 1. Concept presence
Yes / Partial / No — 1-sentence summary

## 2. Role taxonomy
- What roles exist?
- How expressed (enum field, template name, capability set, flag)?
- Multi-role agents allowed?

## 3. Role → template mapping
- Per-role scaffold files
- Default config differences (model, channels, crons, tools)
- How CLI / API picks the right template

## 4. Role → tool gating
- How privileged MCP tools are restricted to certain roles
- Where gating happens (tool registration, tool invocation, prompt injection)
- Relationship between role and other privilege dimensions (admin, owner)

## 5. Role → skill gating
- Are some skills only for some roles?
- How discovery / loading reflects this

## 6. Role → cron defaults
- Different default schedules per role
- Where installed (template, runtime, CLI)

## 7. Cross-agent discovery
- How one agent finds "who is my orchestrator?"
- How the orchestrator enumerates specialists

## 8. Runtime mutation
- Can roles change at runtime?
- Hot-add / disable semantics

## 9. Strengths worth adopting for Rondel
## 10. Anti-patterns / not to copy
## 11. Key file paths (absolute)
```

---

## Step 2 — Rondel codebase research

Once both subagent reports are in, study Rondel itself to find the clean integration point. Look at:

1. **Agent config schema** — `apps/daemon/src/shared/types/config.ts` and wherever `AgentConfig` Zod schema lives. Add a `role` field here.
2. **Admin flag pattern** — today's `admin: true` field. Study how it gates tools. See `apps/daemon/src/bridge/mcp-server.ts` and how admin tools are registered conditionally. Role gating should follow the same shape.
3. **Agent discovery** — how `rondel_list_agents`, `rondel_list_teammates`, `rondel_list_orgs` work. Add role to the returned metadata.
4. **Agent templates** — `apps/daemon/templates/context/` — today's single agent template. Need a parallel `templates/context/orchestrator/`.
5. **Scaffold logic** — `apps/daemon/src/cli/scaffold.ts` — how templates get copied into new agent directories with `{{agentName}}` substitution. Extend to pick template by `--role`.
6. **CLI add-agent** — `apps/daemon/src/cli/add-agent.ts` — add `--role` flag and prompt.
7. **Init** — `apps/daemon/src/cli/init.ts` — first-run flow, where it currently creates one admin agent. Extend to offer an orchestrator scaffold.
8. **Bridge admin API** — `apps/daemon/src/bridge/admin-api.ts` — runtime agent creation. `rondel_add_agent` must accept a role.
9. **Framework skills loading** — `apps/daemon/templates/framework-skills/.claude/skills/` and how `--add-dir` injection works. Role-gated skills: how discovery works, how invocation is restricted.
10. **Cross-agent addressing** — `rondel_find_orchestrator`-type helpers: where `roles.ts` belongs (in `agents/`).
11. **User-space vs framework-space boundary** — CLAUDE.md. The orchestrator template's scaffolded files (`AGENT.md`, `SOUL.md`, etc.) are user-space. The role contract (tool allowlist, skill pack, cron defaults) is framework-space.

---

## Step 3 — Synthesize the design

Produce a design document that answers:

1. **Scope** — Phase 1 roles (`orchestrator`, `specialist`). Defer `analyst` (Phase 3), `auditor`, `ops-lead`. Not multi-role.
2. **Schema change** — Zod schema update for `AgentConfig`, default value, backwards compatibility for existing agent.json files (must default to `specialist`).
3. **Relationship between `role` and `admin`** — orthogonal dimensions. Matrix: admin × role → what tools are available. First-agent-ever gets `role: orchestrator, admin: true` by default.
4. **Template file tree** — everything that goes in `apps/daemon/templates/context/orchestrator/`: `AGENT.md`, `SOUL.md`, `IDENTITY.md`, `GOALS.md`, `BOOTSTRAP.md`, `agent.json` defaults. Contents spec for each (prose).
5. **CLI surface** — `rondel add agent --role orchestrator|specialist`, updated `rondel init` flow, updated `rondel add org` (does a new org need an orchestrator?).
6. **Bridge admin API** — `rondel_add_agent` accepts a role parameter. Schema + validation.
7. **Role-based tool gating** — implementation model. Options: (a) gate at MCP tool registration time based on agent's role; (b) gate at tool invocation with a role check; (c) role-specific `tools.allowed` entries in the template's agent.json that get enforced at disallowed-list time. Pick one with rationale.
8. **Role-based skill gating** — options: (a) role-filtered `--add-dir` at spawn; (b) skill-side role check that no-ops for wrong role; (c) convention only (specialist skills simply never invoke orchestrator-only tools). Pick one with rationale.
9. **Orchestrator-only MCP tools list** — which tools from items 1–3 (`rondel_heartbeat_read_all`, `rondel_goals_set_agent_goals`, `rondel_task_dispatch`, etc.) are orchestrator-gated. New tool `rondel_find_orchestrator` for cross-agent discovery.
10. **Pure role-resolution module** — `apps/daemon/src/agents/roles.ts` API: `findOrchestratorForOrg`, `listSpecialistsForOrg`, privileging helpers. Zero I/O.
11. **Discovery extension** — `rondel_list_agents` returns role; web UI filters by role.
12. **Hot-add semantics** — can an admin add an orchestrator at runtime? Can an existing specialist be promoted to orchestrator?
13. **Testing strategy** — unit (roles.ts pure functions), integration (CLI scaffold picks right template), end-to-end (add agent with role, spawn, tool gating works).
14. **Migration** — existing agent.json without `role`: treat as `specialist` silently.
15. **Open questions** — analyst / auditor roles (defer or pre-accommodate the field?), whether role can be changed on a live agent, how multi-org orgs with shared specialists work (can a specialist be in two orgs? orchestrator-per-org or orchestrator-can-span-orgs?).

---

## Deliverable

Save to `docs/phase-1/04-orchestrator-role-design.md`. Structure matching the synthesis sections. Editable, for iteration.

---

## Guardrails for this chat

- **Do not implement.** Design only.
- **Follow Rondel patterns** (CLAUDE.md): user-space vs framework-space boundary is critical (scaffolded template files are user-owned after creation; role-contract lives in framework).
- **Do not over-engineer.** Two roles for Phase 1. Don't design a full RBAC system.
- **Flag every trade-off** — I'll decide.
- **Preserve what Rondel has** — admin flag, discovery tools, scaffold logic, bridge admin API. Extend, don't replace.
- **Minimize this chat's context** — rely on subagents for external research; no reading OpenClaw or CortexOS source yourself.
