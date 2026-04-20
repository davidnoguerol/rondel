# Phase 1 — Task Board Design

> Spec for the `apps/daemon/src/tasks/` domain. Draft — edit freely before
> implementation.
>
> Reference kickoff: [`02-task-board-kickoff.md`](./02-task-board-kickoff.md).
> Companion design (same contract, already shipped): [`01-heartbeat-design.md`](./01-heartbeat-design.md).
> External research: CortexOS `src/bus/task.ts` (DAG + atomic claim + audit log model — the primary influence) and OpenClaw `src/tasks/` (multi-runtime registry + push-based completion — mostly informative, less directly applicable).

---

## 1. Scope

### In

- A per-organization work queue of **persistent, claimable tasks**.
- Minimal-but-honest state machine: `pending → in_progress → completed` (plus `blocked` and `cancelled`).
- DAG dependencies: `blockedBy[]` + symmetric `blocks[]`, cycle-detected before write.
- Atomic claim via a `.claims/<id>.claim` lockfile (O_EXCL semantics).
- Append-only audit log per task at `state/tasks/{org}/audit/{id}.jsonl`.
- Staleness classification callable from inside the heartbeat skill. **No new cron.**
- MCP tools: `rondel_task_create`, `rondel_task_claim`, `rondel_task_update`, `rondel_task_complete`, `rondel_task_block`, `rondel_task_cancel`, `rondel_task_list`, `rondel_task_get`.
- Bridge read endpoints (`GET /tasks/:org`, `GET /tasks/:org/:id`, `GET /tasks/tail` for SSE) and a matching admin/service POST surface keyed off caller identity.
- Stream source for the web UI (snapshot + delta), mirroring `HeartbeatStreamSource`.
- Hook events for ledger fan-out: `task:created`, `task:claimed`, `task:updated`, `task:blocked`, `task:completed`, `task:cancelled`, `task:stale`.
- Approval integration when a task carries `externalAction: true` — completion routes through the existing `approvals/` domain before committing.
- Framework skill `rondel-task-management/SKILL.md` encoding the discipline.
- Org-scoped hard isolation: a task lives in exactly one org and agents cannot read/write tasks outside their org (admins cross freely, matching heartbeats).

### Out (explicitly deferred)

- **Cross-org task dispatch.** CortexOS does it; Rondel's bridge is strict about org isolation everywhere else. Punt until the orchestrator role clarifies the need.
- **Recurring tasks / templates.** If you want "run a weekly report," create a cron that calls `rondel_task_create` — don't put recurrence into the task model.
- **Task archival / compaction.** CortexOS archives at 7d and compacts monthly. We log it as a known future need and `state/tasks/{org}/` grows forever for Phase 1 (documented in ARCHITECTURE.md state-file policy). Revisit after dogfooding for a quarter.
- **Re-assignment / handoff mid-flight.** If claim + crash happens, the orchestrator can un-claim by flipping status back to `pending` and deleting the lockfile — handled as operator discipline, not a code path.
- **Time-tracking / effort estimates.** `createdAt`, `claimedAt`, `completedAt` are enough for Phase 1. No estimated-duration field.
- **KPI linkage.** CortexOS has `kpi_key`. Skip until the goal system (kickoff §3) clarifies whether it belongs on the task or emitted via a separate ledger event.
- **`notifyPolicy` / push-based completion routing.** OpenClaw has a rich delivery model; Rondel already has `rondel_send_message`, so dispatching a task emits a notification via the existing path instead of baking delivery into the task module.
- **Multi-runtime bookkeeping.** OpenClaw tracks whether a task was spawned by cron/subagent/CLI. Rondel's ledger already captures that via `cron_completed` / `subagent_spawned`; no need to duplicate on the task.
- **Optimistic-concurrency `revision` on updates.** OpenClaw does this for flows. For Rondel's per-task files with serialized writes per task id, last-writer-wins on non-claim mutations is fine; the atomic claim is the only contested operation.

---

## 2. Data model

### On-disk layout

```
~/.rondel/state/
  tasks/
    {org}/                             ← one directory per org; "global" for unaffiliated
      task_<epoch>_<hex>.json         ← mutable task record (active + completed + cancelled)
      .claims/
        task_<epoch>_<hex>.claim      ← O_EXCL lockfile ("agent\tiso8601\n"); present iff status != pending
      audit/
        task_<epoch>_<hex>.jsonl      ← append-only audit log, one line per state change
```

**"Global" org**: for unaffiliated agents, the directory is `state/tasks/global/`. Same rule as heartbeats' `org` field.

**ID format**: `task_<epoch-ms>_<4-hex>` — matches the Rondel convention used by `appr_<epoch>_<hex>` and `sched_<epoch>_<hex>`. Regex: `/^task_\d+_[a-f0-9]+$/`. The ID must validate before any filesystem path is derived from it (prevents path traversal via crafted IDs — same defense-in-depth as `approval-store.ts`).

**Per-org directories** — cross-org access is impossible by construction. The bridge already enforces org isolation on every other read path; tasks are identical.

### TaskRecord schema

Internal runtime type in `shared/types/tasks.ts`:

```ts
export type TaskStatus = "pending" | "in_progress" | "blocked" | "completed" | "cancelled";
export type TaskPriority = "urgent" | "high" | "normal" | "low";

export interface TaskOutput {
  readonly type: "file";          // only file outputs in Phase 1
  readonly path: string;          // absolute or workspace-relative
  readonly label?: string;
}

export interface TaskRecord {
  readonly version: 1;            // schema version; future-proofs migrations
  readonly id: string;            // task_<epoch>_<hex>
  readonly org: string;           // owning org, or "global"
  readonly title: string;         // ≤120 chars, required
  readonly description: string;   // markdown OK, ≤8KB
  readonly status: TaskStatus;
  readonly priority: TaskPriority;
  readonly createdBy: string;     // agent name
  readonly assignedTo: string;    // agent name; must be same-org as task.org
  readonly createdAt: string;     // ISO 8601
  readonly updatedAt: string;     // ISO 8601; bumped on every mutation
  readonly claimedAt?: string;    // set when status first → in_progress
  readonly completedAt?: string;  // set when status → completed OR cancelled
  readonly dueDate?: string;      // ISO 8601
  readonly blockedBy: readonly string[];  // task ids this task depends on
  readonly blocks: readonly string[];     // task ids waiting on this; maintained symmetrically
  readonly blockedReason?: string;        // set when transitioning → blocked
  readonly externalAction: boolean;       // gates completion through approvals
  readonly result?: string;               // completion summary
  readonly outputs: readonly TaskOutput[];
}
```

**Field rationale**:

- `version: 1` — cortextos doesn't have it; adding because skipping it bites when Phase 2 extends the schema. Store refuses records with `version !== 1` on load (logs + returns undefined, same quarantine discipline as `approval-store.ts`).
- Split `createdBy` vs `assignedTo` — the creator isn't always the assignee (orchestrator dispatches to a specialist).
- `blockedBy[]` + `blocks[]` **maintained together** on create and complete. Symmetric — lets `list()` and the cycle-checker answer "who's unblocked now?" in O(1).
- `blockedReason` as a structured field — CortexOS omits this and tribal knowledge forces agents to write the reason into a separate message; bake it in.
- `externalAction: boolean` — the approval-integration gate. Keeping it boolean (not `needsApproval: category`) because the existing `approvals/` module owns the reason-for-approval enum; don't split it.
- `outputs` as an array of structured entries, not a single path — a task can ship a spec + a script + a report.
- `result` as free text — completion summary the agent writes.

### TaskAuditEntry schema

```ts
export type TaskAuditEvent =
  | "created"
  | "claimed"
  | "updated"
  | "blocked"
  | "unblocked"
  | "completed"
  | "cancelled";

export interface TaskAuditEntry {
  readonly ts: string;            // ISO 8601
  readonly event: TaskAuditEvent;
  readonly by: string;            // agent name performing the action
  readonly fromStatus?: TaskStatus;
  readonly toStatus?: TaskStatus;
  readonly note?: string;         // optional free-form (block reason, update summary, etc.)
}
```

One line per mutation, appended via `appendFile` (not atomic-write — append is atomic at the OS level for small records). Survives task archival; the JSON file may eventually move to an archive directory, but the audit log stays put. (Archival itself is deferred, so this is a Phase 2 concern.)

### Zod schemas (boundary)

Mirror `HeartbeatRecordSchema` discipline — one canonical schema in `bridge/schemas.ts`; the store validates every file it reads through it. Shapes:

- `TaskRecordSchema` — matches `TaskRecord` exactly, validates on every store read.
- `TaskAuditEntrySchema` — validates audit lines on read; malformed lines are skipped with an error log (same as `readJsonFile` pattern in the inbox module).
- `TaskCreateInputSchema`, `TaskClaimInputSchema`, `TaskUpdateInputSchema`, `TaskCompleteInputSchema`, `TaskBlockInputSchema`, `TaskCancelInputSchema` — HTTP/MCP boundary shapes, each with `callerAgent` for identity (same forgeable-identity caveat that `/heartbeats/update` and `/schedules/*` carry — documented inline).
- `TaskListQuerySchema` — filter params (assignee, status, priority, includeCompleted, staleOnly).
- `TaskListResponseSchema`, `TaskReadResponseSchema` — wire shapes for the bridge.

**API version bump** — adding a new endpoint doesn't require bumping `BRIDGE_API_VERSION` per the rules at the top of `schemas.ts`, BUT adding new ledger kinds (§9) does require a bump because it's a new enum value on the wire. One bump for the whole task board introduction.

### Mutability

- Task JSON: **mutable**, overwritten in place via `atomicWriteFile` (write-to-temp + rename). One file per task.
- Audit JSONL: **append-only**, via `appendFile`. Never rewritten.
- Claim lockfile: **create-exclusive**. Written with `O_EXCL` (`writeFile(path, data, {flag: "wx"})` — `node:fs/promises` rejects with `EEXIST` on collision). Deleted only when the task is un-claimed back to `pending` or the claim rolls back on a write-failure path.

### Staleness tiers

Same pure-function pattern as `classifyHealth` in heartbeats. Thresholds hardcoded, documented:

```ts
export const PENDING_STALE_MS       = 24 * 60 * 60 * 1000;  // 24h
export const IN_PROGRESS_STALE_MS   =  2 * 60 * 60 * 1000;  //  2h
// blocked: stale only when its blockedBy chain has been resolved and no-one claimed after.
// due_date past: always stale regardless of status, unless completed/cancelled.

export type TaskStaleness = "fresh" | "stale_pending" | "stale_in_progress" | "overdue" | "blocked_unblockable";

export function classifyStaleness(task: TaskRecord, nowMs: number, peers: ReadonlyMap<string, TaskRecord>): TaskStaleness;
```

`classifyStaleness` is pure and lives in `task-dag.ts` alongside the cycle detector. Heartbeat skill calls `service.findStale(nowMs)` which calls this. No separate scheduler entry.

**Note**: staleness thresholds are hardcoded in Phase 1 to match CortexOS. Making them per-org-configurable is a candidate for Phase 2 — deferred because we have no data yet on what the right numbers are.

---

## 3. Module layout

```
apps/daemon/src/tasks/
├── index.ts                  ← barrel: exports TaskService, TaskError, pure helpers, types
├── task-dag.ts               ← PURE: cycle detection, blocked-by resolution, staleness classification
├── task-dag.unit.test.ts
├── task-store.ts             ← file I/O: read/write JSON, claim lockfile, audit append
├── task-store.integration.test.ts
├── task-service.ts           ← business logic: create/claim/update/complete/block/cancel/list
├── task-service.integration.test.ts
└── task-service.edge.integration.test.ts  ← cross-org, forbidden, race conditions

apps/daemon/src/shared/types/tasks.ts       ← pure types, zero runtime imports

apps/daemon/src/streams/task-stream.ts      ← SSE snapshot + delta, mirrors heartbeat-stream.ts
apps/daemon/src/streams/task-stream.unit.test.ts
```

External consumers import from `../tasks` (barrel). Internal files import each other directly. Cross-domain types in `shared/types/tasks.ts` — matches the heartbeats split.

### `task-dag.ts` (pure, no I/O)

```ts
// Cycle detection — runs before any write that adds or changes an edge.
export function detectCycle(
  virtualTask: { id: string; blockedBy: readonly string[] },
  peers: ReadonlyMap<string, Pick<TaskRecord, "id" | "blockedBy">>,
): { cycle: readonly string[] } | null;

// DFS walk from virtualTask through `peers` via blockedBy; returns the cycle
// path if one exists, null otherwise. Unknown peer IDs are treated as
// leaves — not an error here; the store raises separately if we want strict
// validation. (Phase 1: strict — unknown parents reject at the service.)

// Blocked-by resolution — who is currently blocking this task?
export function openBlockers(
  task: Pick<TaskRecord, "blockedBy">,
  peers: ReadonlyMap<string, Pick<TaskRecord, "id" | "status">>,
): readonly string[];
// Returns ids in `blockedBy` whose peer is not in status "completed". Missing peer = treated as open.

// Staleness classification — pure function of (task, now, peers).
export function classifyStaleness(
  task: TaskRecord,
  nowMs: number,
  peers: ReadonlyMap<string, TaskRecord>,
): TaskStaleness;

// List ordering: unblocked first, then blocked; priority desc, then createdAt asc.
export function orderTasks(tasks: readonly TaskRecord[], peers: ReadonlyMap<string, TaskRecord>): readonly TaskRecord[];
```

Unit-testable without a filesystem. No dependencies.

### `task-store.ts` (file I/O only)

```ts
export interface TaskPaths { readonly rootDir: string; }
// Per-org helpers derive from rootDir + org: orgDir, claimsDir, auditDir.

export async function writeTask(paths: TaskPaths, record: TaskRecord): Promise<void>;     // atomicWriteFile
export async function readTask(paths: TaskPaths, org: string, id: string, log?: Logger): Promise<TaskRecord | undefined>;
export async function listTasks(paths: TaskPaths, org: string, log?: Logger): Promise<TaskRecord[]>;

// Atomic claim — O_EXCL. Returns true if claimed here, false if lock already existed.
// The body of the lockfile: `<agent>\t<iso8601>\n`. If `agent` matches, returns true (idempotent).
export async function tryClaim(paths: TaskPaths, org: string, id: string, agent: string): Promise<{ claimed: boolean; holderAgent?: string; holderAt?: string }>;

// Release — unlink the lockfile. Used when un-claiming (blocked → pending) or rolling back a failed claim.
export async function releaseClaim(paths: TaskPaths, org: string, id: string): Promise<void>;

export async function appendAudit(paths: TaskPaths, org: string, entry: TaskAuditEntry): Promise<void>;
export async function readAudit(paths: TaskPaths, org: string, id: string, log?: Logger): Promise<TaskAuditEntry[]>;

export async function removeTask(paths: TaskPaths, org: string, id: string): Promise<void>; // used only on hard cancel + admin delete agent
```

Name/ID validation (regex-gated) before any path derivation, identical to `approval-store.ts`. Malformed on-disk records are logged and returned as `undefined`; the service treats this as "task does not exist." No fall-through to raw JSON.

### `task-service.ts` (business logic)

Dependencies (injected — same shape as `HeartbeatServiceDeps`):

```ts
export interface TaskServiceDeps {
  readonly paths: TaskPaths;
  readonly hooks: RondelHooks;
  readonly orgLookup: OrgLookup;                            // from shared/org-isolation
  readonly isKnownAgent: (agent: string) => boolean;
  readonly approvals?: ApprovalService;                     // optional — only needed if any task uses externalAction
  readonly log: Logger;
}

export class TaskService {
  async init(): Promise<void>;                              // mkdir the state dirs

  async create(caller: TaskCaller, input: TaskCreateInput): Promise<TaskRecord>;
  async claim(caller: TaskCaller, id: string): Promise<TaskRecord>;
  async update(caller: TaskCaller, id: string, patch: TaskUpdateInput): Promise<TaskRecord>;
  async complete(caller: TaskCaller, id: string, input: TaskCompleteInput): Promise<TaskRecord>;
  async block(caller: TaskCaller, id: string, reason: string): Promise<TaskRecord>;
  async unblock(caller: TaskCaller, id: string): Promise<TaskRecord>;     // blocked → pending; releases claim if held
  async cancel(caller: TaskCaller, id: string, reason?: string): Promise<TaskRecord>;

  async readOne(caller: TaskCaller, id: string): Promise<TaskRecord | undefined>;
  async list(caller: TaskCaller, query: TaskListQuery): Promise<readonly TaskRecord[]>;
  async findStale(caller: TaskCaller, nowMs: number): Promise<readonly { task: TaskRecord; staleness: TaskStaleness }[]>;
  async readAudit(caller: TaskCaller, id: string): Promise<readonly TaskAuditEntry[]>;

  // Called from AdminApi on delete-agent: re-parent or cancel every task owned by agent.
  async onAgentDeleted(agent: string): Promise<void>;
}
```

Caller context:

```ts
export interface TaskCaller {
  readonly agentName: string;
  readonly isAdmin: boolean;
}
```

Org-isolation is enforced per call via `checkOrgIsolation(orgLookup, caller.agentName, task.org-as-virtual-agent)` — or, more directly, by resolving the caller's org and rejecting any access where `task.org !== callerOrg` AND `!caller.isAdmin`. Mirrors `HeartbeatService.assertCrossOrgAllowed` exactly.

### Error type

```ts
export type TaskErrorCode =
  | "validation"
  | "not_found"
  | "unknown_agent"
  | "forbidden"
  | "cross_org"
  | "invalid_transition"     // e.g. claim on already-claimed task
  | "cycle_detected"
  | "blocked_by_open"        // claim attempted but blockers are open
  | "claim_conflict"         // O_EXCL fight lost
  | "approval_pending";      // completion requested but externalAction requires approval that's still pending

export class TaskError extends Error {
  constructor(public readonly code: TaskErrorCode, message: string, public readonly details?: unknown) { super(message); }
}
```

Bridge maps: `not_found` → 404, `unknown_agent` → 404, `forbidden`/`cross_org` → 403, `cycle_detected`/`invalid_transition`/`blocked_by_open`/`claim_conflict`/`approval_pending`/`validation` → 400/409 depending. Mirrors the `mapHeartbeatError` pattern.

### Barrel

```ts
// apps/daemon/src/tasks/index.ts
export { TaskService, TaskError, type TaskCaller, type TaskServiceDeps, type TaskErrorCode } from "./task-service.js";
export { classifyStaleness, detectCycle, openBlockers, orderTasks,
         PENDING_STALE_MS, IN_PROGRESS_STALE_MS } from "./task-dag.js";
export type { TaskPaths } from "./task-store.js";
```

---

## 4. Concurrency model

### The only contested operation is claim

Every other mutation is a per-task JSON file overwrite — the service calls are async but the Bridge naturally serializes per-request. If multiple callers race to `update()` the same task, last-writer-wins on disk; we accept that. OpenClaw's `revision`-based optimistic concurrency is overkill for Phase 1.

**Claim is different.** Two agents calling `tryClaim(id, agentA)` and `tryClaim(id, agentB)` in parallel **must** have exactly one winner.

### Mechanism

```ts
// task-store.ts, inside tryClaim():
const lockPath = join(claimsDir, `${id}.claim`);
const body = `${agent}\t${new Date().toISOString()}\n`;
try {
  await writeFile(lockPath, body, { flag: "wx" });  // O_CREAT | O_EXCL
  return { claimed: true };
} catch (err) {
  if (isNodeError(err) && err.code === "EEXIST") {
    const existing = await readLockFile(lockPath);
    // idempotent — same agent re-claiming is fine
    if (existing?.agent === agent) return { claimed: true };
    return { claimed: false, holderAgent: existing?.agent, holderAt: existing?.ts };
  }
  throw err;
}
```

`{flag: "wx"}` on `node:fs/promises.writeFile` maps to POSIX `O_WRONLY | O_CREAT | O_EXCL`. This is atomic in the kernel: only the first caller gets the file; everyone else gets `EEXIST`. This is the same pattern CortexOS uses. Rondel doesn't currently have an atomic-create helper — we introduce it inline in `task-store.ts`; if a second domain needs it, promote to `shared/`.

### Service-layer claim

```ts
async claim(caller, id): Promise<TaskRecord> {
  const task = await this.loadOrThrow(org, id);
  this.assertSameOrg(caller, task);
  if (task.status !== "pending") throw new TaskError("invalid_transition", `task ${id} is ${task.status}, not pending`);
  if (task.assignedTo !== caller.agentName && !caller.isAdmin) {
    throw new TaskError("forbidden", `task ${id} assigned to ${task.assignedTo}`);
  }
  // DAG gate — all blockers must be completed
  const peers = await this.readPeerStatuses(task.blockedBy);
  const open = openBlockers(task, peers);
  if (open.length > 0) throw new TaskError("blocked_by_open", `blocked by: ${open.join(", ")}`);

  const result = await tryClaim(this.deps.paths, task.org, task.id, caller.agentName);
  if (!result.claimed) throw new TaskError("claim_conflict", `already claimed by ${result.holderAgent}`);

  const now = new Date().toISOString();
  const updated: TaskRecord = { ...task, status: "in_progress", claimedAt: now, updatedAt: now };
  try {
    await writeTask(this.deps.paths, updated);
    await appendAudit(this.deps.paths, task.org, { ts: now, event: "claimed", by: caller.agentName, fromStatus: "pending", toStatus: "in_progress" });
    this.deps.hooks.emit("task:claimed", { record: updated });
    return updated;
  } catch (err) {
    // Roll back the lockfile so someone else can claim next time.
    await releaseClaim(this.deps.paths, task.org, task.id).catch(() => {});
    throw err;
  }
}
```

### Same-task serialization

Distinct callers on **different** tasks run in parallel. Concurrent mutations on the **same** task (e.g. `update()` racing against `complete()`) can interleave; we accept last-writer-wins on the JSON.

If audits show interleaving bugs in practice, add `AsyncLock` keyed by `(org, id)` around all service mutations — same pattern as `inboxLock`. **Flagged trade-off** — add only when we see a problem, don't pay the cost upfront.

### Fan-in / fan-out dependencies

- **Fan-in** (task with multiple blockers): `blockedBy: [A, B, C]` → can be claimed only when ALL are `completed`. AND-gate. Matches CortexOS.
- **Fan-out** (task that unblocks multiple dependents): `blocks: [X, Y, Z]` → completion emits a `task:completed` event; the stream source and UI refresh. In Phase 1 there is **no push** that wakes up X/Y/Z automatically — the orchestrator or the assignee polls via `rondel_task_list --assignee me --status pending` during heartbeat. (A future "task-ready" notification via `rondel_send_message` is a trivial listener on `task:completed`; deferred.)

### Cycle detection

Runs in `TaskService.create()` **before** the JSON file is written. The service:

1. Loads the peers named in `input.blockedBy`.
2. Rejects if any peer doesn't exist (`validation`).
3. Builds `peers: Map<id, {id, blockedBy}>`.
4. Calls `detectCycle(virtualTask, peers)`. If non-null, throws `TaskError("cycle_detected", ...)`.
5. Only then writes the JSON and updates each `blockedBy` peer's `blocks[]` array.

**Symmetric-edge update on create** — for each `b ∈ input.blockedBy`, we load peer `b`, append the new task's ID to `b.blocks`, write `b`. This is a multi-file write; failures partway through leave dangling edges. Mitigation: order operations as `validate → write new task → update peers → audit`; if a peer write fails, the new task is already created but its peer's `blocks[]` is inconsistent. CortexOS accepts this risk. For Rondel Phase 1 we do the same, document it, and flag a potential follow-up (transactional write via a write-ahead log in `state/tasks/{org}/.wal.jsonl`). **Flagged trade-off.**

---

## 5. MCP tool surface

All tools follow the existing `bridgePost`/`bridgeCall` pattern in `mcp-server.ts`. Each tool passes `callerAgent: PARENT_AGENT` at the boundary — same identity-forward convention as heartbeats. Org-scope is derived from caller identity at the bridge layer; no agent supplies its own org in tool input.

### `rondel_task_create`

Create a pending task. Any agent in the org can create; assignee must exist and be in the same org (admins excepted).

Input: `title`, `description`, `assignedTo`, `priority?` (default `normal`), `blockedBy?: string[]`, `dueDate?`, `externalAction?: boolean` (default false).

Returns: created `TaskRecord`.

Errors: `validation`, `unknown_agent` (assignee not in registry), `cross_org` (assignee in different org), `cycle_detected`, `not_found` (blockedBy peer missing).

### `rondel_task_claim`

Atomically claim a task assigned to the caller. Transitions `pending → in_progress`.

Input: `id`.

Returns: updated `TaskRecord`.

Errors: `not_found`, `forbidden` (task not assigned to caller and caller !== admin), `invalid_transition`, `blocked_by_open`, `claim_conflict`.

### `rondel_task_update`

Patch a task's free-text fields (`description`, `priority`, `dueDate`, `assignedTo`). Not allowed to flip status — use the dedicated tools. Reassigning triggers an audit entry and emits `task:updated`.

Input: `id`, partial fields.

Returns: updated `TaskRecord`.

Errors: `not_found`, `forbidden`, `cross_org`, `validation`.

### `rondel_task_complete`

Transition `in_progress → completed`. Requires `result`. Optional `outputs`.

If `task.externalAction === true`, the service opens an approval via `ApprovalService.requestToolUse({toolName: "rondel_task_complete", reason: "external_action", ...})`. The service does NOT await the approval synchronously (approvals already support the poll-via-requestId pattern) — it writes `approval_pending` into a transient state field and returns `{ status: "approval_pending", approvalRequestId }`. The caller polls or the web UI updates on `approval:resolved`. When the approval resolves allow → task flips to `completed`; deny → the task stays `in_progress`, event `task:updated` fires with a `blockedReason`.

For Phase 1, the approval-pending transient state is **in-memory only** on the service (one `Map<taskId, pendingApprovalId>`). On daemon restart, any pending approvals are auto-denied by the existing `ApprovalService.recoverPending()` and the task stays in `in_progress` — the agent re-requests completion on its next heartbeat. Documented, acceptable.

Input: `id`, `result`, `outputs?: TaskOutput[]`.

Returns: `{ status: "completed", record }` OR `{ status: "approval_pending", record, approvalRequestId }`.

### `rondel_task_block`

Transition any non-terminal status → `blocked`, capturing a reason. Releases the claim lockfile if held.

Input: `id`, `reason: string`.

Returns: updated `TaskRecord`.

### `rondel_task_cancel`

Terminal cancellation. Sets status to `cancelled`, writes `completedAt`, releases the claim lockfile, emits `task:cancelled`. Preserves the record (no delete).

Input: `id`, `reason?: string`.

Returns: updated `TaskRecord`.

### `rondel_task_list`

Query tasks in the caller's org. Admins can pass `org?` to cross.

Input (optional filters): `assignee`, `status`, `priority`, `includeCompleted?: boolean` (default false), `staleOnly?: boolean` (default false).

Returns: `TaskRecord[]` ordered by `orderTasks()` — unblocked first, priority desc, createdAt asc.

### `rondel_task_get`

Read one task by id (with audit log if requested).

Input: `id`, `includeAudit?: boolean`.

Returns: `{ record, audit?: TaskAuditEntry[] }`.

### Privilege summary

| Tool                    | Who can call                                       |
|-------------------------|----------------------------------------------------|
| `rondel_task_create`    | Any agent; assignee must be same-org               |
| `rondel_task_claim`     | Agent must be the assignee (or admin)              |
| `rondel_task_update`    | `createdBy`, `assignedTo`, or admin                |
| `rondel_task_complete`  | `assignedTo` or admin                              |
| `rondel_task_block`     | `assignedTo` or admin                              |
| `rondel_task_cancel`    | `createdBy`, `assignedTo`, or admin                |
| `rondel_task_list`      | Any agent (filtered to same-org; admins pass org)  |
| `rondel_task_get`       | Any agent (filtered to same-org; admins cross)     |

No dedicated "orchestrator-only" tool in Phase 1. When the orchestrator role ships (kickoff §4), a `rondel_task_dispatch_many` batched variant can be added — pure sugar over `create` + `rondel_send_message`.

---

## 6. Bridge endpoints

All endpoints live in `bridge.ts` alongside `/heartbeats/*`. Matching route-order discipline (specific literal paths before regex-matched ones, SSE tail before CRUD).

| Method | Path                            | Handler                  | Notes |
|--------|---------------------------------|--------------------------|-------|
| GET    | `/tasks/tail`                   | `handleTaskTail`         | SSE; optional `?org=<name>` filter. Must match before the regex routes. |
| GET    | `/tasks/:org`                   | `handleListTasks`        | Query params: `assignee`, `status`, `priority`, `includeCompleted`, `staleOnly`, `callerAgent`, `isAdmin` |
| GET    | `/tasks/:org/:id`               | `handleGetTask`          | `?includeAudit=true` includes the audit log |
| POST   | `/tasks/create`                 | `handleCreateTask`       | Body: `TaskCreateInputSchema` including `callerAgent` |
| POST   | `/tasks/:id/claim`              | `handleClaimTask`        | Body: `{ callerAgent }` |
| POST   | `/tasks/:id/update`             | `handleUpdateTask`       | Body: `TaskUpdateInputSchema` |
| POST   | `/tasks/:id/complete`           | `handleCompleteTask`     | Body: `TaskCompleteInputSchema`; response includes `approvalRequestId` if gated |
| POST   | `/tasks/:id/block`              | `handleBlockTask`        | Body: `{ callerAgent, reason }` |
| POST   | `/tasks/:id/unblock`            | `handleUnblockTask`      | Body: `{ callerAgent }` |
| POST   | `/tasks/:id/cancel`             | `handleCancelTask`       | Body: `{ callerAgent, reason? }` |

Identity: `callerFromTaskParams(params)` and `callerFromTaskBody(body)` — same shape as `callerFromHeartbeatParams`. Same forgeable-identity `TODO(security)` comment as heartbeats/schedules carries today.

Error mapping: `mapTaskError` mirrors `mapHeartbeatError`. `claim_conflict` → 409; `cycle_detected`, `blocked_by_open`, `invalid_transition` → 409; `validation` → 400; `not_found` → 404; `forbidden`, `cross_org` → 403; `approval_pending` is a 200 with `status: "approval_pending"` (not an error).

Note on POST shapes: `:id` is preferred over query params because a few of these are idempotent-enough to retry on transient network failure and `POST /tasks/:id/claim` makes that clearer than `POST /tasks/claim?id=...`.

---

## 7. Stream source

`apps/daemon/src/streams/task-stream.ts` — snapshot + delta, structurally identical to `HeartbeatStreamSource`.

### Wire format

```ts
export type TaskFrameData =
  | { kind: "snapshot"; entries: readonly TaskRecord[] }     // carries the full set of non-completed tasks in scope at connect time
  | { kind: "delta"; entry: TaskRecord; event: TaskAuditEvent };

// SSE event names (stable wire tags):
//   task.snapshot
//   task.delta
```

Snapshot includes all tasks where `status !== "completed"` and `status !== "cancelled"` (terminal tasks are backfilled on demand via the `includeCompleted=true` list endpoint).

### Filtering

`handleSseRequest` takes a per-client filter closure. The stream source stays scope-agnostic. The handler applies `?org=<name>` by filtering the `TaskRecord[]` on send.

### Wiring

Subscribes in the constructor to: `task:created`, `task:claimed`, `task:updated`, `task:blocked`, `task:completed`, `task:cancelled`. Each emits a delta frame. Disposes on shutdown.

**Not** subscribed to: `task:stale` — that's a ledger-fan-out concern, not a delta on the board (the board already shows the task; the UI reclassifies staleness client-side based on `updatedAt`).

### `asyncSnapshot`

Mirrors heartbeats' async-snapshot escape hatch — the bridge handler calls `taskStream.asyncSnapshot({org})` in its `replay` callback because reading the tasks directory is async.

---

## 8. Ledger events

Seven new `LedgerEventKind` values added to `ledger-types.ts`:

- `task_created`     — summary: `"Created task <title> for <assignee>"`, detail: `{taskId, assignedTo, priority, blockedBy}`
- `task_claimed`     — summary: `"Claimed task <title>"`, detail: `{taskId, claimedAt}`
- `task_updated`     — summary: `"Updated task <title>: <changedFields>"`, detail: `{taskId, patch}`
- `task_blocked`     — summary: `"Blocked task <title>: <reason>"`, detail: `{taskId, reason}`
- `task_completed`   — summary: `"Completed task <title>: <truncatedResult>"`, detail: `{taskId, durationMs, outputs}`
- `task_cancelled`   — summary: `"Cancelled task <title>: <reason?>"`, detail: `{taskId, reason}`
- `task_stale`       — summary: `"Task <title> is stale (<classification>)"`, detail: `{taskId, staleness}`

All are emitted via hook → `LedgerWriter` listener. The writer already owns truncation + summary discipline (see `ledger-writer.ts`); we add a `task_*` block there.

Heartbeat skill emits `task:stale` directly by calling `taskService.findStale(now)` during its discipline turn — the stale event is hook-emitted on each found task. This is the only non-service origin of a `task:*` hook.

**API version bump** — because `LEDGER_EVENT_KINDS` is a wire enum and the web package has to add matching schema entries in `apps/web/lib/bridge/schemas.ts` in the same commit per CLAUDE.md's parity rule. Bump once for the whole task surface.

---

## 9. Approval integration

The task module does **not** import approvals for any reason other than `TaskServiceDeps.approvals?` — optional, injected. If the dep is omitted, tasks with `externalAction: true` are rejected at `create()` with a `validation` error ("approvals not configured"). Keeps the domains decoupled.

### Flow when `task.externalAction === true`

1. Agent calls `rondel_task_complete` with result + outputs.
2. Service validates caller + transition; does NOT flip status yet.
3. Service calls `approvals.requestToolUse({agentName, toolName: "rondel_task_complete", toolInput: {taskId, result, outputs}, reason: "external_action"})`.
4. Approval is persisted + fanned out (existing mechanism).
5. Service stores `(taskId → approvalRequestId)` in an in-memory map; returns `{status: "approval_pending", approvalRequestId, record}`.
6. Service subscribes to `approval:resolved` once (at construction), and when a resolution arrives for a tracked task ID:
   - `decision === "allow"` → write task with `status: "completed"`, `completedAt`, `result`, `outputs`; append audit; emit `task:completed`.
   - `decision === "deny"` → write task with `status: "in_progress"` (unchanged) + `blockedReason: "completion denied by ${resolvedBy}"`; emit `task:blocked`.
7. Remove from the in-memory map.

### Approval reason

We need a new `ApprovalReason` value: `"external_action"`. It's added to the canonical source at `shared/safety/types.ts` — one-line change + a matching entry on the Zod enum in `bridge/schemas.ts`. This also bumps `BRIDGE_API_VERSION` per the rules (new enum value).

### What the existing `approvals/` domain does NOT change

Zero. No schema additions, no new endpoints, no coupling in reverse. Approvals remains completely unaware of tasks — it just sees a `toolName: "rondel_task_complete"` approval like any other tool escalation.

---

## 10. Staleness model

### Thresholds (hardcoded, single source of truth in `task-dag.ts`)

- `in_progress` — stale after **2h** since `claimedAt`.
- `pending` — stale after **24h** since `createdAt`.
- `blocked` — **unblockable-stale** iff every id in `blockedBy` is `completed` for >1h (meaning nothing's picking it back up).
- Any non-terminal task past its `dueDate` — **overdue**, independent of the above.

### Where it runs

Inside the `rondel-heartbeat` skill's discipline turn — the skill calls `rondel_task_list --staleOnly` via the service's `findStale()` path. Any results surface in the heartbeat's `notes`/`currentTask` fields and (for orchestrators) become a morning-review briefing item. No separate cron, no separate sweep.

### What it emits

For every task classified as stale, the service emits `task:stale` once per heartbeat turn. The ledger writer truncates + records. If the same task is still stale on the next heartbeat, the event fires again — stale events are informational, not deduplicated. (If this proves noisy, we add an `acknowledgedStaleAt` field in Phase 2 and suppress repeats; deferred because we don't know yet what the noise will look like.)

### What it does NOT do in Phase 1

- **Does not auto-cancel or reassign.** Those are orchestrator-skill decisions, not service-level automation.
- **Does not wake up idle agents.** CortexOS has daemon-level gap detection that injects prompts; Rondel relies on the 4h heartbeat cron catching the stale state on the next turn.

---

## 11. Framework skill — `rondel-task-management/SKILL.md`

Prose-first skill. Injected via `--add-dir` at spawn time, like every other framework skill. Rough outline (final text to be drafted during implementation):

**Discipline (five rules)**:

1. **Create before work.** Any unit of work >10min gets a task record first. The orchestrator sees it; the user sees it; the audit log gets it. If you're doing something small enough not to deserve a task, it's small enough not to deserve a mention.
2. **Claim atomically.** Don't edit a task's status directly — call `rondel_task_claim`. If someone beat you to it, the tool tells you who. Don't fight over it; message them or pick another task.
3. **Block with reason.** If you hit a wall, `rondel_task_block` with a concrete reason. "Waiting on clarification from the user." "External API returning 500s, retrying in an hour." Not "stuck." The reason becomes searchable context for the orchestrator and for future-you.
4. **Complete with result and deliverables.** When you're done, `rondel_task_complete` with a ≤200-word summary of what shipped and a list of output files. If you produced nothing durable, state that — completion is a claim; results are evidence.
5. **Respect the DAG.** `blockedBy` means do not start. Check with `rondel_task_list --assignee me --status pending` at every heartbeat to see what's available. If you need to unblock yourself, block your own task and message the upstream assignee.

**Decision tree — task vs message vs subagent**:

- **Subagent** (`rondel_spawn_subagent`): the model needs an isolated context to go research/analyze something and return an answer to this conversation. Ephemeral, one caller, <1h, non-persistent.
- **Message** (`rondel_send_message`): a teammate owns a piece of context you need a reply on. "Is X ready?" "Can you check Y?" Lightweight Q&A. No persistence beyond the reply.
- **Task** (`rondel_task_*`): a persistent unit of work, usually >10min, possibly multi-agent, always auditable. "Ship this." "Analyze and produce a report at path P by Friday."

Skills also documents privileged operations (cancel, cross-org admin reads) and the `externalAction` gate.

---

## 12. Relationship to `rondel_send_message` and subagents

Already summarized in §11; the table below makes it crisp:

| Dimension            | Subagent                        | Message                          | Task                                           |
|----------------------|---------------------------------|----------------------------------|------------------------------------------------|
| Persistent           | No                              | No (reply returns and closes)    | Yes                                            |
| Claimable by N       | No — fixed parent               | N/A                              | Yes — any same-org agent if re-assigned        |
| Dependencies         | No                              | No                               | Yes — `blockedBy[]`                            |
| Survives restart     | No (in-memory result, 1h TTL)   | Yes (inbox on disk)              | Yes (JSON file)                                |
| Audit                | Ledger events only              | Ledger events only               | Dedicated JSONL audit log per task             |
| Deliverables         | Returned as one text blob       | None                             | Structured `outputs[]`                         |
| Approval-gated       | No                              | No                               | Yes (when `externalAction === true`)           |
| Who sees it          | Parent + subagent               | Sender + recipient               | Entire org                                     |
| When to use          | "research + report back"        | "quick question + answer"        | "do this, ship it, track it"                   |

Rule of thumb: if you'd put it on a Jira board, it's a task. If you'd Slack someone, it's a message. If you'd open a new chat window to summon help, it's a subagent.

---

## 13. Testing strategy

Follows `docs/TESTING.md` taxonomy and matches the test coverage already present for heartbeats.

### Unit (`task-dag.unit.test.ts`)

No filesystem, no mocks. Pure data in, pure data out.

- **Cycle detection**: empty graph, self-loop (A→A), two-cycle (A→B→A), three-cycle (A→B→C→A), non-cyclic DAG (N nodes, random edges), virtual task that completes a cycle, unknown peer id (treated as leaf).
- **Blocked-by resolution**: single blocker completed → unblocked, single blocker pending → open, mixed (2 completed + 1 pending), missing peer → counted as open.
- **Staleness classification**: pending <24h → fresh, pending >24h → stale_pending, in_progress <2h → fresh, in_progress >2h → stale_in_progress, dueDate past → overdue regardless of status, blocked with all blockers completed >1h → blocked_unblockable.
- **Ordering**: priority sort stability, createdAt tiebreaker, unblocked-before-blocked.

### Integration — store (`task-store.integration.test.ts`)

Filesystem fixtures, no network. Uses `mkdtempSync` like the approval-store tests.

- **Atomic claim race**: spawn N concurrent `tryClaim(id, agentI)` calls → exactly one returns `{claimed: true}`, rest get `{claimed: false, holderAgent}`.
- **Idempotent claim**: same agent re-claiming returns `{claimed: true}`.
- **Lockfile roll-back**: `releaseClaim` after a failed write; next claim succeeds.
- **Audit append**: N concurrent audits on the same task → all lines present, no tearing (JSONL guarantees via `appendFile`).
- **Corrupt task file**: manual corruption → read returns `undefined` + logs; next write overwrites cleanly.
- **ID traversal**: `tryClaim(..., "../../etc/passwd")` rejects via regex before any path is derived.
- **Malformed audit line**: one bad line in a JSONL file is skipped; good lines parse.

### Integration — service (`task-service.integration.test.ts`)

Full service wired against real store + real hooks + real `OrgLookup`. Uses `mkdtempSync`.

- **Lifecycle**: create → claim → complete → audit log contains all three entries in order.
- **DAG**: create A; create B with `blockedBy: [A]` → peer A.blocks contains B; try to claim B while A pending → `blocked_by_open`; complete A → claim B succeeds.
- **Cycle rejection**: create A depending on non-existent B → `not_found`; create A, create B depending on A, try to update A to depend on B → `cycle_detected`.
- **List ordering**: seed 5 tasks, verify `orderTasks` result matches expected unblocked-first / priority-desc / createdAt-asc.
- **Stale detection**: seed 3 in-progress tasks with varying claimedAt; `findStale(now)` returns only those past 2h.
- **Hook fan-out**: register listeners on all 7 `task:*` events; run a full lifecycle; verify each event fires exactly once with the expected payload.
- **Agent deletion**: delete agent X; all tasks assigned to X transition to `cancelled` with reason `"assignee removed"`.

### Integration — edges (`task-service.edge.integration.test.ts`)

- **Cross-org**: agent in org A reads/writes a task in org B → `cross_org`; admin succeeds.
- **Forbidden**: non-assignee tries to claim → `forbidden`; update by random caller → `forbidden`.
- **Unknown agent**: `callerAgent` is a typo → `unknown_agent`.
- **Approval-gated complete**:
  - `externalAction: true` + complete → returns `approval_pending`, task still `in_progress`, approval record in pending.
  - Approval allowed → task transitions to `completed`, `task:completed` fires.
  - Approval denied → task stays `in_progress` with `blockedReason`, `task:blocked` fires.
  - Daemon restart while pending → approval auto-denies, task `blockedReason` set on next service action (test via manual call; documented as known edge).

### Stream source (`task-stream.unit.test.ts`)

Matches `heartbeat-stream.unit.test.ts`:

- Subscribe → unsubscribe leaves no listeners on hooks.
- Multiple clients receive the same delta; one throwing sender doesn't block the others.
- `asyncSnapshot` includes non-terminal tasks only.

### E2E scenario (one scripted integration test, long)

Orchestrator creates task X assigned to specialist S → ledger sees `task_created` → S claims → S completes → ledger sees `task_claimed` + `task_completed` → heartbeat skill-side `findStale` returns empty. Sanity check that all layers compose.

---

## 14. Migration

No existing install breakage — tasks are a new domain with a new `state/tasks/` directory.

### Startup

`index.ts` wiring, matching the heartbeats pattern:

```ts
const taskPaths: TaskPaths = { rootDir: join(stateDir, "tasks") };
const taskService = new TaskService({
  paths: taskPaths,
  hooks,
  orgLookup,
  isKnownAgent: agentManager.isKnown.bind(agentManager),
  approvals: approvalService,
  log,
});
await taskService.init();               // mkdir state/tasks/
const taskStream = new TaskStreamSource(hooks);
// bridge constructor gains taskService + taskStream params, same shape as heartbeats
```

### State-file policy

Per CLAUDE.md's state-file rule: `state/tasks/{org}/task_*.json` + `audit/*.jsonl` + `.claims/*.claim` documented in ARCHITECTURE.md with retention "grows forever for now; archival + compaction deferred to Phase 2." Implementation PR must update ARCHITECTURE.md in the same commit.

### `agent.json`

No change. Task-related defaults (e.g. "enforce task-before-work ≥10min") live in the framework skill prompt, not in config.

### BRIDGE_API_VERSION

Bump from 15 → 16. History entry:

> 16 — Task board domain: `rondel_task_*` MCP tools, `POST/GET /tasks/*` endpoints, `GET /tasks/tail` SSE, 7 new ledger kinds (`task_created`, `task_claimed`, `task_updated`, `task_blocked`, `task_completed`, `task_cancelled`, `task_stale`), new `ApprovalReason` enum value `external_action`.

Matching `apps/web/lib/bridge/schemas.ts` + `WEB_REQUIRES_API_VERSION` in the same commit (CLAUDE.md parity rule).

---

## 15. Engineering sequence

Build inside the domain folder top-down:

1. **Types + schemas** — `shared/types/tasks.ts` + `bridge/schemas.ts` additions. No runtime behavior.
2. **`task-dag.ts` (pure) + unit tests** — the full DAG module with tests passing before any I/O code exists.
3. **`task-store.ts` + integration tests** — including the atomic-claim race test. Unblocks everything downstream.
4. **`task-service.ts` + integration tests** — CRUD paths, lifecycle. Approval integration stubbed out initially, wired in once the happy path works.
5. **Hooks + ledger writer wiring** — add the 7 event cases to `hooks.ts` and `LedgerWriter.wireHooks`. Bump `BRIDGE_API_VERSION`.
6. **Bridge endpoints + handler tests** — GET first (read-only, safest), then POST.
7. **MCP tools in `mcp-server.ts`** — thin adapters.
8. **Stream source + web schema mirror + web UI snippet** — the board is useless without a place to see it. Even a trivial Next.js route reading the snapshot is enough.
9. **Framework skill** — `rondel-task-management/SKILL.md`. Last because the skill text references tool names and contracts that must now be stable.

Each step ships with its tests. Each commit leaves the system runnable.

---

## 16. Open questions

Deliberately flagged for iteration — not design commitments.

1. **Fan-in semantics**: AND-gate only? Or should Phase 1 support `anyOf` dependencies (complete when ANY blocker completes)? Punting to AND-only; flag if this shows up as a repeated ask.
2. **Cross-org dispatch**: CortexOS allows it. Rondel is strict everywhere else. Does the orchestrator role change the calculus? Probably: `rondel_find_orchestrator` returns the org's orchestrator, and cross-org tasking would need an approval gate. Revisit in the orchestrator kickoff.
3. **Re-assignment rules**: is `rondel_task_update` changing `assignedTo` enough, or do we want a dedicated `rondel_task_reassign` that emits a distinct event and requires the new assignee to acknowledge? Phase 1: just update + audit; revisit.
4. **Archival + compaction**: CortexOS archives at 7d, compacts monthly. When does Rondel? Defer until one of: (a) the tasks directory is noticeably large, or (b) the dashboard starts slowing down. Not a day-one concern.
5. **Repeat `task:stale` firing**: every heartbeat on a still-stale task re-fires the event. Noisy? Silent? Add dedup via `acknowledgedStaleAt`? Ship simple, adjust if it's annoying.
6. **Approval-pending persistence**: in-memory only today. If a restart mid-approval happens frequently, we'd promote the `taskId → approvalRequestId` mapping to disk. Waiting for data.
7. **Deliverable discipline**: should `rondel_task_complete` refuse to complete without an `outputs` array for non-trivial tasks? CortexOS has a `require_deliverables` flag. Skip for Phase 1; revisit once we have examples of "claimed complete with nothing to show."
8. **Per-task serialization**: add `AsyncLock` keyed by `(org, id)` now or wait for a bug? Waiting — the claim is the only truly contested path and O_EXCL handles it. Flag if integration tests start exposing interleave races.
9. **Symmetric-edge integrity on create failure**: should we introduce a WAL or accept eventual-consistency? CortexOS accepts it. Ship the same; monitor.
10. **"Task-ready" push on unblock**: should completing task A post a notification (`rondel_send_message`) to the assignees of everyone in `A.blocks[]`? Trivial listener on `task:completed`. Candidate for Phase 1.5 once the heartbeat + task foundation is stable — don't bundle into Phase 1 unless the first week of usage screams for it.
