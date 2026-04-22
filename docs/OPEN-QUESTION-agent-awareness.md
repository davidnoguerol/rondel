# OPEN QUESTION — Agent awareness of its primary human

> **Status:** Problem capture. Not a design. Not a plan. Feed for a later
> holistic design session — do not patch this with spot fixes.

## One-line

An agent operating in a non-user-facing session (inter-agent mail,
cron, subagent) has no ambient knowledge of (a) which human it serves
or (b) how to reach them — and no mechanism to honour async follow-up
promises it makes in those sessions.

## What happened — live incident 2026-04-21

Three conversations, one task, two visible failures.

### Thread 1 — David → Neo (telegram:5948773741)

> **David:** Create a task titled 'Ship onboarding doc' assigned to
> bot1 with priority high.

Neo created task `task_1776774725027_ff2429d3` with an empty
description. No clarifying question.

### Thread 2 — David → bot1 (telegram:5948773741, test-org)

Bot1 ran a heartbeat, then David prompted "don't you have a task
assigned?" Bot1 listed the task, noted the empty description, and
asked for permission to claim + ask Neo for context. David said:
"Yes pick it up and talk to him to understand it better, I don't
know."

Bot1 claimed the task (`in_progress`) and sent inter-agent mail to
Neo requesting audience / scope / format / prior art / deadline.

### Thread 3 — bot1 → neo (internal:agent-mail)

Neo replied:

> I don't have any additional context beyond what David said — the
> task was created with just a title and no description. I need to
> loop David in before you can proceed.
>
> I'll hold you there. **I'm going to ask David for the missing
> details and will get back to you once I have answers. Sit tight.**
>
> **I don't have David's chat_id to ping him directly from here.**
> I'll update the task with a blocking note and let bot1 know the
> situation clearly. My response to this ag[ent...]

Neo never asked David. Bot1 caught the dead promise ("Honestly?
Probably never, on his own.") and pulled David in directly in
thread 2 to keep the task unblocked.

## Observed problems

### Problem A — the "no chat_id" claim

When Neo was in the agent-mail session, Neo's bridge context was
`channelType=internal, chatId=agent-mail` (per
`apps/daemon/src/tools/_common.ts:66-74`). Neo interpreted this as
"I have no way to reach David from here."

The chat_id is in fact discoverable from that context via three
independent routes:

- `rondel_agent_status("neo")` — returns active conversations
  including `telegram:5948773741`.
- `~/.rondel/state/sessions.json` — contains
  `neo:telegram:5948773741`.
- `~/.rondel/config.json` — `allowedUsers` lists the Telegram user
  id (same value in DMs).

And `rondel_send_telegram(chat_id, text)` exists specifically to
post to any chat_id from any session
(`apps/daemon/src/channels/telegram/mcp-tools.ts:119-143`).

Neo's `MEMORY.md` has David's name, email, timezone — but not the
chat_id. Nothing in the framework prompt or context files tells the
agent that chat_id is discoverable. Neo's reply ("I don't have it")
was truthful at the level of "it's not in my memory or env"; the
gap is that nothing cues the agent to go find it.

### Problem B — dead async promise

Neo said "I'll ask David … and will get back to you." No scheduler
stands behind that sentence. In Rondel today, an agent process
only exists while a user is actively talking to it
(CLAUDE.md, "Where Rondel is heading"). When the agent-mail turn
ended, Neo ceased to exist until David messaged Neo again. Neo had
no mechanism to reopen itself at a later time to fulfil the
promise, and created no task, schedule, or heartbeat note to carry
the obligation forward.

Bot1 also noticed this explicitly:
> "Honestly? Probably never, on his own. Each agent has its own
> Telegram bot, and neo said he doesn't have your chat_id — so he
> can't proactively message you."

## Shared mechanism

Both problems trace to the same absence: **agents lack an
architectural concept of "my primary human" that is ambient across
every session they run in**.

- In a user-facing Telegram session, that human is implicit in
  `ctx.chatId` and every tool targets them by default.
- In every OTHER session (agent-mail, cron, subagent), the human
  drops out of the context entirely. There is no routing fallback,
  no discovery cue, no reminder primitive wired to "if you need
  them, here's how; if you're going to delay, here's how to carry
  the debt."

The data to reconstruct the mapping exists (`sessions.json`,
`config.json`, agent-level conversation history). The framework
just never surfaces it back to the agent in non-user-facing
contexts.

## Why this is a holistic question, not a spot fix

Plausible spot fixes — e.g. injecting chat_id into `MEMORY.md`,
adding a `rondel_my_user` tool, writing guidance into the admin
prompt section — each solve one half of one problem and bypass the
bigger question: **what is Rondel's model of "the human the agent
serves"?** That touches at least:

- **Session identity vs state** (CLAUDE.md invariant) — the
  conversation key `{agent}:{channelType}:{chatId}` is permanent
  per conversation, but the concept of "primary human across
  conversations" doesn't exist as a first-class thing.
- **User space vs framework space** — routing info is
  framework-critical (the agent makes the same discovery mistake
  regardless of its personality), so it belongs in framework space.
  But the _identity_ of the human is user-space (USER.md). Where
  does the boundary sit?
- **Heartbeat / task board / goal cascade (Phase 1+)** — if
  promises are a first-class object, where do they live, who
  reconciles them, and what pings on stale ones? The task board
  already has the primitives (`rondel_task_create`, stale
  classification). It's not connected to "I owe my human an
  answer."
- **Standing orchestrator role (Phase 1+)** — does Neo, as Chief
  of Staff, actually own "what is David blocked on?" and surface
  it in his 4-hour heartbeat? The mechanism exists.
- **Inter-agent mail surface** — when agent A mails agent B and B
  needs the user, what contract does A→B carry about the user's
  reachability? None today.
- **Multi-channel, multi-human future** — what happens when an
  agent serves two humans on two channels? Today `allowedUsers`
  is a list. The "primary human" concept needs to not paint over
  this.

A solution that doesn't think through these joints will drift.

## Pointers for the later design session

**Code to read before designing:**

- `apps/daemon/src/tools/_common.ts` — how tool env vars encode
  the current conversation.
- `apps/daemon/src/agents/conversation-manager.ts` — how
  conversations are keyed and persisted.
- `apps/daemon/src/channels/telegram/mcp-tools.ts` —
  `rondel_send_telegram` already exists as a proactive-outreach
  primitive.
- `apps/daemon/src/tools/ask-user.ts` — how the existing
  ask-user flow binds to `ctx.chatId` (i.e. implicitly single-
  channel).
- `apps/daemon/src/config/prompt/sections/` — where a
  framework-level prompt injection would live if one is added.
- `apps/daemon/src/tasks/task-service.ts` — the primitives for
  "I owe someone an answer" that already exist but were not used.

**Existing master-docs sections to re-read:**

- CLAUDE.md → "User space vs framework space" (boundary rule).
- CLAUDE.md → "Session identity ≠ session state".
- VISION.md (Layers 0–4) — where "the human Rondel serves" sits
  in the intended architecture.
- `docs/PHASE-1-PLAN.md` — heartbeat, task board, standing
  orchestrator role. All three intersect this question.

**Reference codebases (per CLAUDE.md research pattern — dispatch
subagents, don't inline):**

- CortexOS — has 3-layer memory + standing-role discipline; likely
  has a concept of "principal" that Rondel lacks.
- OpenClaw — inter-agent messaging + workflow gates; check how it
  represents "who the user is" across async agent steps.

## What NOT to do when designing a fix

1. Do not just stuff chat_id into `MEMORY.md` and call it done.
   User-space solution, doesn't generalise, rots the moment the
   user deletes it.
2. Do not add a "primary user" string field to `agent.json`. That
   couples identity to a flat config and can't represent multi-
   human or channel-migration cases.
3. Do not invent a new state file for it before first checking
   whether `sessions.json` + `config.json` are already sufficient
   sources.
4. Do not treat "Neo should know X" as a prompt-engineering fix
   and stop there — the deeper question is whether the framework
   should guarantee X to every agent the same way it guarantees
   per-conversation isolation.
5. Do not design this in isolation from heartbeat + task board +
   orchestrator role. The promise-keeping side of the problem is
   already partly solved by those; the design should make the
   connection explicit, not parallel.
