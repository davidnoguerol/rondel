# Phase 2 Kickoff — Guardrails + Self-Improvement Loop

## Your job in this chat

Design the **guardrails file + self-check loop** for Rondel, to spec-level quality, following our modularity contract. **Do not implement it.** Produce a design document I can review, iterate on, and then hand to a future implementation chat.

---

## Context

### Rondel, in one paragraph
Rondel is a multi-agent orchestration framework built on the Claude CLI. It bridges messaging channels to Claude processes with per-conversation isolation, durable scheduling, memory, approvals, and inter-agent messaging — all via first-class MCP tools. The long-term vision is an **agentic self-evolving harness** that manages real operations.

### What Phase 2 is
Phase 2 adds the intelligence substrate: daily memory, semantic KB, and **guardrails**. Guardrails are the first primitive that makes an agent *self-correcting* — agents detect their own drift and extend the rulebook when they find a new failure mode. See [`docs/GAP-ANALYSIS-CORTEXTOS.md`](../GAP-ANALYSIS-CORTEXTOS.md) section 6.

### This item — Guardrails + self-improvement loop
A `GUARDRAILS.md` file per agent (or per org, or framework-shipped — part of the design decision) containing a table of anti-patterns: *trigger → rationalization → required action*. Example: "Heartbeat cycle fires" → "I just updated recently, I'll skip" → "Always update heartbeat on schedule. No exceptions." On every heartbeat turn, agents **self-check** against the table: "Did I catch myself rationalizing any of these?" If yes, log a `guardrail_triggered` event. When agents discover a new anti-pattern, they **add a new row** to the table. The document evolves across sessions, preventing systematic failures from recurring.

### Dependencies
Phase 1 item 1 (heartbeat) — self-check fires inside the heartbeat skill. Phase 2 item 1 (daily memory) — guardrail-triggered events get noted in daily memory.

### Files to read if you need depth
- `CLAUDE.md` — coding standards, user-space vs framework-space
- `docs/GAP-ANALYSIS-CORTEXTOS.md` — section 6
- `docs/phase-1/01-heartbeat-kickoff.md` — where self-check fires

---

## Step 1 — Parallel research (dispatch two subagents)

### Subagent A — OpenClaw
**Path**: `/Users/david/Code/openclaw`
**Focus**: does OpenClaw have any invariants / guardrails / anti-pattern documentation? Runtime behavioral rules the agent is expected to follow? Any self-check / self-reflection loops? Any mechanism for agents to evolve their own behavioral rules? Look for `GUARDRAILS`, `INVARIANTS`, `RULES`, `ANTI_PATTERNS` files and any references to self-correction.

### Subagent B — CortexOS
**Path**: `/Users/david/Code/cortextos`
**Focus**: map the guardrails system. Key files: `templates/agent/GUARDRAILS.md` (the 16-row table — table structure, row format, categories), `templates/agent/SOUL.md` "Guardrails Are a Closed Loop" section, `templates/agent/.claude/skills/guardrails-reference/SKILL.md`, `templates/agent/AGENTS.md` step 2 (read on boot), heartbeat-cycle self-check step, `log-event.sh` usage for `guardrail_triggered` events. Cover: exact row schema, how new rows are added (agent writes directly? proposes + admin approves?), how self-check integrates with heartbeat, whether guardrails are per-agent or global.

### Shared output schema

```
## 1. Concept presence
Yes / Partial / No — 1-sentence summary

## 2. Rulebook structure
- File location (per-agent, per-org, framework)
- Row schema (trigger, rationalization, required-action, any other fields)
- Grouping / categorization

## 3. Injection / visibility
- How agents see the rules (prompt injection, skill lookup, tool query)
- Frequency (every turn, spawn, on-demand)
- Size management (how does the rulebook stay digestible)

## 4. Self-check trigger
- When agents run the self-check (heartbeat, pre-action, post-action)
- How the discipline is encoded (skill prose, system-prompt directive)

## 5. Violation handling
- Event logging format
- Escalation (orchestrator notified? user?)
- Does the agent back out of the rationalization?

## 6. Rulebook evolution
- Who can add rows (agent, orchestrator, admin)
- Approval flow (immediate, admin-approved, user-approved)
- Deduplication (prevent similar rules accumulating)
- Deprecation (retiring stale rules)

## 7. Discipline / contract
- Exact prose guiding agents
- Where encoded

## 8. Lifecycle
- Creation (initial rulebook, onboarding)
- Evolution (add/edit rows)
- Retirement / compaction
- Versioning

## 9. Integration points
- Heartbeat (self-check trigger)
- Memory (guardrail events noted)
- Ledger (event logging)
- Approvals (escalation path)

## 10. Strengths worth adopting for Rondel
## 11. Anti-patterns / not to copy
## 12. Key file paths (absolute)
```

---

## Step 2 — Rondel codebase research

1. **Prompt sections** — `apps/daemon/src/config/prompt/sections/` — new `guardrails.ts` section builder lands here.
2. **Bootstrap files** — `apps/daemon/templates/context/` for the per-agent scaffold; where `GUARDRAILS.md` template lives.
3. **User-space vs framework-space** — CLAUDE.md section. `GUARDRAILS.md` is interesting: the **initial table** is framework-authored (we know the failure modes) but **additions** are agent-authored. Users can also edit. This is a collaborative file. Decide the authority model.
4. **Ledger** — `apps/daemon/src/ledger/ledger-types.ts`. New event `guardrail:triggered` (and maybe `guardrail:added`) lands here.
5. **MCP tool surface** — do we need `rondel_guardrails_add`? Or agents write directly to the file? Pick one with rationale.
6. **Heartbeat skill** — the Phase 1 skill; self-check is a step inside it.
7. **Existing framework-context** — `apps/daemon/templates/framework-context/TOOLS.md` is framework-space; is there an equivalent for behavioral rules? Look for a pattern; if none, consider whether guardrails belong in framework-context (static baseline), user-space (evolvable), or both.

---

## Step 3 — Synthesize the design

1. **Scope** — Phase 2: per-agent `GUARDRAILS.md` + self-check discipline + one event kind. Defer: org-level cross-agent rules, automated rule-conflict detection, LLM-proposed compaction.
2. **Split between framework baseline and agent-evolvable** — propose: ship a baseline of ~10 universal rules in framework-context (read-only, version-pinned); per-agent `GUARDRAILS.md` is user-space and grows at runtime. Total injected = baseline + agent-specific. Trade-offs.
3. **Row schema** — fields, optional vs required, any categorization.
4. **Initial rulebook** — propose ~10 rules Rondel should ship (adapted from CortexOS's 16 plus any Rondel-specific ones: don't skip approvals, don't silently swallow errors, don't mutate user-space files without explicit action, don't invoke disallowed native tools, etc.).
5. **Prompt injection** — which modes get guardrails (main yes; cron maybe-summary; agent-mail yes-short; subagent no); size budget; where in the section order.
6. **MCP tool surface** — `rondel_guardrails_add` (agent proposes a new rule; admin-approved or auto-applied based on design). Schema.
7. **Self-check discipline** — heartbeat-skill step prose. What the self-check actually asks the agent. How violations get reported (`rondel_ledger_append` with payload? direct emit from service?).
8. **Evolution authority** — who can add, edit, remove rows. Approval flow. Decide between agent-direct-write, orchestrator-approved, admin-approved.
9. **Dedup / compaction** — how to prevent the rulebook growing forever. Periodic review by analyst (Phase 3)? Manual by user? Auto-collapse?
10. **Framework skill** — `rondel-guardrails-self-check/SKILL.md` prose.
11. **User-space invariants** — framework never auto-deletes a user's guardrail row; framework never silently rewrites content.
12. **Testing strategy** — unit (prompt section rendering), integration (heartbeat skill self-check, event emission), end-to-end (agent adds a rule, next spawn sees it).
13. **Migration** — existing agents: empty user-space GUARDRAILS.md on next spawn; framework baseline applies immediately.
14. **Open questions** — framework-baseline vs user-space split granularity, evolution authority (too permissive = noise; too strict = friction), cross-agent rule sharing (can one agent's discovered rule propagate to others?).

---

## Deliverable

Save to `docs/phase-2/03-guardrails-design.md`. Editable.

---

## Guardrails for this chat

- **Do not implement.** Design only.
- **Follow Rondel patterns** (CLAUDE.md) — especially the user-space vs framework-space boundary; framework-baseline is read-only, per-agent is evolvable.
- **Do not over-engineer.** No LLM-based compaction, no conflict detection, no rule-ranking for Phase 2.
- **Flag every trade-off** — I'll decide.
- **Minimize this chat's context** — rely on subagents.
