# Tech Docs Q&A — verbatim transcript

> Purpose: re-run the tech-docs build in a fresh context window with the answers already captured.
> Only contains questions I asked and answers the user gave, in their own words. Nothing inferred.

---

## Guiding directives the user stated (their words, not mine)

**From the `/engineer:discover` invocation (argument the user passed):**
> "Note: don't use existing docs because they might be outdated, read through the code in FULL"

**During Q&A, in response to the question about how to treat existing root docs:**
> "don't trust them, don't even read them at first, create the tech docs from the code itself, and ONLY AFTER THAT you read the docs to see if we have any mental models or anything worth adding/amending to the tech docs, but confirm with me first"

**After the user cancelled the build due to stale-doc contamination:**
> "THE DOCS MUST BE MADE BASED ON YOUR FINDINGS IN THE CODE AND YOU SHOULD CHECK WITH ME AND NEVER FUCKIGN EVER ASSUME!!!!"

---

## Phase 2 questions & answers

### Q1 — Output location

**Question:** The `/docs-commands:build-tech-docs` template assumes a multi-project repo with `$project_name/specs/technical/`. Rondel is a single-project repo. My proposal: write to `docs/technical-context/` (same parent as the briefing already at `docs/technical-context/briefing/`). Confirm or redirect.

**Answer:** "approved"

---

### Q2 — Relationship to existing root docs

**Question:** For the new docs, should I: (a) treat existing root docs as canonical input and summarize/link, (b) treat them as unreliable and regenerate from code, (c) mix — trust some (TESTING, CLI-REFERENCE) and regenerate the rest?

**Answer:** "don't trust them, don't even read them at first, create the tech docs from the code itself, and ONLY AFTER THAT you read the docs to see if we have any mental models or anything worth adding/amending to the tech docs, but confirm with me first"

---

### Q3 — Scope boundaries (what's OUT of scope today)

**Question:** What's explicitly OUT of scope today that you don't want the docs to imply is coming? (I listed candidates: multi-user web UI auth, non-Claude-CLI agent backends, hosted/SaaS deployment, Windows service parity.)

**Answer (first round):** "we'll discover this through the interview questions here"

**Answer (after confirmation round, on the specific list I proposed):**
> "multi-user web ui will come in the future but not right now, so we shouldnt make the app rigid, we must account to that; no ci/cd for now is correct, no non-Claude-CLI backends, no hosted SaaS for now (maybe future); no Windows service for now either; no per tab conversation confirmed."

---

### Q4 — File-based state (no DB) rationale

**Question:** Why no SQLite / no LMDB / no embedded KV?

**Answer:** "initially we thought that since we want to maintain this system flexible to changes because we iterate and change it a lot, we thought it's easier to change code/file/json files then to have to maintain a db. It's also easier to see if we decide to have the states etc in git. Maybe later we'd have a db that syncs from files but that's just a maybe, not sure if it's needed"

---

### Q5 — First-class `rondel_*` MCP tools replacing native Bash/Write/Edit/Agent

**Question:** Was this always the plan, or did you hit a specific pain point (e.g., approval gate not working in stream-json headless mode) that forced it?

**Answer:** "the reason we decided to own the tools is because some of the tools readily available by claude have its limitations, example, the read/write file had some 'security blockers' and so on, please read our current docs that might have more context on why we made this decision because there are more reasons"

> **Note for re-run:** the user authorized reading current docs to find the additional reasons for THIS SPECIFIC ADR, but still required confirming with them before writing anything. The user explicitly said "there are more reasons" I don't know yet.

---

### Q6 — One process per `(agentName, channelType, chatId)`

**Question (initial):** Did you evaluate a single long-lived process per agent that multiplexes conversations in-context, and reject it? Why?

**Answer (first round):** "can you explain your question in simple english?"

**Question (simplified):** Today: if user A messages bot X from Telegram and user B messages bot X from Telegram, Rondel spawns two Claude CLI processes — one per conversation. The alternative would be one Claude CLI process per bot that serves both conversations by feeding it a de-multiplexed stream ("here's a message from A, here's a message from B"). My question was whether you considered that single-process approach and rejected it.

**Answer:** "you got it, obviously we decided to have one message context per user conversation, even though they have shared context"

---

### Q7 — Web app with zero daemon imports (Zod-as-boundary)

**Question:** Did you consider a shared `packages/types` workspace, and reject it? Why?

**Answer:** "is your suggestion a better approach than what we currently have implemented? Happy to explore it, if it's better and more suitable for our app, we need a strong rationale, but make sure you understand the app holistically before making any assumptions or recommendations"

> **Note for re-run:** the user did NOT confirm the current approach is correct. They asked me to holistically assess and make a recommendation. In the previous session I stated my recommendation (keep current approach, don't move to packages/types) but the user did not explicitly agree or disagree before the session was cancelled. This is still open.

---

### Q8 — Assistant-ui + custom `rondel-runtime.tsx` adapter

**Question:** What alternatives did you try (Vercel AI SDK UI? plain custom chat component? Copilotkit?) and why did assistant-ui win?

**Answer:** "we should have this documented somewhere, please read on it, something to do with us using Claude CLI and its limitations, please make sure you understand the whys - it's important to note that this framework works on top of Claude Code CLI, it has its pros and cons, maybe this needs to be an adr itself to why we're building on top of Claued Code CLI"

> **Note for re-run:** the user suggested creating a separate ADR specifically for "why we're building on top of Claude Code CLI" — this is a related but distinct ADR from the assistant-ui decision. Both ADRs are open. User authorized reading docs to find the rationale but requires confirmation.

---

### Q9 — Tailwind v4 CSS-first (no `tailwind.config.ts`)

**Question:** Intentional v4 adoption or just "the template came that way"?

**Answer:** "not sure, please check the docs if we mention this (not sure we need an adr or this? or we do?)"

> **Note for re-run:** whether this merits its own ADR is itself open. User authorized checking docs.

---

### Q10 — Dark-default, no `enableSystem`

**Question:** Intentional opinion or placeholder?

**Answer:** "dont need an adr only for this do we? maybe should be in the styling adr?"

> **Note for re-run:** user suggested folding this into the styling ADR (with Tailwind v4) rather than a dedicated ADR. Still open whether we need a styling ADR at all (depends on Q9 answer).

---

### Q11 — Single `web-main` chat per agent (mirrors read-only)

**Question (initial):** Any scenario where you'd make this one-chat-per-browser-tab?

**Answer (first round):** *Not answered in first round.*

**Question (re-asked in confirmation round):** Today every browser tab for the same agent shares one conversation (`web-main`). Leaving this alone unless you flag otherwise.

**Answer:** "it's correct, no need per browser tab new chat, this would create a mess. The agents has channels, web and telegram currently, dont mess it up introducing per tab!"

**Also confirmed in final round:** "no per tab conversation confirmed"

---

### Q12 — Development model

**Question:** Is this single-developer today? Any intent to onboard others?

**Answer:** "single developer"

---

### Q13 — CI/CD

**Question:** Is CI intentionally deferred, or am I missing something? And: how is the daemon released/installed for yourself?

**Answer:** "we dont have CI/CD, we're currently just running on my machine"

> **Note for re-run:** the user did not explicitly answer the "how is the daemon released/installed for yourself" part.

---

### Q14 — Deployment model

**Question (initial):** Should I describe the target as (a) local-only single-operator, (b) per-user self-hosted on any machine they own, or (c) heading toward multi-user/team deployment?

**Answer (first round):** *Not answered in first round.*

**Re-asked in second round, my stated inference:** "inferring from Q13 ('just running on my machine') that the target is local-only single-operator for the Charter. Correct?"

**Answer:** "I want in the future for people to download this repo and run in their own machine, no need to auto-deploy stuff."

---

### Q15 — Testing rigour expected of contributions

**Question:** Is the rule "new code gets tests" or "tests when they aid correctness"? Should CONTRIBUTING say every feature needs an integration test, or only risky ones?

**Answer:** "we're testing rigorously because we're using AI driven development where the developer might not know the exacts ins and outs, it's for safety"

---

### Q16 — Top 3 things you'd improve if you had two free weeks

**Question:** Freeform — this is the meat of ARCHITECTURE_CHALLENGES.md.

**Answer:** "not sure, I think a clear documentation structure, standardized patterns so that it's clear to new developers how this system works and how to expand on it, I'm also missing somewhere we can specify what we're building in terms of the vision so that the development is aligned with that, basically we want to build something similar to OpenClaw, an always-on agent team where agents are proactive, they self-evolve, they act like employees to manage one or many organisations day to day operations, but also the operator must know what's going on, who is doing what etc, observability is super important"

---

### Q17 — `API_SPECIFICATION.md` audience

**Question:** Full endpoint reference for developers who extend Rondel, or just the contracts between daemon and web? My default would be the full endpoint reference grouped by domain (agents/, ledger, approvals, schedules, SSE streams) — push back if you want something tighter.

**Answer:** "agree"

---

## Summary of what's confirmed vs still open going into the re-run

### Confirmed by the user

- Output location: `docs/technical-context/` (Q1)
- Don't trust root docs — code first, read docs only to amend specific things, always confirm (Q2)
- No DB — reasons: iteration flexibility, git-ability, possibly a future file→DB sync (Q4)
- One-process-per-conversation is correct — one message context per user conversation, even though agents have shared context (Q6)
- Single web-main chat per agent — no per-browser-tab conversations (Q11, confirmed twice)
- Single developer (Q12)
- No CI/CD, running on user's machine today (Q13)
- Future deployment: users download and run on own machine, no auto-deploy (Q14)
- Rigorous testing because of AI-driven development (Q15)
- Q16 priorities: doc structure, standardized patterns, vision-alignment surface, OpenClaw-like always-on/proactive/self-evolving/employee-model agents managing orgs, observability critical
- Full endpoint reference is the right scope for API_SPECIFICATION (Q17)

### Confirmed out-of-scope (user's words)

- Multi-user web UI "will come in the future but not right now, so we shouldnt make the app rigid, we must account to that"
- "no ci/cd for now is correct"
- "no non-Claude-CLI backends"
- "no hosted SaaS for now (maybe future)"
- "no Windows service for now either"
- "no per tab conversation confirmed"

### Still open / requires further Q&A or authorized doc-reading + user confirmation

- Q5 (own `rondel_*` tools) — user said "there are more reasons" in the docs, explicitly authorized reading to find them but required confirming before writing.
- Q7 (Zod boundary vs. shared packages/types) — user asked for a holistic assessment + strong rationale. No explicit confirmation of the current approach yet.
- Q8 — user suggested a separate "why Claude Code CLI" ADR AND the assistant-ui ADR. Authorized doc-reading; requires confirmation.
- Q9 (Tailwind v4 CSS-first) — user unsure if it needs an ADR; authorized doc-reading.
- Q10 (dark-default) — user suggested folding into a styling ADR, contingent on Q9.
- Q13 follow-up: how is the daemon released/installed for the user today — not answered.

---

## Ground rules for the re-run (user's directives, literal)

1. Build docs from **code**, not from existing docs.
2. For the specific open items above, the user authorized reading existing docs to recover rationale the code alone can't tell me — but **confirm with the user before writing anything** that draws on those docs.
3. **Never assume.** Ask.
4. Existing root docs (`CLAUDE.md`, `ARCHITECTURE.md`, `DEVLOG.md`, `README.md`, `VISION.md`) are presumed stale.
