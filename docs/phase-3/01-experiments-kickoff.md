# Phase 3 Kickoff — Experiments + Autoresearch Cycles

## Your job in this chat

Design the **per-agent experiments + autoresearch** capability for Rondel, to spec-level quality, following our modularity contract. **Do not implement it.** Produce a design document I can review, iterate on, and then hand to a future implementation chat.

---

## Context

### Rondel, in one paragraph
Rondel is a multi-agent orchestration framework built on the Claude CLI. The long-term vision is an **agentic self-evolving harness** that manages real operations — a team of agents that wake up on their own, share a task board, cascade goals from a coordinator down to specialists, **run nightly experiments to improve themselves**, and give the user a daily rhythm of morning briefings and evening recaps.

### What Phase 3 is
Phase 3 adds **self-evolution**: agents run structured experiments, an analyst agent runs nightly theta-wave reviews, and the web UI surfaces everything for the user. After Phase 3, agents measurably improve their own skills over time. See [`docs/GAP-ANALYSIS-CORTEXTOS.md`](../GAP-ANALYSIS-CORTEXTOS.md) section 7.

### This item — Experiments + autoresearch
Each agent can have assigned **research cycles**: a quantitative metric (e.g., `briefing_quality_score`, `tasks_completed_per_day`), a surface to modify (e.g., `rondel-morning-review/SKILL.md`), a direction (higher is better), and a measurement window. On a cron, the agent runs a 6-step loop: gather context (past experiments, learnings, keep-rate) → evaluate previous experiment (measured vs baseline) → hypothesize (exploit successful patterns, explore after discards) → create experiment (hypothesis + metric + surface) → make the change (commit to git, revertable) → wait for next cron. Experiment state persists in `results.tsv` and `learnings.md`. This is structured scientific iteration, not ad-hoc tinkering. The analyst role (next kickoff) is the system-level coordinator of all agent experiments.

### Dependencies
All of Phase 1 (especially heartbeat, task board) and Phase 2 item 1 (daily memory). The KB (Phase 2 item 2) is optional but useful for experiments to persist learnings.

### Files to read if you need depth
- `CLAUDE.md`
- `docs/GAP-ANALYSIS-CORTEXTOS.md` — section 7
- `docs/PHASE-1-PLAN.md`

---

## Step 1 — Parallel research (dispatch two subagents)

### Subagent A — OpenClaw
**Path**: `/Users/david/Code/openclaw`
**Focus**: does OpenClaw have any self-improvement / experimentation / A-B testing / metric-driven iteration? Any mechanism for agents to measure themselves and modify their own behavior? Adjacent patterns: reflection loops, learning checkpoints, feedback aggregation?

### Subagent B — CortexOS
**Path**: `/Users/david/Code/cortextos`
**Focus**: map the experiment system in detail. Key files: `src/bus/experiment.ts` (lifecycle: propose → run → evaluate), `templates/analyst/.claude/skills/autoresearch/SKILL.md` (the 6-step loop), `templates/analyst/experiments/active.json`, `templates/analyst/experiments/results.tsv` (TSV schema), `templates/analyst/experiments/learnings.md`, `templates/analyst/experiments/history/` (per-experiment JSON archive), `gatherContext()` function. Cover: how research cycles are assigned per agent, the exploit-vs-explore policy (3+ keeps → exploit; 3+ discards → explore), how experiments commit to git for rollback, how the baseline updates on keep, how direction (higher/lower) drives the keep/discard decision, how an agent decides when a cycle has converged.

### Shared output schema

```
## 1. Concept presence
Yes / Partial / No — 1-sentence summary

## 2. Experiment data model
- Active experiment schema (hypothesis, metric, surface, baseline, direction, window)
- Historical record schema
- Cumulative learnings format
- On-disk layout

## 3. Cycle definition
- Cycle parameters (metric, surface, measurement window, direction)
- How cycles are assigned to agents
- Who can create / modify cycles

## 4. Lifecycle
- propose → run → evaluate → keep/discard/learn
- State transitions
- Revert semantics (git commit, prior version)

## 5. Decision policy
- Keep rule (measured value ≥ / ≤ baseline by margin?)
- Discard rule
- Exploit (N consecutive keeps triggers aggressive extension)
- Explore (N consecutive discards triggers new direction)
- Convergence (when does a cycle stop producing new experiments)

## 6. Trigger
- Cron interval per agent
- Dependency: must the agent finish previous experiment before new?

## 7. Measurement
- How the metric is measured (agent self-assesses? external instrument?)
- Baseline update policy (rolling, fixed, exponentially weighted)

## 8. Context gathering
- What the agent reads before hypothesizing
- How past learnings influence the next hypothesis

## 9. Integration points
- Tasks (experiment might be a task)
- Heartbeat (cycle cron is heartbeat-adjacent)
- Memory / KB (learnings persist)
- Analyst (system-level oversight)
- Git (commit + revert)

## 10. Strengths worth adopting for Rondel
## 11. Anti-patterns / not to copy
## 12. Key file paths (absolute)
```

---

## Step 2 — Rondel codebase research

1. **Scheduler** — `apps/daemon/src/scheduling/` — each research cycle is one scheduled cron per agent.
2. **Task board** — Phase 1 item 2 — experiments can surface as tasks when they require work >10 min.
3. **Memory + KB** — Phase 2 items — learnings persist here.
4. **Git integration** — Rondel currently has no programmatic git operations in the daemon. Experiments need the ability to commit a change and revert. Is this a new concern (`apps/daemon/src/git/`) or done via `rondel_bash`?
5. **Agent working directory** — `workingDirectory` field in agent.json. Commits happen in the agent's workspace? A dedicated experiments workspace?
6. **MCP tool surface** — new `rondel_experiment_*` tools; decide surface shape based on CortexOS's patterns.
7. **Ledger** — new event kinds `experiment:created`, `experiment:kept`, `experiment:discarded`, `experiment:converged`.
8. **Stream source** — web UI will want to see experiment history.
9. **Analyst coordination** — this feature is used by all agents but coordinated by the analyst (next kickoff). Keep the module self-contained.

---

## Step 3 — Synthesize the design

1. **Scope** — Phase 3: one cycle per agent maximum (simpler start), minimal KB integration, git-optional revert. Defer: multi-cycle per agent, cross-agent cycle coordination, LLM-assisted hypothesis generation.
2. **Data model** — `ResearchCycle`, `Experiment`, `ExperimentResult` schemas. On-disk layout (`state/experiments/{org}/{agent}/` with active.json, results.tsv, learnings.md, history/).
3. **Cycle assignment** — who assigns (orchestrator? admin? analyst?). Where the assignment lives (agent.json? separate cycle-config?).
4. **Module layout** — `apps/daemon/src/experiments/`: store, service, policy (pure keep/discard logic), tool. Barrel.
5. **Policy module** — pure functions: `shouldKeep(baseline, measured, direction, margin)`, `shouldExploit(history)`, `shouldExplore(history)`, `isConverged(history)`. Configurable thresholds.
6. **Measurement model** — agent self-assess (structured prompt with 1–10 scale + justification) vs external (ledger-derived metrics like tasks_completed_per_day). Decide: ship both with explicit mode.
7. **Revert mechanism** — options: (a) git commit + git revert via `rondel_bash`; (b) service-managed snapshot + restore; (c) skill file versioning via file-history (Rondel has `FileHistoryStore`). Pick one with rationale.
8. **MCP tool surface** — `rondel_experiment_propose`, `rondel_experiment_evaluate`, `rondel_experiment_list`, `rondel_experiment_cycle_configure` (analyst-only). Schemas.
9. **Skill** — `rondel-autoresearch/SKILL.md` — the 6-step prose discipline.
10. **Bridge endpoints** — `GET /experiments/:org/:agent`, history page.
11. **Ledger events** — payloads for each transition.
12. **Testing strategy** — unit (policy pure functions), integration (cycle runs across multiple cron fires), end-to-end (skill change persists, baseline updates).
13. **Safety** — a bad experiment can regress an agent. How do we cap the blast radius? Auto-revert after N consecutive discards on a changed surface? Time-bounded experiments?
14. **Migration** — new state dir; no breaking changes.
15. **Open questions** — git vs snapshot, self-assess vs external, blast-radius cap, whether cycles should target system-prompt sections vs skill files vs tool allowlists.

---

## Deliverable

Save to `docs/phase-3/01-experiments-design.md`. Editable.

---

## Guardrails for this chat

- **Do not implement.** Design only.
- **Follow Rondel patterns** (CLAUDE.md). Pure policy module is critical.
- **Do not over-engineer.** One cycle per agent for Phase 3; no cross-agent coordination yet.
- **Flag every trade-off** — especially revert mechanism and measurement mode.
- **Minimize this chat's context** — rely on subagents.
