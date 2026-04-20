# Phase 3 Kickoff — Analyst Role + Theta-Wave

## Your job in this chat

Design the **analyst role + theta-wave system-level review** for Rondel, to spec-level quality, following our modularity contract. **Do not implement it.** Produce a design document I can review, iterate on, and then hand to a future implementation chat.

---

## Context

### Rondel, in one paragraph
Rondel is a multi-agent orchestration framework built on the Claude CLI. The long-term vision is an **agentic self-evolving harness** that manages real operations. Phase 1 added the orchestrator (the coordinator who never does specialist work). Phase 3 adds the **analyst** (the agent that watches the system and helps it improve).

### What Phase 3 is
Phase 3 adds self-evolution: per-agent experiments (sibling kickoff), **analyst role + theta-wave**, and the web activity dashboard. After Phase 3, the fleet improves measurably over time.

### This item — Analyst role + theta-wave
A second standing role (after orchestrator from Phase 1). The analyst does not do specialist work and does not coordinate (that's the orchestrator's job). It **watches**. Nightly, it runs a **theta-wave** cycle: (1) deep system scan (all heartbeats, tasks, experiments, memory, goals, event logs), (2) evaluate yesterday's theta wave (system-effectiveness score with justification), (3) evaluate every agent's research cycle (converged? stale? successful?), (4) external research on tools/methods relevant to goals, (5) a real conversation with the orchestrator via inter-agent messaging (push, ask why, reference data), (6) based on that conversation, modify agent research cycles or propose structural changes, (7) log findings to `learnings.md`, (8) report to user. Theta wave is itself one big autoresearch cycle (metric: system-effectiveness, direction: higher). Details: [`docs/GAP-ANALYSIS-CORTEXTOS.md`](../GAP-ANALYSIS-CORTEXTOS.md) section 7.

### Dependencies
Phase 1 items 1, 2, 3, 4 (heartbeat, tasks, goals, orchestrator). Phase 2 items 1, 3 (memory, guardrails). Phase 3 item 1 (experiments). The theta wave is the system-level consumer of all of these.

### Files to read if you need depth
- `CLAUDE.md`
- `docs/GAP-ANALYSIS-CORTEXTOS.md` — section 7
- `docs/phase-1/04-orchestrator-role-kickoff.md` — the role pattern the analyst reuses
- `docs/phase-3/01-experiments-kickoff.md` — what theta wave analyzes

---

## Step 1 — Parallel research (dispatch two subagents)

### Subagent A — OpenClaw
**Path**: `/Users/david/Code/openclaw`
**Focus**: does OpenClaw distinguish observer / analyst / monitor agents from working agents? Any system-level review pattern — an agent whose job is to watch the rest? Metrics-gathering patterns? If none, what's the nearest analogue (debug hooks, monitoring scripts, logging consumers)?

### Subagent B — CortexOS
**Path**: `/Users/david/Code/cortextos`
**Focus**: map the analyst + theta-wave. Key files: `templates/analyst/` (the whole directory — IDENTITY, SOUL, GOALS, CLAUDE.md, agent.json), `templates/analyst/.claude/skills/theta-wave/SKILL.md` (8-phase deep cycle), `templates/analyst/.claude/skills/system-diagnostics/SKILL.md`, `templates/analyst/experiments/` (the analyst's own autoresearch cycle on system-effectiveness), cron setup for nightly theta wave, the orchestrator ↔ analyst conversation protocol (how they debate via the inbox). Cover: analyst-only skills (the 14 of them), analyst-only tools (if any), what metrics the analyst collects, how the system-effectiveness score gets computed, how structural proposals flow from analyst to orchestrator (to user).

### Shared output schema

```
## 1. Concept presence
Yes / Partial / No — 1-sentence summary

## 2. Role taxonomy fit
- Is analyst a distinct role?
- Relationship to orchestrator (peer, subordinate, separate reporting line)
- Authority boundaries (can analyst assign work? modify skills directly?)

## 3. Theta-wave structure
- Phases / steps (detailed)
- Trigger (cron, on-demand, user-initiated)
- Duration / cost (context, tokens, wall-time)

## 4. System scan surface
- What the analyst reads (heartbeats, tasks, experiments, memory, goals, events)
- How (tool calls, direct file reads, ledger queries)

## 5. Evaluation policy
- How system-effectiveness is scored (1-10, rubric, qualitative)
- How per-agent cycles are evaluated
- Stale / converged / successful thresholds

## 6. Inter-agent dialog
- Orchestrator ↔ analyst conversation pattern
- Message format, length, frequency
- Debate semantics (push back, ask why, cite data)
- Resolution (who decides)

## 7. Proposal / change flow
- What changes the analyst can make (cycle config, skill edits, structural)
- What requires orchestrator buy-in
- What requires user approval

## 8. Reporting
- User-facing output (message format, time, content)
- Historical record (learnings.md, results, per-wave archive)

## 9. Integration points
- Experiments (reads all, modifies some)
- Goals (informs, rarely modifies)
- Tasks (observes, doesn't dispatch)
- Ledger / memory / KB

## 10. Strengths worth adopting for Rondel
## 11. Anti-patterns / not to copy
## 12. Key file paths (absolute)
```

---

## Step 2 — Rondel codebase research

1. **Role infrastructure** — from Phase 1 item 4 (assumed built). Adding analyst = new value for the `role` field + new template + new skill pack + new tool allowlist.
2. **Inter-agent messaging** — `apps/daemon/src/messaging/` and `rondel_send_message`. Theta-wave uses this for analyst ↔ orchestrator dialog.
3. **Experiment module** — Phase 3 item 1. Analyst is the primary reader and modifier.
4. **Ledger reader** — `apps/daemon/src/ledger/ledger-reader.ts` — analyst queries extensively.
5. **Heartbeat + task services** — analyst queries both; read-only surfaces from Phase 1.
6. **Memory + KB** — analyst reads all agents' learnings (with org isolation).
7. **Agent-mail mode** — `apps/daemon/src/config/prompt/agent-mail.ts`. The orchestrator ↔ analyst debate uses this.
8. **Scheduling** — nightly cron for theta wave (e.g., 02:00 daily).
9. **Streams** — analyst outputs can stream to the web dashboard (Phase 3 item 3).

---

## Step 3 — Synthesize the design

1. **Scope** — Phase 3 analyst: nightly theta wave + per-agent cycle oversight + system-effectiveness scoring + report to user. Defer: multi-analyst orgs, cross-org analysis, real-time intervention (analyst acts only on its cron).
2. **Schema change** — add `"analyst"` to the `role` enum. Migration concerns.
3. **Authority matrix** — orchestrator vs analyst vs specialist. Who can: set goals, assign tasks, modify cycles, edit skills, escalate to user, restart an agent. Decide and document.
4. **Template file tree** — everything in `apps/daemon/templates/context/analyst/`: AGENT.md, SOUL.md, IDENTITY.md, GOALS.md, BOOTSTRAP.md, agent.json defaults (nightly theta-wave cron + heartbeat cron).
5. **Analyst-only tools** — `rondel_experiment_cycle_configure` (from item 1), `rondel_system_effectiveness_score`, `rondel_analyst_report_to_user`. Possibly `rondel_heartbeat_read_all` shared with orchestrator. Schemas + privilege.
6. **Analyst-only skills pack** — `rondel-theta-wave`, `rondel-system-diagnostics`, `rondel-analyst-cycle-oversight`, `rondel-research-external` (optional), and others identified from the CortexOS report. Prose specs for each.
7. **Theta-wave skill** — the canonical 8-phase prose. Full `SKILL.md` content.
8. **Orchestrator ↔ analyst debate protocol** — concrete format: first message from analyst (data + proposal), orchestrator response (accept / counter / push back), N rounds max, convergence rule (agreement, escalate to user, or timeout).
9. **System-effectiveness score** — the rubric (what 1 vs 5 vs 10 means), what data feeds it.
10. **Default cron** — nightly at what time, respecting user timezone.
11. **Reporting to user** — message format, channel (Telegram), frequency (every theta wave? only on notable findings?).
12. **Ledger events** — `theta_wave:started`, `theta_wave:completed`, `analyst:proposal`, `analyst:report_sent`.
13. **Testing strategy** — unit (debate-protocol state machine if formalized), integration (full theta-wave run in a staging org), qualitative (are proposals actionable).
14. **Migration** — existing installs: analyst is opt-in (user runs `rondel add agent analyst --role analyst`).
15. **Open questions** — analyst-per-org vs analyst-singleton, how much external-research context the analyst needs (KB vs web search), whether theta wave should stream live to the dashboard or arrive only on completion, how to prevent analyst-orchestrator loops (they debate forever).

---

## Deliverable

Save to `docs/phase-3/02-analyst-role-design.md`. Editable. Include the full skill prose for theta-wave (and any other analyst-only skills) as embedded sections.

---

## Guardrails for this chat

- **Do not implement.** Design only.
- **Follow Rondel patterns** (CLAUDE.md). Reuse the role infrastructure from Phase 1.
- **Do not over-engineer.** No multi-analyst, no real-time intervention, no auto-escalation beyond the debate + report channels.
- **Flag every trade-off** — especially the authority matrix.
- **Minimize this chat's context** — rely on subagents.
