# Phase 1 — Heartbeat Design

> **Status:** working draft for review. Implementation does **not** start from this doc — it's iterated on first.
> **Scope:** the Phase 1 heartbeat capability only. Everything above it (tasks, goals, reviews) is out of scope here but referenced where it constrains the design.
> **Sources consulted:** CortexOS `src/bus/heartbeat.ts` + `templates/orchestrator/HEARTBEAT.md` + `src/daemon/fast-checker.ts`, OpenClaw `src/infra/heartbeat-*.ts` family. See §14.

---

## 1. Scope

### In
- A per-agent liveness record on disk at `state/heartbeats/{agentName}.json` (one file, mutable, fully overwritten on each update).
- An MCP tool `rondel_heartbeat_update` the agent calls during its discipline turn.
- An MCP tool `rondel_heartbeat_read_all` callable by admin agents (later: orchestrators) to see the fleet.
- A bridge endpoint `GET /heartbeats/:org` for the web UI.
- A live SSE stream source so the fleet grid updates without polling.
- One framework skill `rondel-heartbeat` — the discipline checklist the agent runs every 4 hours.
- One new default cron entry scaffolded into the agent template's `agent.json` (`every: 4h`, triggers the skill).
- A shared staleness helper (`classifyHealth(record, nowMs)` → `"healthy" | "stale" | "down"`).

### Out (explicitly deferred)
- **Orchestrator role** — read-all is admin-only for now; the skill is written so it degrades cleanly when the orchestrator role lands.
- **Reactive `heartbeat:stale` emission** — staleness is computed at read time only; no background sweep emits "X is stale" events. The existing `schedule:overdue` watchdog already catches missed cron fires; adding a second watchdog is premature.
- **OpenClaw-style phase-offset scheduling, wake-queue coalescing, active-hours, event-triggered wakes** — sophisticated but not load-bearing at our current scale (single-digit agents). Revisit when it hurts.
- **CortexOS `day`/`night` `mode` field** — unused by any downstream consumer in CortexOS. Skipping unless a concrete need appears.
- **CortexOS `[watchdog] alive` fast-checker fallback** — CortexOS needs it because its REPL-based architecture goes silent when idle. Rondel's scheduler runs on real daemon timers, so if the daemon is up, the heartbeat cron fires. The existing `ScheduleWatchdog` (→ `schedule:overdue` hook) is the backstop we already have.
- **Live-session injection (firing into the agent's main conversation)** — see §10. Proposal is to fire as an isolated one-shot, not `--resume` into a user-facing session.
- **Retention / pruning of heartbeat records** — the file is one-per-agent and gets overwritten in place; no growth problem. Deleting an agent deletes its heartbeat file (§13).

---

## 2. Data model

### On-disk layout
```
state/
└── heartbeats/
    └── {agentName}.json     # one file per agent, mutable, atomic writes
```

Rationale: mirrors `state/ledger/{agentName}.jsonl` and `state/inboxes/{agentName}.json` — one-file-per-agent is the house pattern. No per-org subdirectory: an agent's record is agent-scoped; the *org* information lives inside the record and is used for filtering at read time. This matches how `state/ledger/` works today.

### Record schema

```ts
// apps/daemon/src/shared/types/heartbeats.ts

export interface HeartbeatRecord {
  readonly agent: string;           // agentName
  readonly org: string;             // owning org, or "global" if none
  readonly status: string;          // short free-form ("in flow on ingestion rewrite")
  readonly currentTask?: string;    // one-line summary of what the agent is working on
  readonly updatedAt: string;       // ISO 8601 — the only timestamp
  readonly intervalMs: number;      // the cron interval when this was written; helps consumers compute "expected next"
  readonly notes?: string;          // optional longer note the agent chose to leave
}
```

### Zod schema (boundary)

```ts
// apps/daemon/src/bridge/schemas.ts  (added alongside ApprovalRecordSchema)

export const HeartbeatRecordSchema = z.object({
  agent: z.string().min(1),
  org: z.string().min(1),
  status: z.string().max(500),
  currentTask: z.string().max(500).optional(),
  updatedAt: z.string().datetime(),
  intervalMs: z.number().int().positive(),
  notes: z.string().max(2000).optional(),
});
```

### Mutability
- **Mutable, single-file.** Every `update()` overwrites the whole file atomically. No append-only history — that's the ledger's job (see §7 on `heartbeat_updated` events carrying the status summary).

### Atomicity
- Reuse `shared/atomic-file.ts#atomicWriteFile` (temp-file + rename). Same primitive the approval store, schedule store, queue store, and inbox all use.

### Staleness tiers (shared helper)
```ts
const HEALTHY_THRESHOLD_MS = 5 * 60 * 60 * 1000;    // 5h
const DOWN_THRESHOLD_MS    = 24 * 60 * 60 * 1000;   // 24h

export type HealthStatus = "healthy" | "stale" | "down";

export function classifyHealth(record: HeartbeatRecord, nowMs: number): HealthStatus;
export function classifyHealthFromAge(ageMs: number): HealthStatus;
```

Exactly one place owns the thresholds. The bridge, stream, and MCP `read_all` tool all call `classifyHealth`. CortexOS's mistake was scattering `300 min` / `1440 min` / `10 min` across four files — we don't repeat it.

---

## 3. Module layout

```
apps/daemon/src/heartbeats/
├── index.ts                             # barrel: exports service, store paths, classify helpers, types
├── heartbeat-store.ts                   # pure file I/O (read, write, list, remove)
├── heartbeat-service.ts                 # business logic (update, readAll, findStale, classifyHealth, hooks)
├── heartbeat-service.unit.test.ts       # pure-logic tests (classifyHealth, findStale)
├── heartbeat-service.integration.test.ts # disk + hook wiring
└── heartbeat-store.integration.test.ts  # disk I/O

apps/daemon/src/shared/types/heartbeats.ts   # HeartbeatRecord type + HealthStatus

apps/daemon/src/streams/heartbeat-stream.ts   # StreamSource<HeartbeatFrameData>
apps/daemon/src/streams/heartbeat-stream.unit.test.ts

apps/daemon/templates/framework-skills/.claude/skills/rondel-heartbeat/SKILL.md  # the discipline checklist
```

### Store boundary (public API)
```ts
// heartbeat-store.ts
export interface HeartbeatPaths { readonly dir: string; }

export async function writeHeartbeat(paths, record): Promise<void>;
export async function readHeartbeat(paths, agent): Promise<HeartbeatRecord | undefined>;
export async function listHeartbeats(paths, log?): Promise<HeartbeatRecord[]>;
export async function removeHeartbeat(paths, agent): Promise<void>;
```

Rules identical to `approval-store.ts`: validate agent name against a strict regex (no path traversal), `atomicWriteFile` for every write, Zod-parse on read with malformed records logged + skipped (not thrown), missing directory treated as empty list.

### Service boundary (public API)
```ts
// heartbeat-service.ts
export interface HeartbeatServiceDeps {
  readonly paths: HeartbeatPaths;
  readonly hooks: RondelHooks;
  readonly orgLookup: OrgLookup;           // reuse shared/org-isolation.ts
  readonly isKnownAgent: (name: string) => boolean;  // reject writes for unknown agents
  readonly log: Logger;
}

export class HeartbeatService {
  async init(): Promise<void>;             // mkdir -p state/heartbeats
  async update(caller: HeartbeatCaller, input: HeartbeatUpdateInput): Promise<HeartbeatRecord>;
  async readAll(caller: HeartbeatCaller, opts?: { org?: string }): Promise<HeartbeatReadAllResult>;
  async readOne(caller: HeartbeatCaller, agent: string): Promise<HeartbeatRecord | undefined>;
  findStale(records: readonly HeartbeatRecord[], nowMs: number): HeartbeatRecord[];  // pure
  async removeForAgent(agent: string): Promise<void>;   // admin-delete hook
}
```

`HeartbeatCaller` mirrors `ScheduleCaller` (§see `scheduling/schedule-service.ts` lines 42–49) — `{agentName, isAdmin}`, populated at the bridge boundary from MCP env vars. Same known caveat about forgeability we accept elsewhere.

### Barrel (`index.ts`)
Exports `HeartbeatService`, `HeartbeatServiceDeps`, `HeartbeatPaths`, `classifyHealth`, type re-exports. Nothing else leaks. Mirrors `approvals/index.ts`.

---

## 4. MCP tool surface

Two tools, both registered by `apps/daemon/src/bridge/mcp-server.ts` alongside the existing `rondel_*` suite.

### `rondel_heartbeat_update`
- **Who**: any agent (self-write only). No target-agent field.
- **Input**:
  ```ts
  {
    status: string;          // required, max 500 chars
    currentTask?: string;    // optional, max 500 chars
    notes?: string;          // optional, max 2000 chars
  }
  ```
- **Output**: `{ ok: true, updatedAt: string }`.
- **Behavior**: writes/overwrites `state/heartbeats/{caller}.json`. Emits `heartbeat:updated` hook. Rejects unknown-agent callers with a clear error.

### `rondel_heartbeat_read_all`
- **Who**: admin agents today. When `role: "orchestrator"` lands (Phase 1 item §4 of the plan), the gate becomes `isAdmin || role === "orchestrator"`. Designed so the widening is a one-line change.
- **Input**: `{ org?: string; includeStale?: boolean }`. Non-admin callers may only target their own org (enforced via `checkOrgIsolation`). If `org` is omitted, defaults to the caller's org.
- **Output**:
  ```ts
  {
    records: Array<HeartbeatRecord & { health: "healthy" | "stale" | "down"; ageMs: number }>;
    missing: string[];   // agents in scope with NO heartbeat file at all
    summary: { healthy: number; stale: number; down: number; missing: number };
  }
  ```
- **Behavior**: server-side shapes the response to minimize agent reasoning work. Agents get a structured answer they can act on directly, not a pile of JSON they have to re-classify.

### Privilege level summary
| Tool                         | Self  | Same org admin | Cross-org admin | Non-admin cross-org |
|-----------------------------|-------|----------------|-----------------|---------------------|
| `rondel_heartbeat_update`   | ✅    | —              | —               | ❌                  |
| `rondel_heartbeat_read_all` | —     | ✅             | ❌              | ❌                  |

(Same pattern as `rondel_schedule_*`.)

Both tool descriptions go in the MCP server's tool registration (framework space), not in any user-editable file. Descriptions state "call this from the `rondel-heartbeat` skill" so the LLM knows the linkage.

---

## 5. Bridge endpoints

Added to `apps/daemon/src/bridge/bridge.ts`:

| Method | Path                          | Handler                                     | Notes                                          |
|--------|-------------------------------|---------------------------------------------|-----------------------------------------------|
| GET    | `/heartbeats/:org`            | `listForOrg(org)` → structured shape        | Same response shape as MCP `read_all`. Public to the web UI; loopback-gated via the existing middleware. |
| GET    | `/heartbeats/:org/:agent`     | `readOne(agent)`                            | Single-record fetch for the agent detail page.|
| GET    | `/heartbeats/tail`            | SSE handler wired to `HeartbeatStreamSource` | Snapshot + deltas. Optional `?org=` filter applied at the handler layer (not the source). |
| POST   | `/heartbeats/update`          | MCP bridge path (internal)                  | The MCP tool calls through the bridge the same way `rondel_schedule_*` does. |

Zod schemas for request params / response shapes live in `bridge/schemas.ts` alongside the existing `ScheduleSummarySchema`, `ApprovalRecordSchema`, etc. Follow the naming convention already established there.

**Consumers**:
- Web UI fleet grid subscribes to `/heartbeats/tail?org={org}`.
- Web UI single-agent page fetches `/heartbeats/{org}/{agent}` on load and then subscribes to `/heartbeats/tail` filtered to that agent.
- Future orchestrator fleet-health skill uses `rondel_heartbeat_read_all` (MCP, not HTTP).

---

## 6. Stream source

`apps/daemon/src/streams/heartbeat-stream.ts`, modelled on `agent-state-stream.ts` (§snapshot + delta, not append-only).

### Wire format
```ts
type HeartbeatFrameData =
  | { readonly kind: "snapshot"; readonly entries: readonly HeartbeatRecordWithHealth[] }
  | { readonly kind: "delta";    readonly entry: HeartbeatRecordWithHealth };

type HeartbeatRecordWithHealth = HeartbeatRecord & { health: HealthStatus; ageMs: number };
```

Event tags: `heartbeat.snapshot`, `heartbeat.delta` — stable strings the web reducer keys on.

### Source wiring
- `snapshot()` → reads all records from disk, classifies, returns. Used by `handleSseRequest` once per new client.
- `subscribe()` → attaches a listener to `hooks.on("heartbeat:updated", ...)`. On each event, compute `ageMs` + `health` **at emit time** and push a `delta` frame to all clients.
- `dispose()` → unsubscribe, drop clients.

### Health re-computation
The critical subtlety: a record that was `healthy` at write time can become `stale` purely by clock advancing. The stream emits deltas on writes only, so a client that connected three hours ago won't automatically see the transition to `stale`. Two options:

- **A (simplest):** clients re-classify locally using `updatedAt` + `Date.now()`. The stream carries only the record + `ageMs` at emit time; the web reducer runs a 60s interval that re-classifies existing entries. No server-side ticker.
- **B:** the source runs a 1-minute interval that scans records and pushes `delta` frames for any whose `health` changed since last tick.

**Proposal**: A. Keeps the daemon side stateless and the server-side subscription model pure. Same reasoning CortexOS's dashboard uses (client computes `getHealthStatus` from the timestamp). `ageMs` is carried on the wire mostly as a convenience for the snapshot's initial paint — the reducer doesn't treat it as authoritative after N seconds.

---

## 7. Ledger events

### New `LedgerEventKind`s
Added to `apps/daemon/src/ledger/ledger-types.ts`:

```ts
  | "heartbeat_updated"
  // `heartbeat_stale` deferred — no consumer in Phase 1.
```

Keep the addition minimal. We can always add `heartbeat_stale` later when Phase 1 §3 orchestrator fleet-health needs a push-style signal; for now pull (orchestrator runs `rondel_heartbeat_read_all`) is fine.

### New hook event
Added to `apps/daemon/src/shared/hooks.ts`:

```ts
export interface HeartbeatUpdatedEvent {
  readonly record: HeartbeatRecord;
}

// wired in HookEvents:
"heartbeat:updated": [event: HeartbeatUpdatedEvent];
```

### Ledger-writer wiring
In `ledger-writer.ts#wireHooks`:

```ts
hooks.on("heartbeat:updated", ({ record }) => {
  this.append({
    ts: this.now(),
    agent: record.agent,
    kind: "heartbeat_updated",
    summary: this.truncate(`beat: ${record.status}`, GENERAL_MAX),
    detail: {
      currentTask: record.currentTask,
      notes: record.notes,
      org: record.org,
    },
  });
});
```

**Consumed by:**
- Web UI activity feed (existing `/ledger/tail` stream — no code change required; new event kind renders with the same pattern).
- `HeartbeatStreamSource` (direct hook subscription — doesn't go through the ledger).
- Orchestrator's fleet-health skill (Phase 1 §4) via `rondel_ledger_query`.

---

## 8. Framework skill

### Path
`apps/daemon/templates/framework-skills/.claude/skills/rondel-heartbeat/SKILL.md`

Injected into every agent's tool surface at spawn time via `--add-dir` (the existing framework-skills mechanism). Never copied into user space.

### Content (proposed)

```markdown
---
name: rondel-heartbeat
description: "Run the 4-hour discipline cycle: check in, glance at your work, update your heartbeat. Invoked by the heartbeat cron."
---

# Heartbeat — your regular check-in

You're running the heartbeat cycle. This is a short discipline turn, not a task.
Be quick, be terse, and get back to work.

## What to do (in order)

1. **Sweep your inbox.** Call `rondel_list_inbox` (if you have pending messages). Answer anything urgent with `rondel_send_message`. Skip fluff.
2. **Note your current state.** What are you working on? What's your status in one line? Examples:
   - `"drafting the Q2 summary, blocked on metrics from analyst"`
   - `"idle — no tasks queued"`
   - `"in flow on the ingestion rewrite"`
3. **Update your heartbeat.** Call `rondel_heartbeat_update` with:
   - `status` — the one-liner from step 2
   - `currentTask` — one-line summary of the primary thing you're on (optional)
   - `notes` — anything worth a future-you reading (optional)
4. **Save anything worth remembering.** If you learned something useful since your last beat,
   call `rondel_memory_save`. Don't over-write — memory is for things that
   help you later, not a running journal.
5. **Stop.** Don't continue the conversation. The heartbeat cron has no auto-delivery
   — your output is captured to the ledger only. End with a two- or three-line summary
   (what you're on, anything flagged) and return.

## What NOT to do

- Don't send the user a status message unless you've been silent for a day AND you
  have something genuinely worth surfacing. The heartbeat is internal plumbing;
  the user has a dashboard.
- Don't make up work. If you're idle, say so. `status: "idle"` is a valid heartbeat.
- Don't call `rondel_send_telegram` — this is a cron run without auto-delivery.

## If you're unsure what to write

`status: "alive — standing by"` is acceptable when nothing is happening. The point
of the heartbeat is to *exist*, not to perform activity.
```

### Why this content shape
- Tight — CortexOS's 10-step checklist is doing too much. For Phase 1, steps 2, 4, 6 from CortexOS (sweep inbox, log event, write memory) cover the 80%.
- Framework space — framework-critical, never in user space. The user can't delete the skill without breaking the cycle.
- Prose, not code — skill behavior is tunable by editing the Markdown and running `rondel_reload_skills`.
- No mention of tasks or goals — those are Phase 1 items *after* heartbeat. The skill file is designed to grow gracefully: when task board ships (§Phase 1 §2), we add a step "glance at your task list"; when goals ship (§Phase 1 §3), we add "confirm your focus is still fresh."

---

## 9. Default cron installation

### Decision: scaffolded into the template, not auto-installed at runtime

Option A (chosen): add a heartbeat entry to `apps/daemon/templates/context/agent.json`. New agents created via `rondel add agent` get it by default. Existing agents need a manual edit (documented in the migration note, §13).

Option B (rejected): auto-install on daemon startup if missing. Too magical — fights the user-space invariant. `agent.json` is mostly user-owned; silently mutating it is worse than asking the user to add three lines on upgrade.

### Scaffolded entry

```json
{
  "crons": [
    {
      "id": "heartbeat",
      "name": "heartbeat",
      "schedule": { "kind": "every", "interval": "4h" },
      "prompt": "Run the rondel-heartbeat skill.",
      "sessionTarget": "isolated",
      "delivery": { "mode": "none" }
    }
  ]
}
```

- `sessionTarget: "isolated"` — ephemeral SubagentProcess per run. See §10.
- `delivery: { mode: "none" }` — heartbeats are silent. Output goes to the ledger via the existing cron-run path.
- `id: "heartbeat"` — fixed id so rehashing the config is stable across installs.
- `schedule.kind: "every"` — aligns with existing scheduler semantics (see `shared/types/scheduling.ts`).

### Edge case: user disables it
A user can set `enabled: false` or delete the entry entirely. That's their call — it's user space. The `rondel-heartbeat` skill stays available; they just won't get scheduled fires. Fleet health for that agent becomes `down` after 24h, which *is* the correct signal for "this agent is not participating in the discipline."

### Admin hot-add
`rondel_add_agent` flows through `config/admin-api.ts#scaffoldAgent` → it writes `agent.json` from the template. No code change needed if the template carries the cron entry.

---

## 10. Session resume — isolated vs live session

> This is the single most important trade-off. Flagging explicitly for your decision.

### The existing cron execution model
- `sessionTarget: "isolated"` → `CronRunner.runIsolated` spawns a `SubagentProcess` with a fresh system prompt in `cron` mode (persistent-mode sections stripped, preamble prepended). No prior context. Finishes, exits.
- `sessionTarget: "session:heartbeat"` → `CronRunner.getOrSpawnNamedSession` gets-or-spawns an `AgentProcess` keyed `{agentName}:internal:cron:heartbeat`. Persistent process, context accumulates across runs. NOT the same process as the user's Telegram conversation — separate conversation key, separate session.
- **"Fire into the user's main session"** → NOT a current primitive. The main conversation is keyed `{agentName}:telegram:{chatId}`. Sending a message into that process means contending with the live user for the one-writer-per-conversation invariant (`CLAUDE.md` non-negotiable) and mixing cron content into the user-facing transcript.

### Options on the table

#### Option A — Isolated (PROPOSED for Phase 1)
- Fresh context every 4h. Prompt is assembled in `cron` mode → strips USER.md, MEMORY.md, BOOTSTRAP.md; prepends the cron preamble.
- Agent reads MEMORY.md at prompt-build-time (the shared-context injection still applies). Enough context to act.
- The heartbeat skill calls `rondel_memory_read` / `rondel_ledger_query` / `rondel_heartbeat_read` if it needs more state.
- **Cheap.** Every run starts clean, no token accumulation.
- **Easy to reason about.** No session drift, no `/new` needed.

#### Option B — Named session (`session:heartbeat`)
- Context accumulates: "last beat I noted X, now Y changed."
- Eventually blows up on token limits — needs manual `/new` or compaction.
- More continuity but at real token cost, and continuity for a **discipline** turn is mostly noise.

#### Option C — Fire into the user's main conversation via `--resume`
- Would require new `ConversationManager` primitives to inject a cron-triggered turn into a user-facing conversation.
- Violates the one-writer invariant unless it waits for idle, which means "heartbeat fires whenever the user isn't around" — nondeterministic.
- Mixes cron output into the user's transcript.
- **Not worth the complexity for Phase 1.** Revisit if we ever want the heartbeat to be *conversational* with the user.

### Proposal
**Option A (isolated).** The heartbeat's job is to produce a JSON record + a ledger summary, not to converse. MEMORY.md injection at prompt-build-time gives the agent the state it needs; the record it writes is its outward signal.

### What we lose
- The agent won't "remember" its last heartbeat beyond what's in MEMORY.md + the heartbeat record itself. That's fine — the heartbeat is deliberately short-memory.
- No continuity of in-heartbeat reasoning across beats. Also fine.

### Escape hatch
If a user hits a case where they want continuity (e.g., "compare to yesterday's" rhythms), they change `sessionTarget` to `"session:heartbeat"` in their `agent.json`. The scheduler already supports both. No daemon code change.

---

## 11. Staleness thresholds

### Defaults
- **Healthy**: age ≤ 5h
- **Stale**: 5h < age ≤ 24h
- **Down**: age > 24h
- **Missing**: no heartbeat file at all (separate bucket; not a health tier)

### Where the constants live
In `heartbeats/heartbeat-service.ts` exported as named constants so tests can reference them. The classification function `classifyHealth` is the sole consumer; nothing else touches the numbers.

### Configuration
Not configurable in Phase 1. Hardcoded constants. If a user wants different thresholds, we add a `HEARTBEAT_HEALTHY_MS` / `HEARTBEAT_DOWN_MS` env override later — not worth building the config plumbing until someone asks.

### Rationale for 5h against a 4h cron
- A single missed fire pushes the record past 5h → `stale`. That's exactly the signal we want. Tighter threshold (e.g. 6h) would hide one-miss cases; looser (e.g. 8h) means we notice two misses late.
- 5h stale + 24h down matches CortexOS's tuning, which they arrived at empirically. No reason to invent new numbers.

---

## 12. Testing strategy

Conforms to `docs/TESTING.md` taxonomy.

### Unit (pure, zero I/O)
- `heartbeat-service.unit.test.ts`:
  - `classifyHealth` — all threshold boundaries, exactly-on-threshold, far-past, zero-age.
  - `findStale` — filters records crossing the stale threshold, ignores those still healthy, empty input.
  - `classifyHealthFromAge` — negative age (clock skew), zero, exactly 5h, exactly 24h.

### Integration (disk, hooks, with mocks for network)
- `heartbeat-store.integration.test.ts`:
  - write → read round-trip.
  - atomic overwrite (concurrent writes don't corrupt).
  - malformed JSON on disk → skipped with a warn, not thrown.
  - missing directory → empty list.
  - unknown agent in path → regex rejection.
- `heartbeat-service.integration.test.ts`:
  - `update()` writes the file AND emits `heartbeat:updated`.
  - `readAll()` returns records + health classification + missing agents.
  - `readAll()` with `org` filter restricts scope.
  - Cross-org read by non-admin → rejected.
  - `removeForAgent()` cleans the file (called from agent-delete admin flow).
- `heartbeat-stream.unit.test.ts`:
  - Snapshot + delta sequencing.
  - Listener cleanup on dispose.
  - Stale client unsubscribe doesn't break the fan-out.

### Contract (schema parity between daemon and web)
- Existing `bridge/schemas.unit.test.ts` pattern — ensure `HeartbeatRecordSchema` round-trips through `safeParse`.

### End-to-end (deferred)
- A full e2e (cron fires → skill runs → heartbeat file lands → SSE delta reaches a subscribed client) is valuable but expensive. Stand it up once the skill has been dogfooded for a week — not a blocker for first implementation.

---

## 13. Migration

### New installs
- `rondel init` scaffolds the agent template with the heartbeat cron. No action.
- `state/heartbeats/` is created by `HeartbeatService.init()` on daemon start (`mkdir -p`, idempotent).

### Existing installs
- Daemon startup: `HeartbeatService.init()` creates `state/heartbeats/` if missing. No-op otherwise.
- Existing `agent.json` files **won't have the heartbeat cron**. Two paths:
  1. User adds it manually. README snippet documents the three-line addition.
  2. A follow-up `rondel doctor` (out of scope here) could offer to add it. Not required for first ship.
- No data migration — the heartbeat record is created on first call to `rondel_heartbeat_update`. Until then, the agent's bucket in the fleet view is `missing`.

### Agent deletion
- `admin-api.ts#deleteAgent` currently purges schedules, transcripts, sessions, etc. Add a call to `heartbeatService.removeForAgent(name)` in that sequence, following the existing pattern for schedule purge.

### Rollback
- Disable the cron in `agent.json` → heartbeat stops firing. Record file stays on disk until deleted.
- Remove the heartbeats domain → no dependencies on it from outside its own module. Bridge endpoint 404s, stream source has no subscribers. Clean unwind.

---

## 14. Open questions

Flagging every non-trivial trade-off I made. Please decide before implementation starts.

| # | Question | My recommendation | Why |
|---|----------|-------------------|-----|
| 1 | **Per-agent vs per-conversation heartbeats.** The plan says per-agent. A multi-user Telegram bot has N conversations; they share one agent and one heartbeat. | **Per-agent.** | Heartbeat is an agent-level discipline, not a conversation-level fact. Per-conversation heartbeats explode the state dir for no Phase 1 win. |
| 2 | **`mode: day/night` field.** | **Skip.** | Unused in CortexOS. Add only when a consumer exists. |
| 3 | **Reactive `heartbeat:stale` ledger event.** | **Skip for Phase 1.** | Orchestrator is the only foreseeable consumer and it's pull-style. Revisit with orchestrator implementation. |
| 4 | **Watchdog.** Do we need a second watchdog on top of the existing `ScheduleWatchdog`? | **No.** | `schedule:overdue` already detects missed cron fires. Stale-record detection is the agent compliance problem, not a cron problem. |
| 5 | **ACL for `read_all`: admin-only vs orchestrator-only vs admin-or-orchestrator.** Orchestrator role doesn't exist yet. | **Admin-only now; widen when orchestrator ships.** | One-line change later. |
| 6 | **Session target: isolated vs named session.** | **Isolated.** See §10. | Cheapest + simplest + aligned with the "small JSON record" design. |
| 7 | **Staleness thresholds: 5h/24h vs different.** | **5h/24h.** | Tuned to a 4h cron; matches CortexOS empirical tuning. |
| 8 | **Auto-install for existing installs.** | **No, manual edit.** | User-space invariant. A `rondel doctor` command can automate later. |
| 9 | **Heartbeat output auto-delivered to a chat?** The cron can be set to `delivery: announce` and the agent's final text would go to the user. | **No, `delivery: none`.** | Heartbeat is background plumbing. User-facing surface is the web UI fleet grid. |
| 10 | **Should the skill write to `MEMORY.md` every beat, or only when something changed?** | **Only when something changed.** Skill explicitly says "don't over-write." | CortexOS writes a daily memory snapshot each beat — becomes noise fast. |
| 11 | **Agent-authored `currentTask` string vs deriving from task board.** Once Phase 1 §2 ships, `currentTask` is either (a) what the agent writes in its heartbeat call, or (b) computed from "highest-priority `in_progress` task assigned to this agent." | **Agent-authored in Phase 1.** | Task board doesn't exist yet. When it ships, we can deprecate the field in favor of server-side derivation, or keep both as cross-checks. |
| 12 | **`notes` field — bound on length + retention.** Max 2000 chars, overwritten every beat. No history. | **OK as proposed.** | Accept the trade-off; ledger carries history. |

---

## 15. What implementation gets (a one-page summary)

**New domain module** at `apps/daemon/src/heartbeats/` with:
- Store (`writeHeartbeat`, `readHeartbeat`, `listHeartbeats`, `removeHeartbeat`) — atomic file I/O.
- Service (`update`, `readAll`, `readOne`, `findStale`, `removeForAgent`) — hooks emission, org-isolation, admin gating.
- Pure helpers (`classifyHealth`, constants `HEALTHY_THRESHOLD_MS`, `DOWN_THRESHOLD_MS`).

**One shared type file** at `apps/daemon/src/shared/types/heartbeats.ts` — `HeartbeatRecord`, `HealthStatus`.

**One stream source** at `apps/daemon/src/streams/heartbeat-stream.ts` — snapshot + delta, client-side re-classification.

**Two MCP tools** in `apps/daemon/src/bridge/mcp-server.ts` — `rondel_heartbeat_update` (self-write), `rondel_heartbeat_read_all` (admin-scoped, org-filtered).

**Three bridge endpoints** in `apps/daemon/src/bridge/bridge.ts` — `GET /heartbeats/:org`, `GET /heartbeats/:org/:agent`, `GET /heartbeats/tail` (SSE).

**One framework skill** at `apps/daemon/templates/framework-skills/.claude/skills/rondel-heartbeat/SKILL.md` — the five-step discipline checklist.

**One template change** in `apps/daemon/templates/context/agent.json` — default `heartbeat` cron (`every: 4h`, `isolated`, `delivery: none`).

**One new hook event** in `apps/daemon/src/shared/hooks.ts` — `heartbeat:updated`, carrying the record.

**One new ledger event kind** in `apps/daemon/src/ledger/ledger-types.ts` — `heartbeat_updated`.

**Zero touches on the scheduler**. The scheduler already handles what we need.

**Zero touches on the prompt pipeline**. Cron-mode prompt assembly already supports this.

**Zero touches on the bridge's existing shape**. New endpoints slot into the existing `/x/:id` pattern.

---

## 16. Appendix — source research summaries

Full research reports (OpenClaw + CortexOS) available on request. Key takeaways that shaped this design:

**From CortexOS** — adopted:
- Atomic single-file-per-agent record (`state/heartbeats/{agent}.json`).
- Auto-emit a ledger event on each heartbeat write (presence signal doubles as activity).
- Staleness tiers (5h/24h), empirically tuned to human cycles.
- Centralize thresholds in one place (CortexOS's mistake was scattering them).

**From CortexOS** — rejected:
- 10-step discipline checklist (too heavy for Phase 1; pared to 5).
- `day`/`night` `mode` field (unused).
- `fast-checker` 50-min watchdog via `execFile` (our scheduler runs real timers; existing `ScheduleWatchdog` covers the gap).
- Writing a daily memory file every beat (noise).

**From OpenClaw** — adopted in spirit only:
- Runs on the existing scheduler primitive (OpenClaw has 12 heartbeat-* files; we have one service + store).

**From OpenClaw** — rejected for Phase 1 (revisit later):
- Phase-based deterministic scheduling (sha256 offset per agent). Matters at 50+ agents; we're at 1–5.
- Wake-queue coalescing with priority. Premature.
- Active-hours / quiet-hours gating. Premature.
- Event-triggered wakes (exec completion → heartbeat). Premature.
- OpenClaw's sprawling `src/infra/heartbeat-*.ts` module family (12 files). Our target is 2 files.
