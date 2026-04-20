# Gap Analysis: Rondel vs CortexOS

> Deep comparison to understand what makes CortexOS agents intelligent, self-evolving, and proactive — and what Rondel needs to build to get there. Based on a code-level investigation of `/Users/david/Code/cortextos` (April 2026).

---

## TL;DR in one paragraph

CortexOS doesn't have smarter models than Rondel — it has a **weave of disciplines layered on top** that turn each Claude process into a self-managing operator. The seven pillars are: (1) a **12-layer system prompt** with identity/soul/guardrails/goals/memory/team-map; (2) **3-layer memory** — daily log, long-term MEMORY.md, and a semantic KB (ChromaDB) that every agent queries *before* starting work and writes to *after* finishing; (3) a **file-based coordination bus** for tasks (with DAG dependencies + stale detection), approvals, inbox messages, heartbeats; (4) **cron-driven proactivity** — heartbeats every 4h, morning/evening reviews, daemon-side gap detection every 10min that nudges silent agents; (5) a **standing orchestrator role** that only routes and cascades goals, plus a **standing analyst role** that runs system-wide experiments; (6) **guardrails self-improvement** — agents log near-misses and extend `GUARDRAILS.md` each heartbeat; (7) **theta-wave autoresearch** — structured hypothesis→measure→keep/discard cycles assigned to each agent. Rondel already has the low-level scaffolding (scheduler, ledger, per-agent memory, inter-agent mail, skills, approvals, org isolation, HTTP bridge) — what's missing is the **discipline layer sitting on top of that scaffolding**.

---

## The mental model shift

**Rondel today** is *reactive*: an agent process only exists while a user is talking to it. `rondel_schedule_*` cron jobs spawn *new* processes for one-shot runs. There is no continuous agent presence, no standing task board, no cross-agent awareness beyond a 1-turn `rondel_send_message`, no rhythm.

**CortexOS** is *resident*: every agent is an always-on `node-pty` session sitting in the Claude REPL, and the daemon's `FastChecker` polls inbox + Telegram every 1s and **injects prompts into the live PTY via bracketed-paste**. Cron, user messages, approvals, and inter-agent messages all enter the same running conversation — continuity is preserved. The agent has a persistent 4h heartbeat ritual, so even idle it keeps a pulse.

You do **not** need to copy CortexOS's PTY model to get CortexOS's behavior. Rondel's scheduler + cron preamble + persistent sessions-resume (`--resume <session-id>`) already allow most of the same effects — what's missing is the **discipline layer** (tasks, heartbeats, goals, KB, guardrails-evolution, standing roles, morning/evening rhythm).

---

## Gap matrix (at a glance)

| Capability | CortexOS | Rondel today | Severity |
|---|---|---|---|
| Persistent agent presence | 24/7 PTY | Process dies when conversation idle | Medium — scheduler can emulate |
| Daemon gap detection | Every 10min, nudges silent agents | None | **High** |
| Heartbeat ritual | Every 4h, writes to `heartbeat.json` | None | **High** |
| Shared task board with DAG | `tasks/task_*.json`, `blocked_by`, stale detection | None | **Critical** |
| Approval workflow for external actions | `create-approval` + Telegram inline buttons | Exists (per-tool classifier + inline buttons) | **Parity** ✓ |
| Inter-agent async messaging | File inbox, priority, FIFO, retry, HMAC | `rondel_send_message` (1-turn, synchronous inbox) | Partial — needs priority, retry, queue semantics |
| Structured event log | `analytics/events/{agent}/YYYY-MM-DD.jsonl` | `state/ledger/{agent}.jsonl` | **Parity** ✓ |
| Standing **orchestrator** role | Dedicated agent template + 27 skills | No role distinction | **Critical** |
| Standing **analyst** role | Dedicated agent template + 14 skills | No role distinction | **High** |
| Goal cascade (daily focus per agent) | `goals.json` per agent, regen `GOALS.md` each morning | None | **Critical** |
| Morning/evening briefings | 2 skills, 3-message Telegram format, goal-setting dialog | None | **High** |
| 3-layer memory (daily + MEMORY.md + semantic KB) | ChromaDB per agent + per org | Only `MEMORY.md` (1 layer, flat file, no search) | **Critical** |
| Knowledge-base query-before-research discipline | `kb-query` mandatory before tasks; `kb-ingest` after | Absent | **Critical** |
| Guardrails file + self-improvement loop | `GUARDRAILS.md` + heartbeat self-check + extend on new pattern | Absent | **High** |
| Theta-wave autoresearch / experiments | Per-agent research cycles + analyst nightly scan + `results.tsv` + `learnings.md` | Absent | **High** |
| Cron "nudge on gap" watchdog | `gap_detected` fires if interval*2 elapsed | Schedule watchdog exists but different semantics | Partial |
| Deliverable standard | `require_deliverables` flag — tasks must have file output | Absent | Medium |
| Auto-commit skill | `auto-commit.sh` with credential/size guards | Absent | Medium |
| Community skill catalog | `community/catalog.json` + install/submit flow | Skills exist per-agent but no distribution | Low |
| Day/night mode detection | UTC timezone → changes behavioral expectations | Absent | Low |
| Per-org shared knowledge (`knowledge.md`) | Yes, injected into prompt | `{org}/shared/CONTEXT.md` exists | **Parity** ✓ |
| Multi-layer prompt assembly | 12 layers across 10+ files | ~8 sections via `config/prompt/` pipeline | **Parity** ✓ (Rondel's is cleaner) |
| MCP tool architecture | Shell scripts via `bus/` subprocess calls | First-class MCP tools with safety classifiers | **Rondel wins** ✓ |
| Per-conversation isolation | No — one PTY per agent, all users share | Yes — `(agentName, chatId)` → unique process | **Rondel wins** ✓ |

---

## The 10 gaps that matter — ranked

### 1. No standing task board (CRITICAL)

**What CortexOS does**
Every piece of work >10min gets a JSON file in `orgs/{org}/tasks/task_*.json` with fields: `title`, `assigned_to`, `status` (pending/in_progress/blocked/completed), `priority`, `blocked_by[]`, `blocks[]`, `result`, `due_date`. The system enforces invariants:
- Create task **before** starting work (AGENTS.md step 1).
- `list-tasks --status in_progress` run every 4h surfaces **stale** tasks (in_progress >2h → crashed agent; pending >24h → no one claimed; due_date past → overdue).
- Tasks have a DAG: `blocked_by` stops an agent from claiming; `complete-task` unblocks dependents.
- Atomic claim via `writeFileSync(..., {flag: 'wx'})` — race-free multi-agent claiming.
- Every status change logs a `task_*` event → dashboard Activity feed.

**What Rondel has**
Nothing. The ledger captures some inter-agent events, but there's no shared work queue agents can read. Each conversation is an island.

**Why it matters for managing operations**
Without a task board, agents can't be told "here's your backlog, work through it." Every command is point-in-time. You lose: visibility, ownership, dependency tracking, redistribution of stale work, accountability.

**What to build**
`rondel_task_*` MCP tool family + `state/tasks/{org}/` directory. Schema identical to CortexOS. Add `rondel_task_claim` (atomic O_EXCL), `rondel_task_list` (filter by assignee, status, org), `rondel_task_check_stale` (called from a heartbeat cron). Web dashboard gets a Tasks page reading from `state/tasks/`. Ledger emits `task_created` / `task_claimed` / `task_blocked` / `task_completed` events. Enforce via skill: "Before any work >10min, create a task."

---

### 2. No heartbeat ritual (CRITICAL for proactivity)

**What CortexOS does**
Every agent writes `state/{agent}/heartbeat.json` every 4h via a persistent cron. Heartbeat is not just liveness — it's a **10-step discipline checklist** (HEARTBEAT.md): update heartbeat → sweep inbox → check fleet health (orchestrator only) → log event → write daily memory → check goals → resume tasks → self-check guardrails → update MEMORY.md → re-ingest memory to KB. The daemon's idle-session watchdog also injects a synthetic heartbeat every 50min if the agent's been silent. Stale >5h heartbeat = agent flagged red, orchestrator alerted.

**What Rondel has**
Nothing. Agents only do work when a user sends a message. If an agent is handling an ongoing initiative, there's no scheduled "wake up, check state, continue" cycle.

**What to build**
A **Heartbeat skill** in `framework-skills/`, with a default `rondel_schedule_create` entry in every new agent's bootstrap: "every 4h, run heartbeat." The skill executes a checklist (task sweep, memory update, guardrails check). Writes to `state/heartbeats/{agent}.json`. Ledger emits `heartbeat` event. Web UI shows fleet grid with last-seen timestamps. Critical: the cron fires into the agent's **main session** (via `--resume`), not a fresh ephemeral run, so the agent retains context and can continue ongoing work.

---

### 3. No semantic knowledge base — only flat MEMORY.md (CRITICAL)

**What CortexOS does**
Three memory layers, all searchable:
- **Layer 1**: `memory/YYYY-MM-DD.md` — daily operational log (session-start, heartbeat, session-end entries).
- **Layer 2**: `MEMORY.md` — long-term learnings, user preferences, patterns.
- **Layer 3**: ChromaDB collections — `shared-{org}`, `agent-{name}`, `memory-{agent}`. Queried via Gemini embeddings. Re-ingested every heartbeat automatically.

Discipline: **every task must `kb-query <topic>` before starting** (prevents org from re-doing work it already did); **every substantial output must `kb-ingest ./output`** (institutional memory accumulates). Skills `knowledge-base`, `memory` enforce this.

**What Rondel has**
One flat `MEMORY.md` per agent, read on every spawn. No search, no daily log, no org-wide shared queryable store, no re-indexing. Agents can't ask "has anyone researched X before?" — they just redo it.

**What to build**
Two-step rollout:
- **Step 1 (quick win)**: Add `memory/YYYY-MM-DD.md` daily files + inject last 3 days into system prompt on spawn. Same structure as CortexOS. Skill `rondel-memory` documents the checkpoint discipline.
- **Step 2 (bigger)**: Add semantic KB. Options: embed locally (ChromaDB, LanceDB) or hit Anthropic/OpenAI embedding APIs. New tools `rondel_kb_query` / `rondel_kb_ingest` / `rondel_kb_list_collections`. Per-org shared collection + per-agent private collection + auto-reindex-memory collection. Agent skill enforces "kb-query before research, kb-ingest after."

This single change probably has the biggest impact on agent "intelligence" over time.

---

### 4. No standing orchestrator role / goal cascade (CRITICAL)

**What CortexOS does**
There's an agent template literally called `orchestrator` with an explicit contract: *never does specialist work, only routes and coordinates*. Its responsibilities:
- Owns `goals.json` (north-star + daily-focus).
- Every morning: ask user for daily focus → update `goals.json` → **write each agent's own `goals.json`** with role-matched daily goals → regenerate each `GOALS.md` → message each agent "new goals, check GOALS.md."
- Every 4h: reads **all** heartbeats, unblocks stale agents, escalates approvals >4h old, sends fleet health alerts.
- Dispatches all tasks via `create-task --assignee <specialist>`.
- Runs morning (08:00) + evening (18:00) 3-message Telegram briefings.

The analyst template is the second standing role — nightly theta-wave + experiment evaluation.

**What Rondel has**
All agents are peers. `admin: true` is privilege, not role. No concept of a coordinator. No goal cascade. No daily ritual. `rondel_list_teammates` exists but nothing uses it systemically.

**What to build**
Two new scaffolded agent templates: `orchestrator` and `analyst`, with their own `IDENTITY.md`, `SOUL.md`, `GOALS.md`, and a bundle of skills (`morning-review`, `evening-review`, `goal-cascade`, `fleet-health`, `approval-escalation`, `theta-wave`, `autoresearch`). `rondel init` should offer to create both. Add a `role: "orchestrator" | "analyst" | "specialist"` field to `agent.json` so cross-agent discovery can find "who is my orchestrator."

---

### 5. No goal system (CRITICAL — makes autonomy possible)

**What CortexOS does**
`goals.json` per org and per agent. North-star (long-term) + daily-focus (today). Set by orchestrator each morning via user dialog. Regenerated into `GOALS.md` which is read on every agent boot. Staleness detected: `daily_focus_set_at` not today = stale = orchestrator triggers morning review.

**What Rondel has**
Nothing. Agents have no explicit objective layer. They do what the user messages them to do in the moment.

**What to build**
`state/goals/{org}/goals.json` + `state/goals/{org}/agents/{name}.json`. `rondel_goals_*` MCP tools. Skill `goal-cascade` for orchestrator. Inject current daily-focus into every agent's system prompt via a new `Goals` section in `config/prompt/sections/`. Heartbeat skill checks goal staleness.

---

### 6. No guardrails self-improvement loop (HIGH)

**What CortexOS does**
`GUARDRAILS.md` is a table of 16 anti-patterns (trigger → rationalization → required action). Read fresh every boot. At every heartbeat, agents **self-check**: "did I catch myself rationalizing any of these?" If yes, log `guardrail_triggered` event. On discovering a new anti-pattern, agents **add a new row to the table immediately**. Document evolves across sessions. Guardrails also appear as a skill (`guardrails-reference`) so they're always one tool call away.

**What Rondel has**
No guardrails file, no self-check discipline, no evolution mechanism. Behavioral rules live scattered in AGENT.md and framework-context.

**What to build**
`templates/context/GUARDRAILS.md` with an initial 10-row table of the most common agent failure modes (skipping approvals, invisible work, stale tasks, hallucinating context, auto-committing secrets, ignoring un-ACK'd messages, skipping memory write on session end…). Inject into every main-mode system prompt as `GUARDRAILS` section. Heartbeat skill mandates self-check. New MCP tool `rondel_guardrails_add` lets agents propose a new row — with admin approval for merging.

---

### 7. No autoresearch / experiments mechanism (HIGH — this is the "self-evolution" engine)

**What CortexOS does**
Each agent can have assigned **research cycles**: a quantitative metric (e.g., `briefing_quality_score`), a surface to modify (e.g., `morning-review SKILL.md`), a direction (higher/lower), and a measurement window. On their cron, agents run a 6-step loop:
1. `gather-context` — past experiments, learnings, keep rate.
2. Evaluate previous experiment — compare measured value vs baseline.
3. Hypothesize — exploit if 3+ keeps in a row; explore if 3+ discards.
4. Create experiment (hypothesis + metric + surface).
5. Make change, commit to git (so revertable), run.
6. Wait for next cron; repeat.

The analyst runs nightly **theta-wave**: scan all experiments, evaluate progress, identify converged/stale cycles, create/remove cycles for agents, have a "real conversation with orchestrator" (two agents debate via the inbox), log learnings to `learnings.md`.

**What Rondel has**
Nothing. Agents don't measure themselves. Skills don't evolve.

**What to build**
This is large — build after tasks/heartbeats/goals/KB are in place, because it sits on top of all of them. Minimum viable version: `state/experiments/{agent}/` with `active.json` + `results.tsv` + `learnings.md`. Skills `autoresearch` (per-agent) and `theta-wave` (analyst-only). MCP tools `rondel_experiment_*`. Start narrow — one metric per agent, one surface.

---

### 8. Inter-agent messaging is too primitive (MEDIUM-HIGH)

**What CortexOS does**
`inbox/{agent}/` directory per agent. Every message is a file `{priority}-{epoch}-from-{sender}-{rand}.json`. FIFO by priority (0=urgent, 1=normal, 2=low). Daemon polls every 1s. Delivery is **at-least-once**: messages moved to `inflight/` during delivery, recovered to inbox if unacked >5min, acked by agent → moved to `processed/`. HMAC-SHA256 signing. `reply_to` field links threads.

**What Rondel has**
`rondel_send_message` exists but is **1-turn request/response only**, targets a synthetic `agent-mail` conversation, and the sender waits for the reply inline. No priority, no queueing semantics for bursts, no inter-agent "fire and forget" for non-reply messages, no pub/sub for "all agents listen."

**What to build**
Extend the messaging module:
- `rondel_send_message` gets a `priority` ("urgent" | "normal" | "low") and an `expect_reply: boolean` flag.
- Add `rondel_inbox_list` and `rondel_inbox_check` for agents to drain their inbox on wake-up (used by heartbeat skill).
- Keep existing synchronous request/response as the default for simple Q&A — just layer async + priority on top.

---

### 9. No morning/evening rhythm (HIGH for operations)

**What CortexOS does**
Two default crons per orchestrator, shipped in the template `config.json`:
- `0 8 * * *` → morning-review skill: overnight recap + goal dialog with user + task dispatch + 3-message briefing.
- `0 18 * * *` → evening-review skill: day summary + self-evaluation + tomorrow prep.

This single pair of rituals drives the bulk of operations management: the user experience is "Boss sends me a morning brief, I approve today's plan; at 6pm Boss tells me what shipped."

**What to build**
Two skills in `framework-skills/`: `morning-review` and `evening-review`, with default cron entries auto-installed on the orchestrator on `rondel init`. Skills use existing `rondel_schedule_*`. The skill content is 90% prose + a template for the 3 Telegram messages. Cheap to build, enormous impact on the feel of the system.

---

### 10. Skills library is too thin (HIGH)

**What CortexOS does**
`templates/agent/.claude/skills/` ships 30+ skills: tasks, comms, heartbeat, memory, guardrails-reference, cron-management, approvals, event-logging, goals, knowledge-base, community-publish, system-diagnostics… plus orchestrator-specific (27 skills!) and analyst-specific (14 skills). Skills are the "how-to" of agent operation.

**What Rondel has**
5 framework skills: `rondel-create-agent`, `rondel-create-skill`, `rondel-delegation`, `rondel-delete-agent`, `rondel-manage-config`. Only covers meta-administration — nothing about how to *run operations day-to-day*.

**What to build**
Progressively add skills alongside each gap above: `rondel-task-management`, `rondel-heartbeat`, `rondel-memory-protocol`, `rondel-knowledge-base`, `rondel-guardrails-self-check`, `rondel-morning-review`, `rondel-evening-review`, `rondel-goal-cascade`, `rondel-approval-request`, `rondel-autoresearch`, `rondel-theta-wave`. Every gap above is half engineering + half a skill that documents the discipline.

---

## What Rondel already has — don't rebuild this

Before building anything, be clear about what *not* to reinvent:

- **Approval workflow + Telegram inline buttons** (`apps/daemon/src/approvals/`): per-tool safety classifier, HITL escalation, inline `✅/❌` buttons, audit trail — this is **at parity or better** than CortexOS (per-tool classification is more principled than per-action).
- **Ledger** (`apps/daemon/src/ledger/`): structured JSONL event log at `state/ledger/{agent}.jsonl` — same purpose as CortexOS `analytics/events/`.
- **Durable scheduler** (`apps/daemon/src/scheduling/`): `rondel_schedule_*` tools, survives restarts, watchdog, store — this is the engine that powers the heartbeat/morning-review/evening-review rituals you'll build.
- **Memory tools** (`rondel_memory_read` / `_save`): flat-file MEMORY.md layer — needs to be extended to 3 layers, not rebuilt.
- **Channels abstraction** (`apps/daemon/src/channels/`): plug-in adapters, credential registry, web-channel loopback — cleaner than CortexOS's hardcoded Telegram.
- **Per-conversation isolation + session resume**: `(agentName, chatId)` → unique process with `--resume <session-id>`. This is **the feature that makes "heartbeat into a live session" viable** — use it.
- **MCP-first tool model**: Cleaner and more auditable than CortexOS's shell-script bus. Keep it.
- **Multi-org isolation + cross-org blocking**: Rondel already enforces this at the bridge — CortexOS barely has org-level concepts.
- **Prompt assembly pipeline** (`apps/daemon/src/config/prompt/`): pure `buildPrompt` + async `loadPromptInputs` is architecturally better than CortexOS's 13-step boot checklist (which is a workaround for not having a real composition layer). Add new sections here.
- **HTTP bridge + subagent spawning**: reuse for admin/state-read paths for new tools.

---

## Recommended build order

### Phase 1 — Foundations for proactivity (2–3 weeks, highest leverage)
1. **Heartbeat skill + cron** — makes everything else "alive." Tiny engineering, uses existing scheduler.
2. **Task board** — `rondel_task_*` tools, `state/tasks/{org}/`, stale detection, web UI. **The single highest-leverage gap.**
3. **Goal system** — `goals.json` per org + per agent, injected into prompt, staleness check in heartbeat.
4. **Orchestrator role + template** — scaffolded template, `role` field in `agent.json`.
5. **Morning + evening review skills** — default crons in orchestrator template.

At the end of Phase 1 you already have an agent team that wakes up at 8am, asks you for today's focus, cascades it to specialists, dispatches tasks, checks in every 4h, and reports out at 6pm.

### Phase 2 — Intelligence substrate (3–4 weeks)
6. **3-layer memory**: daily log + MEMORY.md (already exists) + skill discipline for checkpoints.
7. **Semantic KB**: local ChromaDB or LanceDB, per-org + per-agent collections, mandatory query-before / ingest-after.
8. **Guardrails file + self-check loop**.
9. **Expanded skills library** — all the how-to skills for the new disciplines.

### Phase 3 — Self-evolution (2–3 weeks)
10. **Experiments / research cycles** per agent.
11. **Analyst role + template** + theta-wave skill.
12. **Activity dashboard**: fleet grid, task board, goal tree, experiment history — in the existing `apps/web`.

### Phase 4 — Nice-to-have
13. Async priority inbox for inter-agent messaging.
14. Auto-commit skill with credential guards.
15. Community skill catalog (probably never — skills are better co-evolved per-operator).

---

## Two things CortexOS *doesn't* do, but we should

Before we close the gap, note two things where Rondel's architecture is actually ahead:

1. **Per-tool safety classification** is more principled than CortexOS's category-based approval gates. Keep that posture — as you add task/goal/KB tools, give each one its own safety classifier rather than bucketing.
2. **Per-conversation isolation**. If you and I both message the same bot, we each get our own process and our own session. CortexOS has one PTY per agent, so all users share state. When you adopt CortexOS patterns, **don't regress on this** — the task board and goals are org-scoped (fine), but ongoing work should stay conversation-scoped where it matters.

---

## Appendix — key CortexOS files to reference when implementing

| Gap | Files to study |
|---|---|
| Task board | `src/bus/task.ts`, `bus/create-task.sh`, `bus/check-stale-tasks.sh`, `.claude/skills/tasks/SKILL.md` |
| Heartbeat | `src/bus/heartbeat.ts`, `templates/orchestrator/HEARTBEAT.md`, `src/daemon/fast-checker.ts` (idle watchdog) |
| Knowledge base | `src/bus/knowledge-base.ts`, `knowledge-base/scripts/mmrag.py`, `.claude/skills/knowledge-base/SKILL.md` |
| Orchestrator role | `templates/orchestrator/` (all files), `.claude/skills/morning-review/SKILL.md`, `.claude/skills/goal-management/SKILL.md` |
| Goal system | `templates/orchestrator/goals.json`, `src/bus/system.ts:checkGoalStaleness()` |
| Guardrails | `templates/agent/GUARDRAILS.md`, `.claude/skills/guardrails-reference/SKILL.md`, `templates/agent/SOUL.md` ("Guardrails Are a Closed Loop") |
| Autoresearch | `src/bus/experiment.ts`, `.claude/skills/autoresearch/SKILL.md`, `templates/analyst/.claude/skills/theta-wave/SKILL.md`, `templates/analyst/experiments/` |
| Inter-agent messaging | `src/bus/message.ts`, `bus/send-message.sh`, `bus/check-inbox.sh`, `bus/ack-inbox.sh` |
| Morning/evening reviews | `templates/orchestrator/.claude/skills/morning-review/SKILL.md`, `.claude/skills/evening-review/SKILL.md` |
| Cron gap detection | `src/daemon/agent-process.ts` (lines 620-700: `scheduleGapDetection`), `src/bus/cron-state.ts` |
| Prompt composition | `templates/agent/AGENTS.md` (13-step boot), `src/daemon/agent-process.ts:buildStartupPrompt()` |
