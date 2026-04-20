# Phase 1 Kickoff — Task Board Domain

## Your job in this chat

Design the **task board** capability for Rondel, to spec-level quality, following our modularity contract. **Do not implement it.** Produce a design document I can review, iterate on, and then hand to a future implementation chat. You will: (1) load context, (2) run two parallel research subagents to study OpenClaw and CortexOS, (3) study Rondel's patterns, (4) synthesize a clean design proposal.

---

## Context

### Rondel, in one paragraph
Rondel is a multi-agent orchestration framework built on the Claude CLI. It bridges messaging channels (Telegram today, a loopback web channel for the dashboard) to Claude processes with per-conversation isolation, durable scheduling, memory, approvals, and inter-agent messaging — all via first-class MCP tools. Today it is **reactive**: an agent process only exists while a user is talking to it. The long-term vision is an **agentic self-evolving harness** that manages real operations — a team of agents that wake up on their own, share a task board, cascade goals from a coordinator down to specialists, run nightly experiments to improve themselves, and give the user a daily rhythm of morning briefings and evening recaps.

### What Phase 1 is
Phase 1 adds the five foundations that turn Rondel proactive: **heartbeat ritual, task board, goal system, orchestrator role, morning/evening reviews**. Each sits atop Rondel's existing scheduler / ledger / bridge / memory foundation. Full plan: [`docs/PHASE-1-PLAN.md`](../PHASE-1-PLAN.md). Gap analysis: [`docs/GAP-ANALYSIS-CORTEXTOS.md`](../GAP-ANALYSIS-CORTEXTOS.md).

### This item — Task board
A shared work queue per organization — JSON files holding title, assignee, status (`pending` / `in_progress` / `blocked` / `completed` / `cancelled`), priority, DAG dependencies (`blocked_by[]`, `blocks[]`), deliverable path, result summary. Agents create tasks before starting work, atomically claim tasks (O_EXCL), block with reason when stuck, complete with result + deliverable. The board is the answer to "what's the fleet working on, what's stuck, what shipped today, who's responsible for X?" — today each conversation is an island. Once in place, the orchestrator dispatches work by creating tasks and specialists claim them. Details: [`docs/PHASE-1-PLAN.md`](../PHASE-1-PLAN.md) section 2.

### Files to read if you need depth
- `CLAUDE.md` — coding standards, modularity contract
- `ARCHITECTURE.md` — what exists in code today
- `docs/PHASE-1-PLAN.md` — section 2 (Task board)
- `docs/GAP-ANALYSIS-CORTEXTOS.md` — the "why"

---

## Step 1 — Parallel research (dispatch two subagents)

Dispatch two `Explore` subagents **in a single message so they run in parallel**. Each subagent produces a structured report using the shared schema below. Ask them for **concise findings — facts, schemas, file paths; no code dumps**. Do not read the external codebases yourself; rely on subagents.

### Subagent A — OpenClaw
**Path**: `/Users/david/Code/openclaw`
**Focus**: does OpenClaw have a task / job / work-queue concept? How do agents pick up work, hand off work, or track units of work across sessions? Any dependencies / blocked-by semantics? If there's no explicit task board, what's the nearest analogue (subagent result propagation, message queues, job records)?

### Subagent B — CortexOS
**Path**: `/Users/david/Code/cortextos`
**Focus**: map the full task system. Key files: `src/bus/task.ts` (the whole thing), `bus/create-task.sh` / `update-task.sh` / `complete-task.sh` / `claim-task.sh` (if present) / `check-stale-tasks.sh`, `templates/agent/.claude/skills/tasks/SKILL.md`, the audit-log layout at `orgs/{org}/tasks/audit/`, the `.claims/` directory semantics, and the DAG cycle-detection logic. Also cover: how staleness is defined, how approvals link to tasks, how the web dashboard reads task state.

### Shared output schema (both subagents must use this)

```
## 1. Concept presence
Yes / Partial / No — 1-sentence summary

## 2. Data model
- On-disk layout (exact paths)
- Schema (field list + types)
- Per-agent / per-org / global?
- Mutable state vs append-only audit

## 3. Code surface
- Modules owning the data + logic
- Key APIs: create, claim, update, complete, block, list, check-stale
- Store / service / tool separation (if any)

## 4. Concurrency + DAG
- How is atomic claim done? (locks, O_EXCL, transactions)
- Dependency resolution (blocked_by / blocks)
- Cycle detection

## 5. Trigger surfaces
- User creates task? Agent creates task? Cron creates task?
- Staleness detection trigger

## 6. Read / write surface
- Who writes?
- Who reads?
- How does task state reach an agent (pull via tool call, push via prompt, event)?

## 7. Discipline / contract
- Rules agents follow (e.g., create-before-work, update-on-start, complete-with-result)
- Where encoded (skill file, guardrails)

## 8. Lifecycle
- Create / claim / block / complete / archive / cancel
- Deliverables attachment
- Audit log shape

## 9. Integration points
- Approvals, ledger/events, notifications, dashboard streams

## 10. Strengths worth adopting for Rondel
## 11. Anti-patterns / not to copy
## 12. Key file paths (absolute)
```

---

## Step 2 — Rondel codebase research

Once both subagent reports are in, study Rondel itself to find the clean integration point. Look at:

1. **Domain templates** — `apps/daemon/src/approvals/` (closest analogue: mutable records, pending → resolved lifecycle, Telegram interaction, stream source). Study this first; task board has a similar shape.
2. **Scheduling** — `apps/daemon/src/scheduling/schedule-store.ts` / `schedule-service.ts`. Another good template for file-backed persistent state with a service layer.
3. **Ledger** — `apps/daemon/src/ledger/` for how events are emitted and consumed. Task state changes will emit here.
4. **Streams** — `apps/daemon/src/streams/` SSE pattern. The web UI will want a live task stream.
5. **Messaging** — `apps/daemon/src/messaging/` and `apps/daemon/src/routing/` for how inter-agent message delivery works (dispatching a task involves a notification).
6. **Subagents** — `apps/daemon/src/agents/subagent-manager.ts` and `subagent-process.ts`. Important: understand the difference between "ephemeral subagent returns result" and "persistent task claimed by another agent." Design must honor both.
7. **Bridge** — `apps/daemon/src/bridge/bridge.ts`, `admin-api.ts`, `schemas.ts`. New read endpoints for tasks.
8. **Shared types** — `apps/daemon/src/shared/types/` — existing patterns (branded types for IDs, zero runtime imports).
9. **Hooks** — `apps/daemon/src/shared/hooks.ts` — hook names, emission patterns.
10. **Org isolation** — how the bridge already enforces org boundaries; task board inherits this.
11. **Atomic writes** — find any existing atomic-write utility in Rondel; if none, document the decision to use `writeFileSync(..., {flag: 'wx'})`.

---

## Step 3 — Synthesize the design

Produce a design document that answers:

1. **Scope** — what's in for Phase 1, what's explicitly deferred (e.g., recurring tasks, task templates, time-tracking).
2. **Data model** — `TaskRecord` + `TaskAuditEntry` shapes, file layout (`state/tasks/{org}/task_*.json` + `state/tasks/{org}/audit/{id}.jsonl`), Zod schemas, ID format.
3. **DAG module** — pure functions for cycle detection + blocked-by resolution. Interface.
4. **Module layout** — file tree under `apps/daemon/src/tasks/`, barrel exports, public vs internal API, separation between `task-dag.ts` (pure), `task-store.ts` (I/O), `task-service.ts` (business logic).
5. **Concurrency model** — how atomic claim works; what happens on a conflict; what timeout / retry semantics apply.
6. **MCP tool surface** — `rondel_task_create`, `rondel_task_claim`, `rondel_task_update`, `rondel_task_complete`, `rondel_task_block`, `rondel_task_list` — schemas, privileges (who can assign? who can claim? orchestrator-only writes vs agent self-claims).
7. **Bridge endpoints** — `GET /tasks/:org`, `GET /tasks/:org/:id`, any admin-only mutation routes.
8. **Stream source** — event shape, filter semantics (per-org subscriptions).
9. **Ledger events** — names and payloads: `task:created`, `task:claimed`, `task:blocked`, `task:completed`, `task:stale`.
10. **Approval integration** — when a task has `external_action: true`, completion routes through `approvals/`. Specify the contract without coupling modules.
11. **Staleness model** — thresholds (e.g., in_progress > 2h, pending > 24h, due_date past), where the check runs (inside the heartbeat skill? a dedicated cron?), how results surface.
12. **Framework skill** — prose content of `rondel-task-management/SKILL.md`: the discipline (create before work, claim atomically, block with reason, complete with result + deliverable).
13. **Relationship to `rondel_send_message` and subagents** — explicit decision-tree for when to use a task vs a message vs a subagent.
14. **Testing strategy** — unit (DAG pure functions), integration (concurrent-claim races, staleness detection), end-to-end (orchestrator creates → specialist claims → completes).
15. **Migration** — state directory creation, no existing-install breakage.
16. **Open questions** — fan-in/fan-out dependency semantics, recurring tasks, reassignment rules, archival policy.

---

## Deliverable

Save to `docs/phase-1/02-task-board-design.md`. Structure matching the synthesis sections. Editable, for iteration.

---

## Guardrails for this chat

- **Do not implement.** Design only.
- **Follow Rondel patterns** (CLAUDE.md).
- **Do not over-engineer.** Defer anything CortexOS has that we don't need for Phase 1.
- **Flag every trade-off** — I'll decide.
- **Preserve what Rondel has** — use existing scheduler, ledger, bridge, approvals. Don't rebuild.
- **Minimize this chat's context** — rely on subagents for external research; no reading OpenClaw or CortexOS source yourself.
