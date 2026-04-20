# Phase 1 — Foundations for Proactivity

> Working document. Goal: turn Rondel from a reactive request/response system into a proactive agent team with a daily rhythm, shared work queue, and coordinator. Each section is meant to be discussed, challenged, and edited — not executed as-is.

## Overview

Phase 1 adds five capabilities that, together, give Rondel the minimum substrate for agent operations management. They stack:

```
┌───────────────────────────────────────────────────────┐
│ Rituals     │ morning-review • evening-review         │  (skills + crons)
├───────────────────────────────────────────────────────┤
│ Discipline  │ heartbeat                               │  (skill + cron)
├───────────────────────────────────────────────────────┤
│ Domains     │ tasks  │  goals  │  heartbeats          │  (daemon modules)
├───────────────────────────────────────────────────────┤
│ Roles       │ orchestrator (template + role field)    │  (config + templates)
├───────────────────────────────────────────────────────┤
│ Foundation  │ scheduler • ledger • bridge • memory    │  (already exists ✓)
└───────────────────────────────────────────────────────┘
```

Each layer depends downward. Each can be built, tested, and shipped independently.

## Shared modularity contract

Every new domain in Phase 1 follows the same Rondel pattern:

- **Domain directory** `apps/daemon/src/<domain>/` with a barrel `index.ts`. External consumers import from the directory, not internal files.
- **Store / Service / MCP tools split**:
  - **Store** — file I/O only. Testable in isolation. No cross-domain imports.
  - **Service** — business logic. Depends on store + hooks. Dependency-injected.
  - **MCP tools** — thin adapters registered by the bridge.
- **Types** in `shared/types/<domain>.ts` (zero runtime imports, pure type definitions).
- **Zod validation** at HTTP and MCP boundaries.
- **Stream source** in `streams/<domain>-stream.ts` for SSE to the web UI.
- **Hooks over direct calls** for cross-cutting emissions (ledger, streams, approvals).
- **User-space vs framework-space**: scaffolded files (`GOALS.md`, `GUARDRAILS.md`) live in the agent's workspace and are user-editable after scaffolding. Framework invariants stay in `framework-context/` or MCP tool descriptions.
- **Org isolation**: no cross-org reads or writes unless explicitly allowed, matching the bridge's existing enforcement.

---

## 1. Heartbeat skill + cron

### What it is

A scheduled wake-up that every agent runs every 4 hours. The cron fires a prompt into the agent's live session telling it to run a short discipline checklist: "check your inbox, update your current status, glance at your tasks, verify your goals aren't stale, note anything worth remembering, log that you're alive." The *heartbeat* is the record that comes out of this check — a tiny JSON file saying "agent X was alive at time T, currently working on Y, mode is day/night." With this one primitive, a dormant conversation becomes an agent with a pulse: the orchestrator can see the fleet, you can spot crashed agents, and every downstream discipline (stale-task sweeps, memory checkpoints, goal staleness, guardrail self-checks) naturally plugs into the heartbeat turn instead of needing its own cron.

### What it contains

- **New domain `apps/daemon/src/heartbeats/`**
  - `heartbeat-types.ts` — `HeartbeatRecord` (agent, org, status, current_task, mode, last_update)
  - `heartbeat-store.ts` — reads/writes `state/heartbeats/{agent}.json`
  - `heartbeat-service.ts` — `update()`, `readAll(org?)`, `findStale(thresholdMs)`
  - barrel `index.ts`
- **Stream source** `streams/heartbeat-stream.ts` → SSE to the web UI fleet grid.
- **Shared types** in `shared/types/heartbeats.ts`.
- **MCP tools** registered by the bridge:
  - `rondel_heartbeat_update` — agent writes its own status + current_task
  - `rondel_heartbeat_read_all` — orchestrator-only; returns fleet health (org-scoped)
- **Bridge endpoint** `GET /heartbeats/:org` for the web UI (read-only).
- **Framework skill** `rondel-heartbeat/SKILL.md` — the discipline checklist (sweep inbox, check tasks/goals, self-check guardrails, update memory, update heartbeat).
- **Default cron** installed into the agent template's `agent.json` — `every 4h`, triggers the skill.
- **Ledger events** — `heartbeat:updated`, `heartbeat:stale` (emitted by the service, consumed by orchestrator fleet-health).

### Why it's wired this way

- **Store/service split** mirrors `approvals/` and `scheduling/` — pure I/O module is property-testable without runtime state.
- **Built on the existing scheduler** instead of a bespoke loop — one scheduling primitive in the app.
- **Fires via `--resume` into the agent's live session** so the heartbeat turn has full context. This is the key advantage over CortexOS's fire-and-forget PTY injection.
- **Discipline lives in Markdown, liveness in JSON** — the user can tune the skill without being able to delete the pulse.

### How we benefit

- Fleet dashboard becomes real (every agent has a last-seen timestamp and current task).
- Stale-agent detection becomes possible — orchestrator's fleet-health skill polls `readAll()` and flags anyone >5h silent.
- Every downstream discipline (task sweeps, memory checkpoints, guardrail self-checks, goal staleness) naturally plugs into the heartbeat turn.

### Modularity wins

Any future "check X every N minutes" behavior (KPI snapshot, calendar sync, Linear poll) uses the same cron + skill pattern — no new subsystem. The stream source decouples web from daemon; the web UI can be replaced without touching the domain.

### Potential overlaps with what we already have

- **`rondel_schedule_*`** — we already have durable scheduling. Heartbeat is not a replacement; it's a specific, canonical *use* of it. The scheduler is a generic timer engine; the heartbeat is one scheduled skill among many.
- **Ledger (`state/ledger/{agent}.jsonl`)** — we already log structured events. Heartbeat adds two new event kinds (`heartbeat:updated`, `heartbeat:stale`) to the existing ledger — no parallel log system.
- **`MEMORY.md`** — we already have per-agent memory. The heartbeat skill *writes* to memory (as part of its checklist) but doesn't replace the memory store.
- **`rondel_system_status` / `rondel_agent_status`** — these exist and report process-level liveness (is the Claude process running, is the session fresh). Heartbeat is *application-level* liveness (did the agent run its discipline in the last 4 hours?). Different question; complementary signal.
- **Per-conversation isolation** — heartbeats write to `state/heartbeats/{agent}.json`, one file per agent regardless of conversations. The heartbeat is an agent-level fact, not a per-conversation fact. It uses the agent's main conversation session for the cron turn, but the record is agent-scoped.

---

## 2. Task board

### What it is

A shared work queue per organization — a directory of JSON files where every piece of work >10 minutes gets a record with a title, an assignee, a status, a priority, dependencies on other tasks, and a deliverable path. Agents create tasks before they start work, atomically claim tasks when they pick them up, block tasks with a reason when stuck, and complete tasks with a result summary when done. The board is the answer to "what's the fleet working on right now, what's stuck, what shipped today, who's responsible for X?" — today each conversation is an island with no way to answer those questions across agents. Once in place, the orchestrator can tell specialists "here's today's backlog, pick it up," and you can hand the system a goal and watch it decompose into claimable work.

### What it contains

- **New domain `apps/daemon/src/tasks/`**
  - `task-types.ts` — `TaskRecord`, `TaskStatus` (`pending` | `in_progress` | `blocked` | `completed` | `cancelled`), `TaskPriority`
  - `task-dag.ts` — **pure** cycle-detection + blocked-by resolution (no I/O, fully unit-testable)
  - `task-store.ts` — atomic claim via `writeFileSync(..., {flag: 'wx'})`, append-only audit log at `state/tasks/{org}/audit/{id}.jsonl`
  - `task-service.ts` — `create`, `claim`, `update`, `complete`, `block`, `list`, `findStale`
  - barrel `index.ts`
- **MCP tools** — `rondel_task_create`, `rondel_task_claim`, `rondel_task_update`, `rondel_task_complete`, `rondel_task_block`, `rondel_task_list` (filters: assignee, status, stale-only, org).
- **Bridge endpoints** — `GET /tasks/:org`, `GET /tasks/:org/:id`.
- **Stream source** `task-stream.ts` — live board updates for web UI.
- **Ledger events** — `task:created`, `task:claimed`, `task:completed`, `task:blocked`, `task:stale`.
- **Approval integration** — a task with `external_action: true` in its metadata routes completion through `approvals/` before the state transition commits.
- **Framework skill** `rondel-task-management/SKILL.md` — the discipline: "create task before work >10min, claim atomically, complete with result + deliverable path."
- **Stale-task detection** runs inside the heartbeat skill (no separate cron needed).

### Why it's wired this way

- **DAG logic in a pure module** — property testing without filesystem fixtures.
- **O_EXCL atomic claim** — multi-agent race-free without a distributed lock. Filesystem is the lock.
- **Per-org directory** mirrors existing bridge-enforced org isolation. Cross-org tasks are impossible by construction.
- **MCP tools are thin wrappers** — all logic lives in the service. Swapping the file store for Postgres later is a one-file change.
- **Audit log separate from the task file** — full history without mutating the primary record. "Show me this task's lifecycle" is a file concat.

### How we benefit

- You can tell your orchestrator "here's today's backlog" and have the DAG sort itself out.
- Stale detection surfaces crashed or stuck agents before you notice by hand.
- Deliverable tracking makes "what did the fleet actually produce?" a query instead of an interpretation.
- Web UI gets a Trello-like board for free — just subscribe to the stream.

### Modularity wins

Tasks become the **spine** for every downstream discipline. Experiments are tasks. Approvals reference tasks. Morning reviews dispatch tasks. One domain, many consumers. Third-party integrations (Linear sync, GitHub issue bridge) slot in as listeners to the ledger events — they never touch the task module directly.

### Potential overlaps with what we already have

- **Ledger** — the ledger records *what happened* (events, historical, append-only). The task board records *what needs to happen and who's doing it* (state, mutable, queryable by status). They're complementary: task state changes emit ledger events, but you cannot query the ledger for "what's in progress right now" — that's what the task board is for.
- **`rondel_send_message`** — today, delegating work means messaging another agent and waiting for a reply. That's fine for one-off asks, but it doesn't persist, doesn't track completion, doesn't handle dependencies, and doesn't survive a restart. Task board keeps `rondel_send_message` for lightweight Q&A and moves durable work-delegation into tasks. In practice: dispatching a task still triggers a `rondel_send_message` notification, but the task record is the source of truth.
- **Subagents (`rondel_spawn_subagent`)** — subagents are ephemeral workers that return a result to the caller. They're good for "run this search and tell me what you found." They are **not** a work queue — they don't persist, they can't be reassigned, they don't survive restarts, and they can't be claimed by a different agent. Task board serves a different need: persistent, claimable, multi-agent work.
- **Scheduler (`rondel_schedule_*`)** — schedules are timer-triggered work ("run this at 8am"). Tasks are status-tracked work ("this needs doing, someone claim it"). A scheduled cron can *create* a task (e.g., weekly report task every Monday), but tasks and schedules answer different questions.
- **Approvals** — approvals are human-in-the-loop gates on specific tool calls. Tasks are unit-of-work records. A task *can* require an approval before completing (external-action tasks), but an approval is never a substitute for a task.

---

## 3. Goal system

### What it is

An explicit objectives layer for the org and every agent in it. One north-star per org (the long-term mission), one daily-focus (what we're pushing today), and per-agent goals (what this specific agent should care about today). Goals get set by the user through the orchestrator each morning and cascade down to specialists — each agent's daily goals are written by the orchestrator and injected into that agent's system prompt on every turn so they see it without having to query anything. Today, agents have durable identity (who they are) and memory (what they've learned), but no explicit *today* layer — no answer to "what am I supposed to be doing right now?" The goal system fills that gap with a machine-readable state that the whole fleet respects and that the user can edit live when priorities shift mid-day.

### What it contains

- **New domain `apps/daemon/src/goals/`**
  - `goal-types.ts` — `OrgGoals` (north_star, daily_focus, daily_focus_set_at), `AgentGoals` (focus, goals[], bottleneck, updated_by)
  - `goal-store.ts` — reads/writes `state/goals/{org}/goals.json` + `state/goals/{org}/agents/{name}.json`
  - `goal-service.ts` — `setNorthStar`, `setDailyFocus`, `setAgentGoals`, `checkStaleness(now)`, `renderGoalsMd(agent)` (emits a user-editable `GOALS.md` into the agent's workspace)
  - barrel `index.ts`
- **New prompt section** `config/prompt/sections/goals.ts` — pure builder that emits a `## Current Focus` block. Wired into `buildPrompt` for `main` mode (not `cron`, not `agent-mail` — goals shouldn't bloat ephemeral turns).
- **MCP tools** — `rondel_goals_set_north_star` (orchestrator-only), `rondel_goals_set_daily_focus` (orchestrator-only), `rondel_goals_set_agent_goals` (orchestrator targets specialists), `rondel_goals_get` (self-read; org-scoped cross-agent read for orchestrator).
- **Bridge endpoints** — `GET /goals/:org`, `GET /goals/:org/:agent`.
- **Stream source** for live updates.
- **Ledger events** — `goals:daily_focus_set`, `goals:cascaded`, `goals:stale`.

### Why it's wired this way

- **Prompt section, not runtime tool read** — goals change once a day; querying on every turn would waste context. Inject at prompt assembly, same pattern as existing workspace/context sections.
- **Store splits org-level vs per-agent** — clean schemas, trivial migrations.
- **Staleness as a pure function** — the heartbeat calls `checkStaleness()`; the logic isn't scattered across consumers.
- **Service-rendered `GOALS.md` in user space** — the user can hand-edit today's goals mid-day and the orchestrator respects it on next cascade. Collaborative file, not a machine-only file.
- **Tool gating by role** — orchestrator-only tools live in the orchestrator template's `tools.allowed` and are rejected for other agents at the MCP registration layer.

### How we benefit

- Every agent sees its daily focus on every turn. "What am I supposed to be doing?" becomes unanswerable as a question.
- User sets today's focus once; the whole fleet knows by 08:05.
- Goal staleness becomes a detectable state — if you skip a morning review, the heartbeat flags it and the orchestrator triggers catch-up.

### Modularity wins

Goals depend only on hooks + shared types. Any future "OKR progress tracker" or "north-star drift detector" reads the same store. Adding "also show the top 3 KPIs" in the prompt = a second section file; no refactor.

### Potential overlaps with what we already have

- **`workspaces/global/CONTEXT.md` and `{org}/shared/CONTEXT.md`** — these are static shared context: "here's what this company is, here's what matters about this org." They change rarely and are user-maintained. Goals are *dynamic*: the daily focus changes every morning, agent goals change every morning and sometimes mid-day. Trying to put daily goals in `CONTEXT.md` would thrash the file. They complement each other: CONTEXT.md = "who we are," goals = "what we're doing today."
- **`IDENTITY.md`** — durable agent identity (name, role, voice). Goals are today-specific directives. Identity doesn't change daily; goals do. The prompt injects both.
- **`MEMORY.md`** — accumulated learnings ("I remember X about the user"). Goals are forward-looking ("today we're shipping X"). Memory is backward, goals are forward.
- **`USER.md`** — user preferences ("this user likes terse responses"). Orthogonal to goals.
- **Existing prompt assembly (`config/prompt/`)** — goals plug in as one more pure section builder alongside the existing 11 sections. The pipeline already supports this cleanly.

---

## 4. Orchestrator role + template

### What it is

A new kind of agent — the orchestrator — whose contract is "I never do specialist work; I only route, cascade, and unblock." The orchestrator is what you talk to at 8am to set today's focus; it breaks that focus into tasks and dispatches them to specialists; every 4 hours it reads the fleet's heartbeats and intervenes on stale approvals or crashed agents; at 6pm it reports what shipped. Structurally, "orchestrator" is a `role` field on `agent.json` (default: `specialist`) plus a scaffolded template with its own personality, its own cron set (morning + evening + heartbeat), and access to a pack of orchestrator-only MCP tools (read all heartbeats, set other agents' goals, dispatch tasks). Same binary, same runtime — just a different scaffold and a different tool allowlist. This is the piece that makes the fleet *a team* instead of a bag of peers.

### What it contains

- **Schema change** in `shared/types/config.ts`: add `role: "orchestrator" | "specialist"` (optional, default `"specialist"`) to the `AgentConfig` Zod schema.
- **New agent template** at `apps/daemon/templates/context/orchestrator/`:
  - `AGENT.md` — coordinator personality (no specialist work)
  - `SOUL.md` — the contract ("I dispatch, I never do")
  - `IDENTITY.md` scaffold, `GOALS.md` scaffold with north-star placeholder
  - `BOOTSTRAP.md` — first-run onboarding (ask for north-star, enumerate specialists, confirm morning/evening times)
  - `agent.json` defaults with `role: "orchestrator"` and morning + evening + heartbeat crons pre-installed
- **New pure module** `apps/daemon/src/agents/roles.ts` — `findOrchestratorForOrg(org, agents)`, `listSpecialists(org, agents)`. Used by a new MCP tool `rondel_find_orchestrator`.
- **CLI changes** — `rondel add agent --role orchestrator|specialist`; `rondel init` asks "scaffold an orchestrator?" and creates both.
- **Orchestrator-only framework skill pack** (all under `templates/framework-skills/.claude/skills/`):
  - `rondel-morning-review`
  - `rondel-evening-review`
  - `rondel-goal-cascade`
  - `rondel-fleet-health`
  - `rondel-approval-escalation`
  - `rondel-task-dispatch`
- **Skill gating** — skills check the calling agent's `role` via MCP context; specialists see the skill but invoking it no-ops with a clear message. (Alternative: role-filtered `--add-dir` at spawn time — slightly more elegant but changes the skill-discovery story.)

### Why it's wired this way

- **Role is config, not code** — same binary, same runtime, different template + scaffolded crons. One orchestrator or ten specialists, all identical infrastructure underneath.
- **Pure role-resolution module** — no dependencies, trivial to test, trivial to extend with new roles later.
- **Personality in user space, contract in framework** — the user owns how their orchestrator talks; the framework owns what role implies (tool allowlist, skill pack, cron defaults).
- **Orchestrator-only tools via allowlist** — `rondel_goals_set_agent_goals`, `rondel_heartbeat_read_all`, etc. live in the orchestrator template's `tools.allowed` and get registered conditionally. No global gating code.

### How we benefit

- One command to get a "Chief of Staff": `rondel add agent boss --role orchestrator`.
- Natural privilege ladder — orchestrator sees the fleet, specialists don't.
- Multi-org scales linearly: one orchestrator per org, each managing its own fleet with its own goals.

### Modularity wins

Future roles (analyst, auditor, ops-lead) are the same pattern: template + skill pack + tool allowlist. No role-specific code branches in the daemon. Specialists stay cheap — they don't carry orchestrator baggage.

### Potential overlaps with what we already have

- **`admin: true`** — today's privilege flag. An admin agent gets admin MCP tools (add/update/delete agents, set env, reload). That's a *privilege* dimension, orthogonal to *role*. In practice the first agent is usually both admin *and* orchestrator, but the dimensions are independent: you could have a non-admin orchestrator in a second org, or an admin specialist used only for devops. Keep both.
- **Agent discovery** — we already have `rondel_list_agents`, `rondel_list_teammates`, `rondel_list_orgs`. The role field is additional metadata returned by these tools; no parallel discovery mechanism.
- **Skills system** — we already have framework skills (`rondel-create-agent`, etc.) and per-agent skills. Orchestrator-only skills are just another category shipped in framework skills; the discovery mechanism (`--add-dir`) doesn't change. What changes is the skill *content* — it's written assuming the caller is an orchestrator.
- **Agent templates** — we already have an agent template (`templates/context/AGENT.md`, etc.). The orchestrator template is a *second* template, parallel to the existing one. `rondel add agent` picks the right one based on `--role`.
- **`rondel_send_message`** — dispatching a task to a specialist still flows through the existing inter-agent messaging. The orchestrator-specific addition is the *discipline* (cascade in the morning, dispatch through tasks, don't do the work yourself), not a new transport.

---

## 5. Morning + evening review skills

### What it is

The rhythm. Two crons — 08:00 and 18:00 — that turn the orchestrator into a daily operator with a user-facing cadence. At 08:00 the orchestrator wakes, reads overnight heartbeats, checks what shipped yesterday, sends you a briefing: "Here's last night's work, here's the north-star, what's the focus today?" You answer, it cascades goals to specialists, creates the initial task backlog, and dispatches. At 18:00 it reads the day's completions, evaluates the morning's plan against reality, and sends you a recap. Everything is in Markdown skills — no new daemon code, no new mechanism. The crons use the existing scheduler; the skills use the existing prompt assembly; the user dialog uses the existing channel flow. Once in place, the Telegram chat with your orchestrator stops being "I wonder what he did today" and becomes a morning briefing, an approved plan, an evening recap. The system has a daily metabolism.

### What it contains

- **Two framework skills**:
  - `rondel-morning-review/SKILL.md` — the 08:00 ritual
  - `rondel-evening-review/SKILL.md` — the 18:00 ritual
- **Morning-review script** (prose, not code):
  1. Call `rondel_heartbeat_read_all`, `rondel_task_list --since 18:00-yesterday --status completed`, `rondel_ledger_query` for overnight events.
  2. Read org goals; compute daily-focus staleness.
  3. Send user briefing message #1 (overnight recap + yesterday's completions + today's north-star).
  4. Ask: "What's today's focus?" — yield; user replies via normal channel flow (no new mechanism needed — the cron turn just waits for the next user message).
  5. On reply: `rondel_goals_set_daily_focus`, then `rondel_goals_set_agent_goals` for each specialist with role-matched goals.
  6. `rondel_task_create` for the initial backlog; `rondel_send_message` to notify each specialist.
  7. Send user message #2 (task plan) and #3 (confirmation).
  8. Emit ledger event `review:morning_completed`.
- **Evening-review script**:
  1. Gather day's completed tasks, unresolved approvals, missed heartbeats.
  2. Self-evaluate against morning's plan.
  3. Send user summary (what shipped, what slipped, what's queued for tomorrow).
  4. Pre-create tomorrow's task skeleton (blocked on overnight work).
  5. Emit ledger event `review:evening_completed`.
- **Default crons** in the orchestrator template's `agent.json`:
  ```json
  "crons": [
    { "name": "morning-review", "schedule": "0 8 * * *", "prompt": "Run the rondel-morning-review skill." },
    { "name": "evening-review", "schedule": "0 18 * * *", "prompt": "Run the rondel-evening-review skill." },
    { "name": "heartbeat", "schedule": "every 4h", "prompt": "Run the rondel-heartbeat skill." }
  ]
  ```
- **No new daemon code** — reuses existing `cron-preamble.ts`, existing skill dispatch, existing `rondel_schedule_*`.

### Why it's wired this way

- **Skills, not code** — the review logic is behavioral (what to say, in what order, with what tone). Markdown the user can tune beats TypeScript that requires a rebuild.
- **Crons in the template, not hardcoded** — user can move morning to 9am or kill evening reviews with one config edit.
- **User dialog built into the skill** — morning review is a conversation, not a dump. The cron fires → agent messages user → waits (conversation just sits idle like any main-mode turn) → user replies → agent continues. No new mechanism.
- **Sits on top of tasks + goals + heartbeat** — these skills are worthless without the three domains beneath. This is why Phase 1 is ordered the way it is.

### How we benefit

- This is the piece you *feel*. Your Telegram chat with Boss stops being "I wonder what he did" and becomes "morning brief → approve plan → evening recap."
- The system now has a daily metabolism.
- All the earlier infrastructure gets exercised daily, so bugs surface fast.

### Modularity wins

New rituals (weekly review, monthly board summary, Friday retro) = more skills + more crons. Same pattern. Skills can be hot-edited without a daemon restart via `rondel_reload_skills`.

### Potential overlaps with what we already have

- **`rondel_schedule_*` + `cron-preamble.ts`** — morning and evening reviews are not new infrastructure. They are *one cron entry each* using the scheduler we already ship. The cron preamble module already handles how a cron-mode prompt composes. The only new pieces are the two Markdown skill files and the default cron entries in the orchestrator template.
- **Framework skills system** — we already have the skill mechanism (`--add-dir` injection, `rondel_reload_skills`, skill discovery). Morning/evening reviews are two more skills shipped in the framework skills directory. No new discovery or loading code.
- **Existing cron jobs** — we can already schedule arbitrary prompts. What's missing is not the scheduling — it's the *structured rituals* (the checklist, the message format, the discipline of goals cascade + task dispatch + user dialog). That structure lives in the skill's prose, not in code.
- **Inter-agent messaging** — the goal-cascade and task-dispatch steps reuse `rondel_send_message` and the planned task tools. No new transport.
- **User conversation flow** — the skill's "ask user what the focus is, wait for reply" is not a new mechanism; it's the same synchronous main-mode turn that every user conversation uses. The cron-triggered turn just happens to send the first message.

---

## Recommended engineering order inside Phase 1

1. **Heartbeat domain** — smallest touch surface (scheduler + bridge + one MCP tool + one skill). Ship, dogfood a week.
2. **Task board** — biggest lift, but fully independent.
3. **Goal system** — needs the prompt-section plumbing; otherwise cheap.
4. **Orchestrator role + templates** — configuration work, small.
5. **Morning/evening skills** — pure Markdown; untestable without the four above, so naturally last.

## Open questions / to iterate on

- Do we want per-conversation heartbeats or per-agent heartbeats? (Plan says per-agent; per-conversation might be useful for long-running multi-user bots.)
- Should task DAGs support fan-in / fan-out (N → 1 blocking relationships, not just 1 → N)?
- Is `role` a single-value field or can an agent carry multiple roles? (Plan: single-value; orchestrator-as-specialist hybrid is discouraged by design.)
- Should `GOALS.md` be rendered inline into the prompt, or kept in the workspace and referenced? (Plan: rendered + injected via prompt section for reliability.)
- What's the right staleness threshold for heartbeats? (Plan: 5h; worth testing.)
- How does cron-triggered user dialog interact with ongoing user conversations? Do we queue, interrupt, or defer if the user is mid-conversation?
