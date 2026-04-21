---
name: rondel-task-management
description: "Create, claim, block, and complete tasks on the shared org work queue. Invoke any time work runs longer than ~10 minutes, involves another agent, or needs to be visible on the board. Replaces the 'send a message and hope' pattern for durable work."
---

# Task board — shared work queue per org

The task board is the spine of the team. Every unit of work >10min belongs
here: the orchestrator sees what's in flight, specialists can pick up work
across conversations, approvals gate externally-visible actions, and the
audit log makes "who shipped what" a query instead of a guess.

You have eight tools. Discipline below.

## The five rules

1. **Create before you start.** If the work will take more than ~10 minutes,
   or anyone else needs to know about it, `rondel_task_create` *first*. The
   task record is the anchor for everything that follows — message threads,
   approvals, ledger events all key off the task id.

2. **Claim atomically.** Don't mutate status by hand. Call
   `rondel_task_claim`. Exactly one agent wins the lockfile; losers see
   `claim_conflict` and should message the holder or pick another task. If
   `blockedBy` is non-empty, every blocker must be `completed` first —
   you'll get `blocked_by_open` otherwise.

3. **Block with a reason, not a shrug.** When you hit a wall, call
   `rondel_task_block` with a concrete reason: "waiting on user reply",
   "upstream API down, retrying at 18:00", "analyst data stale, asked them
   for refresh". The reason is searchable context for the orchestrator and
   for future-you. "Stuck" is not a reason.

4. **Complete with result + deliverables.** `rondel_task_complete` takes a
   `result` (what shipped, ≤200 words) and an `outputs` array (durable
   artifacts — file paths). If you produced nothing durable, say so in the
   result. Completion is a claim; outputs are evidence.

5. **Respect the DAG.** `blockedBy` means do not start. `rondel_task_list`
   on every heartbeat tells you what's available. If you need to unblock
   yourself, block your own task with a reason and message the upstream
   assignee — don't silently idle.

## Decision tree: task vs message vs subagent

Before picking up a tool, decide:

| Situation | Use | Why |
|---|---|---|
| "I need an isolated context to research X and report back to this conversation" | `rondel_spawn_subagent` | Ephemeral, one caller, <1h, non-persistent |
| "Quick question for a teammate, need a reply" | `rondel_send_message` | Lightweight Q&A, closes after reply |
| "Ship this thing; may involve blockers, approvals, or another agent" | `rondel_task_create` | Persistent, claimable, auditable, DAG-aware |

Rule of thumb: if you'd put it on a Jira board, it's a task. If you'd Slack
someone, it's a message. If you'd open a new chat window to summon help, it's
a subagent.

## Tool reference (terse)

### `rondel_task_create`
Create a new task. Lives in the assignee's org (admins can cross).
- `title` (required, ≤120 chars)
- `description` (optional, markdown ok, ≤8KB)
- `assignedTo` (required agent name, same org as you unless you're admin)
- `priority` (`urgent` | `high` | `normal` | `low`; default normal)
- `blockedBy` (task ids — creates symmetric DAG edges; cycles rejected)
- `dueDate` (ISO 8601; overdue classification runs on staleness sweep)
- `externalAction` (boolean; when true, complete routes through approvals)

Errors: `validation`, `unknown_agent`, `cross_org`, `not_found` (missing
blocker), `cycle_detected`.

### `rondel_task_claim`
Atomically flip pending → in_progress. You must be the assignee (or admin).

Errors: `not_found`, `forbidden`, `invalid_transition`, `blocked_by_open`,
`claim_conflict`.

### `rondel_task_update`
Patch non-status fields (title, description, priority, assignedTo, dueDate,
blockedBy). Reassigning across orgs is blocked. Changing blockedBy
re-checks for cycles. Status flips happen via the dedicated tools.

Errors: `not_found`, `forbidden`, `cross_org`, `invalid_transition`
(terminal task), `cycle_detected`, `validation`.

### `rondel_task_complete`
Mark in_progress → completed. Requires `result`; `outputs` optional.
**If the task has `externalAction: true`**, the tool returns
`{status: "approval_pending", approvalRequestId}` and the task stays
in_progress until the human approves. On allow → completed; on deny →
blocked with the reason. You don't need to re-complete — the daemon
applies the outcome for you.

Errors: `not_found`, `forbidden`, `invalid_transition`.

### `rondel_task_block`
Flip any non-terminal status → blocked with a reason. Releases your claim
so someone else could pick it up if unblocked.

### `rondel_task_unblock`
Flip blocked → pending. Next claim is open to the assignee again.

### `rondel_task_cancel`
Terminal: blocked / in_progress / pending → cancelled. Record is
preserved (not deleted). Use when scope changes or a dependency fell
through.

### `rondel_task_list`
Filter by assignee, status, priority, includeCompleted, staleOnly.
Default scope is your org; admins can pass `org`. Output is ordered:
unblocked first, then blocked; priority desc; createdAt asc.

### `rondel_task_get`
Read one task, optionally with its full audit log
(`includeAudit: true`). Use to inspect history after a state change or
check blockers before claiming.

## Worked example

The orchestrator receives the morning focus "ship the onboarding doc by
EOD". It dispatches three tasks:

```
rondel_task_create {
  title: "Draft onboarding doc v1",
  assignedTo: "writer",
  priority: "high"
}
→ task_1720000001_a1b2

rondel_task_create {
  title: "Review and edit v1",
  assignedTo: "editor",
  priority: "high",
  blockedBy: ["task_1720000001_a1b2"]
}
→ task_1720000002_c3d4

rondel_task_create {
  title: "Publish to marketing site",
  assignedTo: "publisher",
  priority: "high",
  blockedBy: ["task_1720000002_c3d4"],
  externalAction: true
}
→ task_1720000003_e5f6
```

On their heartbeats:
- `writer` sees task 1 is pending and unblocked → claims it → completes
  with `result: "draft at /tmp/onboarding-v1.md"` and
  `outputs: [{type: "file", path: "/tmp/onboarding-v1.md"}]`.
- `editor` can now claim task 2 (blocker is completed) → polishes →
  completes.
- `publisher` claims task 3. On `rondel_task_complete`, the response is
  `{status: "approval_pending", approvalRequestId: "appr_..."}` because
  `externalAction` is true. The operator gets a Telegram button; on
  Approve, the daemon transitions the task to completed and emits
  `task:completed`. `publisher` doesn't need to retry.

Auditing post-facto: `rondel_task_get task_..._a1b2 includeAudit=true`
returns the full state-change history — `created`, `claimed`,
`completed` — each with timestamp and actor.

## Things to remember

- **The board is visible.** Every state change emits a ledger event and
  a stream delta. The web dashboard at `/tasks` shows the live board. Your
  decisions show up there.
- **Completed tasks survive but drop off the default view.** Pass
  `includeCompleted=true` on list when you need to check shipped work.
- **Staleness is automatic.** On every heartbeat, the sweep flags tasks
  past their threshold (pending > 24h, in_progress > 2h since claim). A
  stale flag isn't a failure — it's a nudge to update or reassign.
- **`externalAction` is a contract, not a nag.** Mark it true when
  completion produces something the user would want to vet: a publish, a
  send, an invoice, a deploy. The approval card carries your result and
  outputs so the human has full context.
- **Don't fight the DAG.** If `blocked_by_open` comes back, don't skip —
  work on an unblocked task, or escalate via `rondel_send_message` to the
  upstream assignee.
