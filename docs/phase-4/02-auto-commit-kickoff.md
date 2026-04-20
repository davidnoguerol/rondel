# Phase 4 Kickoff — Auto-Commit Skill with Credential Guards

## Your job in this chat

Design the **auto-commit** capability for Rondel, to spec-level quality, following our modularity contract. **Do not implement it.** Produce a design document I can review, iterate on, and then hand to a future implementation chat.

---

## Context

### Rondel, in one paragraph
Rondel is a multi-agent orchestration framework built on the Claude CLI. The long-term vision is an **agentic self-evolving harness** that manages real operations. Agents produce deliverables (code, docs, configs, skill edits from experiments). Today committing that work is manual. For Phase 4 we give agents the ability to commit their own work autonomously, with strong credential + size + allowlist guards to prevent catastrophe.

### What Phase 4 is
Phase 4 is polish — async messaging (sibling kickoff), auto-commit, anything else after the substrate is solid. See [`docs/GAP-ANALYSIS-CORTEXTOS.md`](../GAP-ANALYSIS-CORTEXTOS.md) section 8.

### This item — Auto-commit
A single MCP tool, `rondel_auto_commit`, that an agent can invoke to stage + commit changes in its `workingDirectory`. Before committing, the tool runs a set of guards: (a) reject binary files, logs, caches, build artifacts; (b) reject files matching credential patterns (tokens, keys, passwords, `sk-`, `ghp_`, `xoxb-`, AWS keys); (c) reject files > N MB; (d) reject paths outside `workingDirectory`; (e) require a commit message from the caller. On success, emit a ledger event and — depending on the design — optionally open a PR or stay on a feature branch. CortexOS has `bus/auto-commit.sh` + filter rules in `src/bus/system.ts` we'll study. This is adjacent to Rondel's existing `rondel_bash` tool (which can already run `git commit`) but adds structured safety.

### Dependencies
None hard. This is a self-contained skill + tool. Useful for Phase 3 experiments (commit the experimental change for revert).

### Files to read if you need depth
- `CLAUDE.md`
- `apps/daemon/src/approvals/` in Rondel (existing per-tool safety classifier pattern)
- `docs/GAP-ANALYSIS-CORTEXTOS.md` — section 8

---

## Step 1 — Parallel research (dispatch two subagents)

### Subagent A — OpenClaw
**Path**: `/Users/david/Code/openclaw`
**Focus**: does OpenClaw commit agent-produced changes to git? Any auto-commit patterns, credential scanning, size limits, branch/PR flows? How does OpenClaw handle "the agent changed a file that shouldn't be committed"?

### Subagent B — CortexOS
**Path**: `/Users/david/Code/cortextos`
**Focus**: map the auto-commit. Key files: `bus/auto-commit.sh` (CLI wrapper), `src/bus/system.ts` lines 100–150 (`autoCommit()` implementation — file filtering, credential patterns, size limits), deliverable-tracking linkage via `save-output.sh`, git commands executed. Cover: exact blocklists (extensions, directories, regex), allowlist (if any), dry-run behavior, commit message format, branch strategy (main vs feature), how the agent decides when to invoke it.

### Shared output schema

```
## 1. Concept presence
Yes / Partial / No — 1-sentence summary

## 2. Guard model
- Blocklist: extensions, paths, regex patterns
- Allowlist (if any)
- Size limit
- Credential-pattern regex list

## 3. Command flow
- Pre-check (dry-run, what-would-be-staged)
- Stage + commit
- Commit message source (agent-provided, auto-generated, templated)
- Branch policy (main vs feature)

## 4. Failure modes
- What happens when a credential is detected (reject-and-log, quarantine, human-approval)
- Size cap exceeded
- Outside working directory
- Git in bad state (detached HEAD, conflicts)

## 5. Integration
- Task / deliverable linkage
- Ledger event format
- Approval escalation (some commits need human sign-off?)

## 6. Agent-side discipline
- When agents MUST auto-commit (experiments, deliverables)
- When agents MUST NOT (ephemeral scratch, credential-adjacent work)
- Skill prose encoding

## 7. Revert / undo
- How agents back out a bad commit
- git-revert vs git-reset decisions

## 8. Strengths worth adopting for Rondel
## 9. Anti-patterns / not to copy
## 10. Key file paths (absolute)
```

---

## Step 2 — Rondel codebase research

1. **Existing safety classifier pattern** — `apps/daemon/src/approvals/` + `apps/daemon/src/shared/safety/`. Every `rondel_*` tool already has a safety classifier that decides escalate-to-human. Auto-commit is a perfect fit for this.
2. **Approval service** — how existing tools escalate dangerous calls to Telegram inline buttons. Auto-commit can plug into this without new infrastructure.
3. **`rondel_bash` tool** — today's general-purpose shell tool. Auto-commit could be a thin wrapper or a fully-distinct tool. Decide.
4. **Filesystem tools** — `rondel_read_file` / `rondel_write_file` / `rondel_edit_file` — the guards they already enforce. Auto-commit's file-level guards should be consistent.
5. **Ledger** — event kinds for commit success/failure.
6. **Experiment module** (Phase 3 item 1) — if auto-commit is the revert mechanism for experiments, the integration contract.
7. **Working directory enforcement** — how `workingDirectory` in agent.json is honored; auto-commit must respect it.

---

## Step 3 — Synthesize the design

1. **Scope** — Phase 4: auto-commit with guards + skill + ledger. Defer: auto-push, auto-PR, multi-branch workflows, sign-commits (GPG).
2. **Tool surface** — `rondel_auto_commit(message, dry_run?, scope?)`. Schema. Return shape (files staged, files rejected with reasons, commit SHA).
3. **Guard rules** — full list: extension blocklist, directory blocklist, size cap, credential regex list, path-must-be-inside-workingDirectory.
4. **Safety classifier integration** — where this tool sits on the approval-escalation spectrum. Auto-escalate to human for: first-commit on a repo? Commits to the main branch? Always? Configurable per-org.
5. **Commit message format** — agent-provided, with optional framework suffix (`[rondel:auto-commit agent=X experiment=Y]` for traceability).
6. **Branch policy** — recommend: never commit directly to `main`/`master`. Always feature branch named `rondel/<agent>/<short-topic>`. How we enforce.
7. **Revert / undo** — `rondel_auto_revert(sha)`. Schema. Safety checks.
8. **Credential scanner** — the regex set. Test against real credentials in a fixtures file (not checked in).
9. **Skill prose** — `rondel-auto-commit/SKILL.md` — when to use, when not to, message conventions.
10. **Ledger events** — `commit:succeeded`, `commit:rejected`, `commit:escalated`. Payload shapes (including files rejected with reasons).
11. **Relationship to `rondel_bash`** — do we disallow `git commit` via `rondel_bash` once auto-commit ships? Or parallel mechanisms? Decide.
12. **Testing strategy** — unit (guard rules, credential regex), integration (actual git on a scratch repo), end-to-end (agent invokes, commit lands, revert).
13. **Migration** — new tool, opt-in; no changes to existing workflows.
14. **Open questions** — should auto-commit always require approval (slow but safe), or only on trigger-tier classification? Should the credential scanner use a vendor library (e.g., `detect-secrets`) or hand-rolled regex? How does this interact with the per-tool safety classifier — is auto-commit its own classifier or does it reuse bash's?

---

## Deliverable

Save to `docs/phase-4/02-auto-commit-design.md`. Editable.

---

## Guardrails for this chat

- **Do not implement.** Design only.
- **Follow Rondel patterns** (CLAUDE.md + existing safety classifier architecture). Auto-commit must feel like every other first-class Rondel tool.
- **Do not over-engineer.** No auto-push, no auto-PR, no GPG for Phase 4. Strictly local commits with guards.
- **Flag every trade-off** — especially approval-tier decisions (when does a commit need human sign-off).
- **Preserve what Rondel has** — reuse approval service, safety classifier pattern, ledger.
- **Minimize this chat's context** — rely on subagents.
