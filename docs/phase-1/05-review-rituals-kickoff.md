# Phase 1 Kickoff — Morning + Evening Review Rituals

## Your job in this chat

Design the **morning + evening review skills** for Rondel, to spec-level quality, following our modularity contract. **Do not implement them.** Produce a design document I can review, iterate on, and then hand to a future implementation chat. You will: (1) load context, (2) run two parallel research subagents to study OpenClaw and CortexOS, (3) study Rondel's patterns, (4) synthesize a clean design proposal.

---

## Context

### Rondel, in one paragraph
Rondel is a multi-agent orchestration framework built on the Claude CLI. It bridges messaging channels (Telegram today, a loopback web channel for the dashboard) to Claude processes with per-conversation isolation, durable scheduling, memory, approvals, and inter-agent messaging — all via first-class MCP tools. Today it is **reactive**: an agent process only exists while a user is talking to it. The long-term vision is an **agentic self-evolving harness** that manages real operations — a team of agents that wake up on their own, share a task board, cascade goals from a coordinator down to specialists, run nightly experiments to improve themselves, and give the user a daily rhythm of morning briefings and evening recaps.

### What Phase 1 is
Phase 1 adds the five foundations that turn Rondel proactive: **heartbeat ritual, task board, goal system, orchestrator role, morning/evening reviews**. Each sits atop Rondel's existing scheduler / ledger / bridge / memory foundation. Full plan: [`docs/PHASE-1-PLAN.md`](../PHASE-1-PLAN.md). Gap analysis: [`docs/GAP-ANALYSIS-CORTEXTOS.md`](../GAP-ANALYSIS-CORTEXTOS.md).

### This item — Morning + evening reviews
The rhythm. Two crons — 08:00 and 18:00 — that turn the orchestrator into a daily operator with a user-facing cadence. At 08:00 the orchestrator wakes, reads overnight heartbeats, checks what shipped yesterday, and sends the user a briefing: "Here's last night's work, here's the north-star, what's the focus today?" The user answers, it cascades goals to specialists, creates the initial task backlog, and dispatches. At 18:00 it reads the day's completions, evaluates the morning's plan against reality, and sends the user a recap. Everything is in Markdown skills — no new daemon code. The crons use the existing scheduler; the skills use the existing prompt assembly; the user dialog uses the existing channel flow. Once in place, the Telegram chat with the orchestrator stops being "I wonder what he did today" and becomes a morning brief → approved plan → evening recap. The system gets a daily metabolism. Details: [`docs/PHASE-1-PLAN.md`](../PHASE-1-PLAN.md) section 5.

**Important dependency**: this item sits on top of items 1–4 (heartbeat, task board, goals, orchestrator role). Design assumes those exist with their proposed MCP tool surfaces. If you need to refer to a not-yet-built tool (e.g., `rondel_task_create` from item 2), do so and note the dependency.

### Files to read if you need depth
- `CLAUDE.md` — coding standards, modularity contract
- `ARCHITECTURE.md` — what exists in code today
- `docs/PHASE-1-PLAN.md` — section 5 (Morning + evening reviews); also sections 1–4 for the tools this feature uses
- `docs/GAP-ANALYSIS-CORTEXTOS.md` — the "why"

---

## Step 1 — Parallel research (dispatch two subagents)

Dispatch two `Explore` subagents **in a single message so they run in parallel**. Each subagent produces a structured report using the shared schema below. Ask them for **concise findings — facts, skill prose snippets, file paths; no code dumps**. Do not read the external codebases yourself; rely on subagents.

### Subagent A — OpenClaw
**Path**: `/Users/david/Code/openclaw`
**Focus**: does OpenClaw have any concept of scheduled rituals, daily check-ins, recurring agent workflows, or structured user-facing cadence? If not, how does it handle cron-driven prompts that need to (a) have full session context, (b) initiate a user conversation, (c) wait for a user reply before continuing? Look for multi-step orchestration patterns, any templated "this is how we do X every N hours" workflows, and how OpenClaw composes cron-mode prompts.

### Subagent B — CortexOS
**Path**: `/Users/david/Code/cortextos`
**Focus**: map the morning/evening review implementation in detail. Key files: `templates/orchestrator/.claude/skills/morning-review/SKILL.md` (full prose — this is the canonical content), `templates/orchestrator/.claude/skills/evening-review/SKILL.md`, the cron entries in `templates/orchestrator/config.json`, the 3-message Telegram briefing format, goal-cascade flow, task-dispatch flow, how the skill waits for user response, how the skill handles mid-ritual user interruption, how the skill logs completion events. Also cover: how the orchestrator identifies who is "the user" to message (the `CHAT_ID` from `.env`), and how multi-user orgs handle the morning dialog.

### Shared output schema (both subagents must use this)

```
## 1. Concept presence
Yes / Partial / No — 1-sentence summary

## 2. Ritual structure
- Morning flow: steps 0 → N
- Evening flow: steps 0 → N
- Message format (1 big message vs N small messages)
- User-dialog phases (does the skill wait for user reply? how?)

## 3. Trigger model
- Cron expression / interval
- How cron → prompt injection works
- How the cron's prompt names the skill (invocation convention)

## 4. Prompt context
- What the cron-mode prompt contains (preamble, skill pointer, current state summary)
- How the skill reads state (heartbeats, tasks, goals, memory)
- What it writes (tasks, goals, cascade messages, ledger events)

## 5. User interaction
- How the skill sends a message to the user (synchronous? buffered?)
- How it waits for reply (yields turn, returns later; or blocks)
- What happens if user doesn't reply (timeout, escalation)

## 6. Fleet interaction
- How the skill cascades goals to specialists
- How it dispatches tasks
- Messaging pattern (broadcast vs unicast)

## 7. Idempotency + overlap
- What if cron fires twice?
- What if user is mid-conversation when cron fires?
- Reconciliation / deferral mechanism

## 8. Output artifacts
- Ledger events emitted
- Memory updates
- Files written (daily memory, task records)

## 9. Skill content (verbatim or paraphrased)
- The actual prose structure of morning-review SKILL.md (list of steps)
- Same for evening-review

## 10. Strengths worth adopting for Rondel
## 11. Anti-patterns / not to copy
## 12. Key file paths (absolute)
```

---

## Step 2 — Rondel codebase research

Once both subagent reports are in, study Rondel itself to find the clean integration point. Look at:

1. **Cron preamble** — `apps/daemon/src/config/prompt/cron-preamble.ts`. This is the prompt prefix a cron turn gets. Understand what's already there and whether morning-review needs anything added.
2. **Skill loading** — `apps/daemon/templates/framework-skills/.claude/skills/` — shape of existing skills (`rondel-delegation`, `rondel-create-agent`). How skill discovery works at spawn time via `--add-dir`.
3. **Existing framework skills** — read their `SKILL.md` prose to understand Rondel's skill-writing style, frontmatter conventions, tone.
4. **Scheduler** — `apps/daemon/src/scheduling/` — how durable crons are created, stored, fired. Morning + evening reviews are two cron entries. Understand `parseSchedule`, timezone handling, retry semantics.
5. **Cron runner** — `apps/daemon/src/scheduling/cron-runner.ts` (if that's its name) — how a cron turns into a prompt injection into a specific agent's session.
6. **Session resume** — `apps/daemon/src/agents/conversation-manager.ts` — how `--resume` works; whether a cron can fire into an active main-mode session without disrupting a live user conversation.
7. **Channel messaging** — `apps/daemon/src/channels/telegram/adapter.ts` — how the orchestrator sends a message to the user (multi-message sends, typing indicator). Rate limits, message length (Telegram 4096 char cap).
8. **Agent-mail vs main mode** — `apps/daemon/src/config/prompt/` mode definitions. Morning review fires in main mode (talking to the user), goal cascade fires as agent-mail (to specialists). Understand mode transitions.
9. **Ledger events** — `apps/daemon/src/ledger/ledger-types.ts` — where to add `review:morning_completed` and `review:evening_completed`.
10. **User identification** — how the orchestrator knows which chat to send the morning brief to. `rondel_recall_user_conversation` exists; study what it does.
11. **Template defaults** — `apps/daemon/templates/context/orchestrator/agent.json` (being designed in item 4) — morning/evening/heartbeat crons are installed here by default.
12. **Running into a live user conversation** — what happens if the cron fires while the user is mid-conversation with the orchestrator? This is the critical collision case. Study how existing cron-triggered turns behave.

---

## Step 3 — Synthesize the design

Produce a design document that answers:

1. **Scope** — Phase 1 morning + evening only. Defer weekly review, monthly board summary, Friday retro, ad-hoc check-ins.
2. **Skill file layout** — full paths, frontmatter, structure for `rondel-morning-review/SKILL.md` and `rondel-evening-review/SKILL.md`.
3. **Skill prose content** — concrete steps for each ritual. Base on CortexOS's proven flow (per subagent report) but adapted to Rondel's tool surface (use `rondel_heartbeat_read_all`, `rondel_task_list`, `rondel_goals_set_daily_focus`, `rondel_ledger_query`, `rondel_send_message`, etc.). Write the actual skill Markdown that will ship.
4. **Default cron entries** — exact cron expressions (`0 8 * * *`, `0 18 * * *`), timezone handling (UTC vs user-local), how they land in the orchestrator template's `agent.json`.
5. **Cron → skill invocation** — how the cron's prompt text tells the agent "run the rondel-morning-review skill." Convention for skill invocation in cron prompts.
6. **Cron mode vs main mode** — morning-review wants main-mode semantics (so it can talk to the user synchronously). Does it fire as cron mode with a bridge back to main? Or does the cron preamble allow sending user-facing messages directly? Decide and justify.
7. **User dialog model** — when the skill asks "what's the focus today?" and waits — what actually happens? Options: (a) the skill sends the question, emits a ledger event, and *ends the turn*; user's reply arrives as a normal message which re-enters the ritual at step N+1 (state persisted in ledger or memory); (b) the skill blocks the turn until reply arrives (Claude CLI keeps the session open and waits). Pick one with rationale.
8. **Mid-ritual state** — if option (a) above, how does the ritual resume? Does the user's next message trigger a "continue morning-review" prompt? Is there a state machine?
9. **Collision handling** — what if the cron fires while the user is in a live conversation with the orchestrator? Options: defer, interrupt, enqueue, abort. Pick one with rationale.
10. **Timezone + schedule configuration** — where is the user's timezone stored? How does the admin change morning time from 08:00 to 09:00? Per-org or per-agent config?
11. **User identification** — how the morning-review skill knows which Telegram chat to message. Via `rondel_recall_user_conversation`? Via a stored "primary user chat" in agent.json or org config? Decide.
12. **Cascade + dispatch composition** — the morning ritual calls `rondel_goals_set_agent_goals` N times (one per specialist) and `rondel_task_create` M times. Atomicity: all-or-nothing? Per-specialist retry? Ledger traceability.
13. **3-message vs 1-message briefing** — pick the Telegram message structure. Short messages with clear separation or one rich message? Consider Telegram rate limits.
14. **Evening review specifics** — self-evaluation format (what metrics), tomorrow-prep format (pre-created tasks blocked on overnight work).
15. **Ledger events emitted** — `review:morning_started`, `review:morning_awaiting_user`, `review:morning_completed`, `review:evening_started`, `review:evening_completed`. Payload shapes.
16. **First-run behavior** — what happens on day 1 when there's no prior day's work to summarize? Does the onboarding-initial-north-star flow live here?
17. **Testing strategy** — unit (skill prose review by reading), integration (cron fires at simulated time, message sent to test channel), end-to-end (full 08:00 ritual in a staging org).
18. **Migration** — skills land in `framework-skills/`, cron entries scaffolded into new orchestrator creates, existing orchestrators get prompted to install via `rondel doctor` or an upgrade path.
19. **Open questions** — cron-vs-live-conversation collision resolution, skill state-persistence across turns, user-reply timeout behavior, multi-user orgs with multiple "primary users."

---

## Deliverable

Save to `docs/phase-1/05-review-rituals-design.md`. Structure matching the synthesis sections. Include the full skill Markdown prose (both morning and evening) as embedded sections in the doc — this is where we'll iterate on the discipline itself. Editable, for iteration.

---

## Guardrails for this chat

- **Do not implement.** Design only. (This item is mostly Markdown anyway; implementation = writing the skills + adding cron entries.)
- **Follow Rondel patterns** (CLAUDE.md): skills are how-to documents, not code; the discipline lives in the prose. No new daemon code for this feature unless absolutely unavoidable.
- **Do not over-engineer.** No weekly / monthly / quarterly rituals yet. No automated retrospectives. No multi-user dialog branching.
- **Flag every trade-off** — especially the user-dialog model (blocking vs turn-yielding) and the cron-collision model. These are the hardest parts.
- **Assume items 1–4 will be built.** Refer to their tools freely (`rondel_heartbeat_read_all`, `rondel_task_create`, `rondel_goals_*`, etc.), even though they don't exist yet. Flag any assumption about their surface that might not hold.
- **Minimize this chat's context** — rely on subagents for external research; no reading OpenClaw or CortexOS source yourself.
