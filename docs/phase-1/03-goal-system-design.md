# Phase 1 — Goal System Design

> Spec for the `apps/daemon/src/goals/` domain. Draft — edit freely before
> implementation.
>
> Reference kickoff: [`03-goal-system-kickoff.md`](./03-goal-system-kickoff.md).
> Companion designs (same contract, heartbeat already shipped, tasks in flight):
> [`01-heartbeat-design.md`](./01-heartbeat-design.md),
> [`02-task-board-design.md`](./02-task-board-design.md).
> External research: CortexOS `templates/orchestrator/goals.json`,
> `src/bus/system.ts:checkGoalStaleness()`, and the `goal-management` /
> `morning-review` skills (the full-fidelity reference — Rondel takes the
> ideas, not the code). OpenClaw has no goal system; its `HEARTBEAT.md`
> "standing instructions" pattern informed the "inject once, not queried
> per turn" propagation decision.

---

## 1. Scope

### In

- A two-level objectives store per organization — **org-level** (north-star
  + daily-focus) and **per-agent** (focus + 2–5 goals + bottleneck).
- Machine-readable JSON as source of truth; a rendered `GOALS.md`
  informational mirror in the agent workspace.
- A new **pure prompt section** `buildGoals(...)` that injects the agent's
  daily focus + org north-star into the system prompt on every `main`-mode
  turn — no runtime tool pull.
- MCP tools for set + read: `rondel_goals_set_north_star`,
  `rondel_goals_set_daily_focus`, `rondel_goals_set_agent_goals`,
  `rondel_goals_get`.
- Bridge read endpoints (`GET /goals/:org`, `GET /goals/:org/:agent`,
  `GET /goals/tail` for SSE) plus matching POST surface for mutation.
- Stream source for live dashboard updates (mirrors `HeartbeatStreamSource`).
- Staleness classification callable from inside the heartbeat skill. **No
  new cron.**
- Hook events for ledger fan-out: `goals:north_star_set`,
  `goals:daily_focus_set`, `goals:agent_set`, `goals:stale`.
- Org-scoped hard isolation (admins cross, everyone else can't) matching
  heartbeats + tasks.
- Write-authority gate: `setNorthStar`, `setDailyFocus`, `setAgentGoals`
  are admin-today, widening to `admin || role === "orchestrator"` when
  the orchestrator role lands. `getGoals` is universally available (org
  + same-org-peer visibility).

### Out (explicitly deferred)

- **OKR / progress tracking.** CortexOS has a `progress: 0-100` field
  per goal. We defer — Phase 1 goals are plain strings; progress is
  narrated in heartbeat notes and surfaced via tasks. Revisit when we
  have a pattern for what "progress" even means.
- **Multi-horizon goals.** No quarterly / weekly layer between
  north-star and daily-focus. One stable long-term, one daily. Add layers
  only when the daily grain proves insufficient.
- **KPI measurement / metric linkage.** Goals are prose. No
  `target_metric`, no numerical checks, no trend graphs. Same deferral
  as task board's `kpi_key`.
- **Full user-edit reconciliation.** Phase 1 detects user edits to
  `GOALS.md` (mtime-based) and warns the orchestrator; it does **not**
  parse the Markdown back to JSON. See §3 for the trade-off and §16 for
  the Phase 2 upgrade path.
- **Goal history / archival.** Overwrite in place; the ledger carries
  history. No per-day snapshots of "yesterday's focus." Defer.
- **Cross-org goal cascade.** Each org's goals are its own. No shared
  north-stars. Matches our org-isolation discipline everywhere else.
- **Automatic goal → task generation.** The orchestrator's morning-review
  skill creates tasks in a *separate step* using `rondel_task_create`.
  No implicit linkage in the data model. Revisit if the coupling proves
  painful.
- **Agent self-write.** An agent cannot mutate its own goals via MCP in
  Phase 1. It *proposes* changes via `rondel_send_message` to the
  orchestrator, which decides. Deliberate — keeps the cascade
  unambiguous.
- **Approvals integration.** Goal-setting doesn't touch external systems
  or spend money. No `externalAction`-style gate.

---

## 2. Data model

### On-disk layout

```
~/.rondel/state/
  goals/
    {org}/                              ← one directory per org; "global" for unaffiliated
      goals.json                        ← org-level record (north-star + daily-focus)
      agents/
        {agentName}.json                ← per-agent record (focus + goals + bottleneck)

~/.rondel/workspaces/
  {org}/
    agents/
      {agentName}/
        GOALS.md                        ← auto-rendered view (user-readable; edits warned, not parsed)
```

**Two-location split is deliberate.** The authoritative JSON lives in
framework-owned `state/`, where the user can't accidentally `rm -rf`
it. The rendered Markdown lives in user-owned `workspaces/` alongside
`AGENT.md`, `IDENTITY.md`, `MEMORY.md` — same shelf as everything else
the user reads. The prompt section reads the **JSON** via the service,
not the Markdown file. GOALS.md is not load-bearing.

**"Global" org** — unaffiliated agents use `state/goals/global/`. Same
rule as heartbeats + tasks.

**Per-agent file name** is the agent name, not a generated ID. Agents
don't have IDs separate from their names, and every other per-agent
state file (`state/heartbeats/{name}.json`, `state/inboxes/{name}.json`)
uses the name directly. Name-validation regex applies on every path
derivation (identical to `approval-store.ts` defence-in-depth).

### OrgGoals schema

```ts
// apps/daemon/src/shared/types/goals.ts

export interface OrgGoals {
  readonly version: 1;              // schema version; future-proofs migrations
  readonly org: string;              // owning org, or "global"
  readonly northStar: string;        // long-term mission; rarely changes; ≤1000 chars; may be ""
  readonly northStarSetAt?: string;  // ISO 8601; absent until first set
  readonly dailyFocus: string;       // today's priority; ≤1000 chars; may be ""
  readonly dailyFocusSetAt?: string; // ISO 8601; absent until first set
  readonly dailyFocusSetBy?: string; // agent name who wrote it (usually the orchestrator)
  readonly updatedAt: string;        // ISO 8601; bumped on every mutation
}
```

### AgentGoals schema

```ts
export interface AgentGoals {
  readonly version: 1;
  readonly org: string;
  readonly agent: string;           // agent name (matches file stem)
  readonly focus: string;           // role-matched daily focus; ≤500 chars; may be ""
  readonly goals: readonly string[]; // 2-5 concrete objectives; each ≤300 chars
  readonly bottleneck?: string;     // current blocker as free text; ≤500 chars
  readonly updatedBy: string;       // agent name that wrote it (usually the orchestrator)
  readonly updatedAt: string;       // ISO 8601
}
```

### Field rationale

- **`version: 1`** — same discipline as `TaskRecord`. Store refuses
  records with `version !== 1`; skipped + logged, identical to task
  store's quarantine.
- **Separate `*SetAt` + `updatedAt`** — `northStarSetAt` and
  `dailyFocusSetAt` are *content-change* timestamps, driven by the
  staleness rule. `updatedAt` is a *file-change* timestamp that
  captures any mutation (adding `bottleneck`, re-rendering, etc.).
  Keeping them separate means changing the bottleneck doesn't reset
  the staleness clock on the daily focus. CortexOS conflates these
  and gets it wrong; we split.
- **`dailyFocus` / `focus` / `goals[]` may be empty strings / empty
  arrays** — the schema allows "goals not set yet" (new install, new
  agent). The prompt section silently omits the block if everything
  is empty. No `null` vs `""` ceremony.
- **`goals[]` is bounded 2–5 items (enforced at the service, not in
  the type)** — CortexOS allows unbounded goals and the prompts get
  noisy. Service rejects `< 2` and `> 5` with a `validation` error.
  **Flagged trade-off** — the cap is intentionally tight; loosen only
  with evidence.
- **No `progress` field on goals** — deferred (§1 Out). Goals are
  strings.
- **`updatedBy`** — who wrote this record. Essential for the "did the
  orchestrator cascade, or did an admin intervene?" audit question.
  Mirrors `createdBy` on tasks.

### Zod schemas (boundary)

One canonical schema per type in `bridge/schemas.ts`; the store validates
every file it reads through it. Shapes:

- `OrgGoalsSchema`, `AgentGoalsSchema` — match the TS types exactly;
  validate on every store read.
- `SetNorthStarInputSchema`, `SetDailyFocusInputSchema`,
  `SetAgentGoalsInputSchema`, `GetGoalsInputSchema` — HTTP/MCP
  boundary shapes, each with `callerAgent` for identity (same
  forgeable-identity caveat approvals + heartbeats + tasks carry).
- `OrgGoalsResponseSchema`, `AgentGoalsResponseSchema`,
  `GoalsPairResponseSchema` (org + agent combo) — wire shapes.

**BRIDGE_API_VERSION bump 16 → 17** — goals add new MCP tools, new HTTP
endpoints, and four new ledger kinds. One bump for the whole domain;
matching entries land in `apps/web/lib/bridge/schemas.ts` +
`WEB_REQUIRES_API_VERSION` in the same commit per CLAUDE.md parity.

### Mutability

- Both JSON files: **mutable**, overwritten in place via
  `atomicWriteFile` (write-to-temp + rename). One file per
  (org) and (org, agent).
- `GOALS.md`: rewritten in full on every service write; never appended.
  Carries a generated-file header (see §3) so the user knows.
- No append-only audit log for Phase 1. The ledger is history.

### Staleness tiers (pure function, single source of truth)

```ts
// apps/daemon/src/goals/goal-staleness.ts

export const DAILY_FOCUS_STALE_MS = 24 * 60 * 60 * 1000; // 24h
export const AGENT_GOALS_STALE_MS = 24 * 60 * 60 * 1000; // 24h

export type GoalStaleness =
  | "fresh"
  | "daily_focus_stale"   // org.dailyFocusSetAt > 24h ago (or absent)
  | "agent_goals_stale"   // agent.updatedAt > 24h ago (or record absent)
  | "north_star_missing"; // onboarding state — org.northStar === ""

export interface StalenessReport {
  readonly org: string;
  readonly orgStaleness: readonly GoalStaleness[];
  readonly agents: ReadonlyMap<string, readonly GoalStaleness[]>; // per agent
}

export function classifyStaleness(
  org: OrgGoals | undefined,
  agents: ReadonlyMap<string, AgentGoals>,
  knownAgents: readonly string[],  // from the agent registry — catches "agent exists but has no goals file"
  nowMs: number,
): StalenessReport;
```

Pure. No I/O. Unit-testable without fixtures. The heartbeat skill calls
`goalService.checkStaleness(org, now)` which delegates to this.

---

## 3. Stored goals vs rendered `GOALS.md`

The key design question raised in the kickoff: **is `GOALS.md` machine-
generated, user-editable, or both?**

### Decision: **one-way rendering with edit detection, not bidirectional sync.**

- **Source of truth**: JSON in `state/goals/{org}/…`.
- **`GOALS.md` is a rendered view** written into the agent's workspace
  (`workspaces/{org}/agents/{name}/GOALS.md`) after every service-side
  mutation.
- **The prompt section reads the JSON**, not the Markdown. Goals reach
  agents via prompt injection of content rendered in-memory — the
  file is not on the critical path.
- **User edits to `GOALS.md` are detected, not parsed.** On every
  service read (e.g. morning-review skill), the service compares the
  file's `mtime` with the JSON's `updatedAt`. If the file is newer, a
  `goals:user_edit_detected` ledger event is emitted and the
  orchestrator's next cascade surfaces "I noticed you edited
  `GOALS.md` for agent X — want me to incorporate it?" in its briefing.
  The service does **not** auto-overwrite and does **not** auto-parse.

### Generated-file header

Every `GOALS.md` starts with:

```markdown
<!--
This file is regenerated from ~/.rondel/state/goals/{org}/agents/{name}.json
by the rondel_goals_* tools. Direct edits will be overwritten on the next
cascade. To change your goals, talk to your orchestrator (or edit via the
Rondel dashboard).
-->

# Goals — {agentName}

## North Star
{org.northStar}

## Today's Focus
{org.dailyFocus}

## Your Focus
{agent.focus}

## Your Goals
- {agent.goals[0]}
- {agent.goals[1]}
- ...

## Current Bottleneck
{agent.bottleneck || "none"}

## Updated
{agent.updatedAt}
```

### Why not bidirectional

- Parsing Markdown back into structured JSON is fragile (what's a
  real bullet vs a narrative sentence? What happens with nested
  lists? What if the user deleted the `## Your Goals` heading?).
  CortexOS doesn't do it either — they just regenerate and rely on
  orchestrator discipline.
- The user's escape hatch is the orchestrator, which *is* the
  editing UI. "Boss, change my focus to X" is one message away.
- For Phase 1, the mtime-warning gives us the "user-edit respect"
  promise from the kickoff without committing to a parser. **Flagged
  trade-off** — full bidirectional editing is a Phase 2 candidate
  when we know what shape user edits actually take.

### Regeneration triggers

- On every `setNorthStar`, `setDailyFocus`, `setAgentGoals` call, the
  service regenerates `GOALS.md` for every agent in scope:
  - `setNorthStar(org, text)` → regenerate **every** agent's
    `GOALS.md` in that org (the north star line changed for all).
  - `setDailyFocus(org, text)` → same (org-level change).
  - `setAgentGoals(org, agent, ...)` → regenerate just that
    agent's `GOALS.md`.
- Regeneration is a pure function (`renderGoalsMd(orgGoals,
  agentGoals)` from `goal-renderer.ts`) called by the service.
- Regeneration failures are logged and emit
  `goals:render_failed{org, agent, error}` but do **not** fail the
  underlying set call — the JSON is canonical, and the prompt
  section reads JSON. The Markdown mirror is best-effort.

---

## 4. Module layout

```
apps/daemon/src/goals/
├── index.ts                         ← barrel: exports GoalService, GoalError, pure helpers, types
├── goal-staleness.ts                ← PURE: classifyStaleness(), thresholds
├── goal-staleness.unit.test.ts
├── goal-renderer.ts                 ← PURE: renderGoalsMd() → Markdown string (used by service AND prompt section)
├── goal-renderer.unit.test.ts
├── goal-store.ts                    ← file I/O: read/write both JSONs + GOALS.md mirror
├── goal-store.integration.test.ts
├── goal-service.ts                  ← business logic: setNorthStar/setDailyFocus/setAgentGoals/get/checkStaleness
├── goal-service.integration.test.ts
└── goal-service.edge.integration.test.ts   ← cross-org, forbidden, user-edit detection

apps/daemon/src/shared/types/goals.ts       ← pure types, zero runtime imports

apps/daemon/src/config/prompt/sections/goals.ts         ← NEW pure section builder
apps/daemon/src/config/prompt/sections/goals.unit.test.ts

apps/daemon/src/streams/goal-stream.ts                  ← SSE snapshot + delta, mirrors heartbeat-stream.ts
apps/daemon/src/streams/goal-stream.unit.test.ts
```

External consumers import from `../goals` (barrel). Internal files import
each other directly. Cross-domain types in `shared/types/goals.ts` —
matches heartbeats + tasks.

The prompt section is the only consumer outside `goals/` that touches
the renderer directly — it imports `renderGoalsInlineSection` from
`goals/goal-renderer.ts` so the format is shared with `GOALS.md` files.
See §5.

### `goal-staleness.ts` (pure, no I/O)

```ts
export const DAILY_FOCUS_STALE_MS = 24 * 60 * 60 * 1000;
export const AGENT_GOALS_STALE_MS = 24 * 60 * 60 * 1000;

export function classifyStaleness(
  org: OrgGoals | undefined,
  agents: ReadonlyMap<string, AgentGoals>,
  knownAgents: readonly string[],
  nowMs: number,
): StalenessReport;
```

Unit-testable. No dependencies.

### `goal-renderer.ts` (pure, no I/O)

```ts
export function renderGoalsMd(org: OrgGoals, agent: AgentGoals | undefined): string;

// Section used by the prompt builder — compact variant that omits the
// generated-file header and the explanatory scaffolding. Same data,
// tighter shape, so we don't bloat every turn's context.
export function renderGoalsPromptSection(
  org: OrgGoals | undefined,
  agent: AgentGoals | undefined,
): string | null;  // returns null if nothing to render
```

Two rendering modes, one module. Both pure. The service calls
`renderGoalsMd` to write `GOALS.md`; the prompt section calls
`renderGoalsPromptSection` for prompt assembly.

### `goal-store.ts` (file I/O only)

```ts
export interface GoalPaths {
  readonly stateRootDir: string;      // state/goals/
  readonly workspacesRootDir: string; // workspaces/ (for GOALS.md mirror)
}

// Reads — return undefined for missing records (logged + skipped; same
// discipline as approval-store).
export async function readOrgGoals(paths: GoalPaths, org: string, log?: Logger): Promise<OrgGoals | undefined>;
export async function readAgentGoals(paths: GoalPaths, org: string, agent: string, log?: Logger): Promise<AgentGoals | undefined>;
export async function listAgentGoals(paths: GoalPaths, org: string, log?: Logger): Promise<AgentGoals[]>;

// Writes — atomic.
export async function writeOrgGoals(paths: GoalPaths, record: OrgGoals): Promise<void>;
export async function writeAgentGoals(paths: GoalPaths, record: AgentGoals): Promise<void>;

// GOALS.md mirror — best-effort; never blocks the JSON write.
export async function writeGoalsMdMirror(
  paths: GoalPaths, org: string, agent: string, content: string, log?: Logger,
): Promise<void>;

// User-edit detection — compare mtime of GOALS.md with JSON updatedAt.
export async function detectUserEdit(
  paths: GoalPaths, org: string, agent: string, jsonUpdatedAt: string, log?: Logger,
): Promise<{ userEdited: boolean; fileMtime?: string }>;

// Admin cleanup.
export async function removeAgentGoals(paths: GoalPaths, org: string, agent: string): Promise<void>;
```

Name + org regex-gated before any path derivation, identical to tasks and
approvals.

### `goal-service.ts` (business logic)

```ts
export interface GoalServiceDeps {
  readonly paths: GoalPaths;
  readonly hooks: RondelHooks;
  readonly orgLookup: OrgLookup;                       // shared/org-isolation
  readonly isKnownAgent: (agent: string) => boolean;
  readonly log: Logger;
}

export class GoalService {
  async init(): Promise<void>;                         // mkdir -p state/goals

  // Writes — admin-today, widens to orchestrator-or-admin.
  async setNorthStar(caller: GoalCaller, org: string, northStar: string): Promise<OrgGoals>;
  async setDailyFocus(caller: GoalCaller, org: string, dailyFocus: string): Promise<OrgGoals>;
  async setAgentGoals(caller: GoalCaller, org: string, agent: string, input: SetAgentGoalsInput): Promise<AgentGoals>;

  // Reads — universally available, org-scoped.
  async getOrgGoals(caller: GoalCaller, org: string): Promise<OrgGoals | undefined>;
  async getAgentGoals(caller: GoalCaller, org: string, agent: string): Promise<AgentGoals | undefined>;
  async getPair(caller: GoalCaller, org: string, agent: string): Promise<{ org?: OrgGoals; agent?: AgentGoals }>;
  async listAgents(caller: GoalCaller, org: string): Promise<AgentGoals[]>;

  // Staleness — called by heartbeat skill.
  async checkStaleness(caller: GoalCaller, org: string, nowMs: number): Promise<StalenessReport>;

  // Called by AdminApi on delete-agent: remove the agent's file + GOALS.md.
  async onAgentDeleted(agent: string, org: string): Promise<void>;

  // Called by AdminApi on delete-org: remove every goal file in the org.
  async onOrgDeleted(org: string): Promise<void>;
}
```

Caller context (same shape as `TaskCaller`, `HeartbeatCaller`):

```ts
export interface GoalCaller {
  readonly agentName: string;
  readonly isAdmin: boolean;
  // Forward-compat: when roles land, this enum widens.
  readonly role?: "orchestrator" | "specialist";
}
```

### Error type

```ts
export type GoalErrorCode =
  | "validation"        // empty fields where required, goals.length out of 2..5
  | "not_found"         // agent has no goals record yet
  | "unknown_agent"     // callerAgent or target agent not in registry
  | "forbidden"         // non-admin/non-orchestrator trying to set
  | "cross_org";        // agent target in a different org

export class GoalError extends Error {
  constructor(public readonly code: GoalErrorCode, message: string, public readonly details?: unknown) { super(message); }
}
```

Bridge maps: `not_found` → 404, `unknown_agent` → 404,
`forbidden`/`cross_org` → 403, `validation` → 400. Mirrors
`mapTaskError` / `mapHeartbeatError`.

### Write-authority gate (single source of truth)

One predicate inside the service:

```ts
private assertWriteAllowed(caller: GoalCaller): void {
  if (caller.isAdmin) return;
  if (caller.role === "orchestrator") return;   // forward-compat
  throw new GoalError("forbidden", "goal writes are admin- or orchestrator-only");
}
```

Called by `setNorthStar`, `setDailyFocus`, `setAgentGoals`. When the
orchestrator role lands (Phase 1 §4), the gate already respects it —
one line unchanged, one line added once roles exist. Identical
forward-compatibility pattern to the heartbeat design.

### Barrel

```ts
// apps/daemon/src/goals/index.ts
export { GoalService, GoalError, type GoalCaller, type GoalServiceDeps, type GoalErrorCode } from "./goal-service.js";
export { classifyStaleness, DAILY_FOCUS_STALE_MS, AGENT_GOALS_STALE_MS,
         type GoalStaleness, type StalenessReport } from "./goal-staleness.js";
export { renderGoalsMd, renderGoalsPromptSection } from "./goal-renderer.js";
export type { GoalPaths } from "./goal-store.js";
```

---

## 5. Prompt section integration

### New section file

`apps/daemon/src/config/prompt/sections/goals.ts`:

```ts
import type { Logger } from "../../../shared/logger.js";
import type { OrgGoals, AgentGoals } from "../../../shared/types/goals.js";
import { renderGoalsPromptSection } from "../../../goals/goal-renderer.js";

export interface GoalsInputs {
  readonly org?: OrgGoals;
  readonly agent?: AgentGoals;
  readonly isEphemeral: boolean;
}

/**
 * Inject the agent's daily focus + org north-star into the system prompt.
 * Returns null when no goals exist yet (new install) or when the mode
 * is ephemeral — goals are a main-mode concept.
 */
export function buildGoals({ org, agent, isEphemeral }: GoalsInputs): string | null {
  if (isEphemeral) return null;
  return renderGoalsPromptSection(org, agent);
}
```

Pure builder, same shape as `buildMemory`, `buildWorkspace`,
`buildIdentity`. Zero I/O. Fully unit-testable.

### Loader side — populating the inputs

`assemble.ts` takes new optional inputs on `PromptInputs`:

```ts
export interface PromptInputs {
  // ... existing fields ...
  readonly goals?: PromptGoalsContext;
}

export interface PromptGoalsContext {
  readonly org?: OrgGoals;
  readonly agent?: AgentGoals;
}
```

And `loadSharedInputs` picks them up:

```ts
async function loadSharedInputs(args: {
  agentDir: string;
  orgDir?: string;
  globalContextDir?: string;
  agentName?: string;
  orgName?: string;
  goalService?: GoalService;            // NEW optional dep
  log: Logger;
}): Promise<SharedLoadedInputs> {
  const [bootstrap, sharedContext, toolInvariants, goals] = await Promise.all([
    loadBootstrapFiles({ ... }),
    loadSharedContext({ ... }),
    buildToolInvariants(),
    args.goalService && args.orgName && args.agentName
      ? loadGoalsForPrompt(args.goalService, args.orgName, args.agentName, args.log)
      : Promise.resolve(undefined),
  ]);
  return { bootstrap, sharedContext, toolInvariants, goals };
}
```

`loadGoalsForPrompt` is a thin helper that calls
`goalService.getPair(systemCaller, org, agent)` and catches all errors
(returning `undefined` on any failure — goals must never block prompt
assembly). The `systemCaller` is a fixed internal identity, not a real
agent, same as how the session persister uses a synthetic caller today.

**Why reach into the service, not the store?** The service already
handles the "missing file" → `undefined` normalization and emits the
user-edit-detected event when appropriate. Skipping the service means
duplicating that logic inside the loader.

### Where the section slots in

```
Current Date & Time
Workspace
Runtime
Global CONTEXT.md           ← "who we are universally"
Org shared CONTEXT.md       ← "who we are in this org"
>>> Goals section           ← NEW — "what we're doing today"
AGENT.md                    ← personal identity
SOUL.md
IDENTITY.md
USER.md                     (persistent only)
MEMORY.md                   (persistent only)
BOOTSTRAP.md                (persistent only)
```

Rationale: Goals are org-scoped *today state*, a natural continuation
from org CONTEXT (org stable state). Placing them before AGENT.md means
the agent reads "who we are" → "what we're pushing today" → "who I am
personally" — the narrative flows inward. Also: goals change frequently,
AGENT.md / SOUL.md / IDENTITY.md rarely — putting the mutable block
above the stable ones avoids thrashing the prompt prefix cache for
user-owned bootstrap content. (The framework sections above shared
CONTEXT are fully stable across turns; the shared CONTEXTs are also
rarely-edited; goals are the first daily-mutable block.)

### Section output shape

```markdown
## Current Focus

**North Star**: {northStar}

**Today**: {dailyFocus}

**Your Focus**: {agent.focus}

**Your Goals**:
- {goals[0]}
- {goals[1]}
- ...

**Current Bottleneck**: {bottleneck}  ← omitted if empty
```

Tight — goals should be a *reminder*, not a replacement for IDENTITY.md
or the agent's personality. Hard cap: ~500 tokens in the worst case.

Fields are individually omitted when empty. If `org` and `agent` are
both undefined (new install), `buildGoals` returns `null` and the
section disappears — no placeholder, no "no goals yet" text.

### Mode handling

| Mode         | Goals section included? | Rationale |
|--------------|-------------------------|-----------|
| `main`       | **yes**                 | The default conversational turn; goals are load-bearing. |
| `cron`       | **no**                  | Ephemeral; current policy strips MEMORY / USER / BOOTSTRAP for the same reason (don't bloat one-shot spawns). Skills that need goals inside a cron (morning-review, heartbeat) pull them via `rondel_goals_get`. |
| `agent-mail` | **no**                  | Agent-to-agent reply flow; conversational mail doesn't need daily focus. Ephemeral-adjacent. |

Controlled via the existing `isEphemeralMode` predicate plus an explicit
`mode === "agent-mail"` check inside `buildGoals`. **Flagged trade-off**:
including `cron` would let every scheduled job "just know" the focus —
but it would also add ~500 tokens to every cron spawn, and most crons
don't care. Morning-review is the only cron that needs goals, and it's
set up to query anyway (it also *writes* them).

### Unit tests for the section

Same pattern as `sections/memory.unit.test.ts` and
`sections/workspace.unit.test.ts`:

- `buildGoals({isEphemeral: true})` → `null`.
- Empty inputs → `null`.
- Only `org.northStar` set (no daily focus, no agent record) → section
  shows just north-star.
- Full inputs → full section with every line.
- `bottleneck` empty → bottleneck line omitted.

---

## 6. MCP tool surface

All tools follow the existing `bridgePost` / `bridgeCall` pattern in
`mcp-server.ts`. Each tool passes `callerAgent: PARENT_AGENT` at the
boundary — same identity-forward convention as heartbeats + tasks.

### `rondel_goals_set_north_star`

Set the org's long-term mission.

- **Who**: admin today; `admin || role === "orchestrator"` when roles land.
- **Input**: `{ org?: string; northStar: string }` (org defaults to
  caller's org; admin may cross).
- **Output**: updated `OrgGoals`.
- **Side effects**: regenerates `GOALS.md` for **every** agent in that
  org (north-star line changes for all); emits `goals:north_star_set`.
- **Errors**: `forbidden`, `cross_org`, `validation` (empty string).

### `rondel_goals_set_daily_focus`

Set today's focus for the org.

- **Who**: admin / orchestrator.
- **Input**: `{ org?: string; dailyFocus: string }`.
- **Output**: updated `OrgGoals`.
- **Side effects**: sets `dailyFocusSetAt` to now, regenerates every
  agent's `GOALS.md`, emits `goals:daily_focus_set`.
- **Errors**: `forbidden`, `cross_org`, `validation`.

### `rondel_goals_set_agent_goals`

Set focus + goals + bottleneck for one agent.

- **Who**: admin / orchestrator.
- **Input**: `{ org?: string; agent: string; focus: string; goals: string[]; bottleneck?: string }`.
- **Output**: updated `AgentGoals`.
- **Side effects**: regenerates that agent's `GOALS.md` only, emits
  `goals:agent_set`.
- **Errors**: `forbidden`, `cross_org`, `unknown_agent` (target not in
  registry), `validation` (`goals.length` outside 2..5).

### `rondel_goals_get`

Read goals. Self-read or (for admin / orchestrator) peer-read in the
same org.

- **Who**: any agent.
- **Input**: `{ org?: string; agent?: string }` — both default to caller;
  non-admin caller may only target self OR an agent in the same org;
  cross-org requires admin.
- **Output**: `{ org?: OrgGoals; agent?: AgentGoals }` (either may be
  `undefined` if not set).
- **Errors**: `cross_org`, `unknown_agent`.

### Privilege summary

| Tool                               | Self read | Same-org peer read | Write (own) | Write (other) |
|------------------------------------|-----------|--------------------|-------------|---------------|
| `rondel_goals_get`                 | ✅        | ✅                 | n/a         | n/a           |
| `rondel_goals_set_north_star`      | n/a       | n/a                | admin/orch  | admin/orch    |
| `rondel_goals_set_daily_focus`     | n/a       | n/a                | admin/orch  | admin/orch    |
| `rondel_goals_set_agent_goals`     | n/a       | n/a                | admin/orch  | admin/orch    |

All tool descriptions live in framework space (the MCP tool registration),
not in user-editable files. Descriptions explicitly state "called from
the `rondel-goal-cascade` orchestrator skill" so the LLM understands
the intended usage. A specialist agent that tries to call a write tool
will see an error the first time and, per the description, stop trying.

---

## 7. Bridge endpoints

Live in `bridge.ts` alongside `/heartbeats/*` and `/tasks/*`. Route-order
discipline preserved: specific literals before regex matches; SSE tail
route before CRUD.

| Method | Path                                | Handler                     | Notes |
|--------|-------------------------------------|-----------------------------|-------|
| GET    | `/goals/tail`                       | `handleGoalsTail`           | SSE; optional `?org=<name>` filter. |
| GET    | `/goals/:org`                       | `handleGetOrgGoals`         | Returns `OrgGoals` or 404 |
| GET    | `/goals/:org/agents`                | `handleListAgentGoals`      | `AgentGoals[]` for the org |
| GET    | `/goals/:org/agents/:agent`         | `handleGetAgentGoals`       | Returns `AgentGoals` or 404 |
| GET    | `/goals/:org/pair/:agent`           | `handleGetGoalsPair`        | `{org, agent}` combo — used by the dashboard sidebar |
| POST   | `/goals/:org/north-star`            | `handleSetNorthStar`        | Body: `{ callerAgent, northStar }` |
| POST   | `/goals/:org/daily-focus`           | `handleSetDailyFocus`       | Body: `{ callerAgent, dailyFocus }` |
| POST   | `/goals/:org/agents/:agent`         | `handleSetAgentGoals`       | Body: `{ callerAgent, focus, goals, bottleneck? }` |

Identity: `callerFromGoalsParams(params)` and `callerFromGoalsBody(body)`
— same shape as task / heartbeat callers. Same forgeable-identity
caveat comment the other domains carry.

Error mapping: `mapGoalError` mirrors `mapTaskError` / `mapHeartbeatError`.
`validation` → 400, `forbidden`/`cross_org` → 403, `not_found`/
`unknown_agent` → 404.

---

## 8. Stream source

`apps/daemon/src/streams/goal-stream.ts` — snapshot + delta,
structurally identical to `HeartbeatStreamSource` and `TaskStreamSource`.

### Wire format

```ts
export type GoalFrameData =
  | { kind: "snapshot"; orgs: readonly { org: OrgGoals; agents: readonly AgentGoals[] }[] }
  | { kind: "org-delta"; record: OrgGoals }
  | { kind: "agent-delta"; record: AgentGoals }
  | { kind: "user-edit"; org: string; agent: string; fileMtime: string };

// SSE event names (stable wire tags):
//   goals.snapshot
//   goals.org_delta
//   goals.agent_delta
//   goals.user_edit
```

Snapshot includes the full goal state in scope at connect time (typically
one org).

### Filtering

`handleSseRequest` takes a per-client filter closure. The stream source
stays scope-agnostic; the handler applies `?org=<name>` by filtering on
send.

### Wiring

Subscribes in the constructor to: `goals:north_star_set`,
`goals:daily_focus_set`, `goals:agent_set`, `goals:user_edit_detected`.
Emits the matching delta. Disposes on shutdown.

### `asyncSnapshot`

Mirrors the heartbeat + task pattern — the bridge handler calls
`goalStream.asyncSnapshot({org})` in its `replay` callback because
reading the goals directory is async.

---

## 9. Ledger events

Four new `LedgerEventKind` values added to `ledger-types.ts`:

- `goals_north_star_set`  — summary: `"North-star set: <truncated>"`,
  detail: `{org, northStar, setBy}`
- `goals_daily_focus_set` — summary: `"Daily focus set: <truncated>"`,
  detail: `{org, dailyFocus, setBy}`
- `goals_agent_set`       — summary: `"Goals cascaded to <agent>"`,
  detail: `{org, agent, focus, goalCount, setBy}`
- `goals_stale`           — summary: `"Goals stale: <reason>"`, detail:
  `{org, agent?, reason}`

All emitted via hook → `LedgerWriter` listener. Ledger writer already
owns truncation + summary discipline (`ledger-writer.ts`); we add a
`goals_*` block there.

Heartbeat skill emits `goals:stale` directly by calling
`goalService.checkStaleness(now)` during its discipline turn — the stale
event is hook-emitted on each classification. Matches how the same skill
emits `task:stale`.

**`goals:user_edit_detected`** is emitted by the service on detection
but does **not** have a corresponding ledger kind — it's a stream-only
frame surfaced in the dashboard ("user edited GOALS.md, orchestrator
should reconcile"). Keeping it out of the ledger avoids log noise for
what is ultimately a UI hint. **Flagged trade-off** — promote to a
ledger kind if the orchestrator needs historical "when did the user
start editing by hand?" introspection.

**API version bump** — one bump (16 → 17) for the whole domain:
new MCP tools, new bridge routes, four new ledger kinds, matching web
schemas in the same commit per CLAUDE.md parity.

---

## 10. Staleness model

### Thresholds (hardcoded, single source of truth in `goal-staleness.ts`)

- **`daily_focus_stale`** — `org.dailyFocusSetAt` is absent OR > 24h
  old. ("Stale" means: it hasn't been set today.)
- **`agent_goals_stale`** — `agent.updatedAt` > 24h old (or the agent
  record is missing entirely and the agent is in the registry).
- **`north_star_missing`** — `org.northStar === ""` (onboarding state).
  Surfaces as a prompt for the orchestrator's first morning-review.

Why 24h and not "not-today-in-local-time"? Because Rondel doesn't track
per-org timezone yet, and "rolling 24h" is a close-enough approximation
without that infrastructure. **Flagged trade-off** — when the agent gets
a per-org timezone field (likely Phase 2), staleness flips to "set-at
is before today's 03:00 local" and the threshold goes away.

### Where it runs

Inside the `rondel-heartbeat` skill's discipline turn — the skill calls
`rondel_goals_get` via the service's `checkStaleness()` path. Any
results surface in the heartbeat's `notes` field (the specialist) or
become a morning-review briefing item (the orchestrator). No separate
cron, no separate sweep.

### What it emits

For every stale classification, the service emits one `goals:stale`
hook per call (bundled per report, not per agent — one event with the
full list of stale entries). The ledger writer truncates + records.
Repeat firings on still-stale state are expected — informational, not
deduplicated. Same discipline as `task:stale`.

### What it does NOT do in Phase 1

- **Does not auto-trigger a morning review.** That's an orchestrator-
  skill decision (the skill can choose to self-invoke if stale), not
  daemon-level automation.
- **Does not block agent turns.** A stale north-star doesn't
  short-circuit a conversation. The prompt section still renders,
  possibly with empty fields.
- **Does not email / notify the user.** The ledger is the notification.
  The dashboard surfaces it. Push-style alerting is a follow-up.

---

## 11. Cascade mechanics

### What "cascade" means operationally

The morning-review skill's goal-cascade step, in order (from the
kickoff and the CortexOS `morning-review` skill):

1. Read `org.goals.json` → know the north star and existing daily
   focus.
2. Ask the user (via channel): "What's today's focus?" — wait for
   reply (same synchronous main-mode turn discipline).
3. On reply, call `rondel_goals_set_daily_focus(org, text)`.
4. For each specialist in the org, call
   `rondel_goals_set_agent_goals(org, agent, focus, goals, bottleneck?)`
   with role-matched content.
5. Optionally notify each specialist via `rondel_send_message` ("new
   goals cascaded — check your next turn").

### Atomicity

**None, deliberately.** Each call is independent. If step 4 fails
partway (specialist 3 of 5 errors), the orchestrator sees the failure,
decides whether to retry or skip. The previous two writes stand.

Why not a transaction?
- The filesystem doesn't give us transactions.
- Writing a WAL for a multi-file write that's rare (once a day)
  is overkill.
- Partial failure is recoverable: re-run the cascade, or set the
  missing agent's goals directly. The blast radius is small.

**Flagged trade-off.** If partial-cascade-state causes real issues
(e.g., two agents working on yesterday's focus while three are on
today's), add a `goalsetBatchId` field + a `currentBatchId` pointer
on `OrgGoals`, and have the prompt section warn when the agent's
batch doesn't match. Phase 2.

### Cascade authorship

`setBy` / `updatedBy` fields on both records track who wrote them.
For cascade, it's always the orchestrator's name. For direct admin
intervention, it's the admin's name. This shows up in ledger details
and in the `GOALS.md` header.

### Anti-pattern we're NOT copying from CortexOS

CortexOS has the orchestrator shell out to bash + jq to write the
JSON files directly. We don't — our orchestrator calls
`rondel_goals_set_*` tools, which validate at the service, gate on
role, emit hooks, regenerate the mirror. Cleaner, auditable, testable.

---

## 12. User-edit semantics

Covered in §3. Summarized here for the semantics-per-section reader:

- User opens `workspaces/{org}/agents/{name}/GOALS.md` and edits it.
- Service detects via mtime > `jsonUpdatedAt` on next read.
- Service emits `goals:user_edit_detected` (stream-only, not ledger).
- Orchestrator's next morning-review reads the detection and asks
  the user: "I see you edited `GOALS.md` for X — want me to
  incorporate this and recascade?"
- If yes: user dictates the changes verbally; orchestrator calls
  the normal `rondel_goals_set_agent_goals` with the reconciled text.
  The service overwrites the file; `mtime` is reset; detection
  resolves.
- If the user ignores the prompt, the mtime-newer-than-JSON state
  persists; next cascade will overwrite. We accept this.

The detection is best-effort: filesystem mtime granularity varies,
editor swap-files may confuse it, and a user who edits and immediately
saves over what the service just wrote could be missed. Acceptable
— this is a hint, not a gate.

---

## 13. First-time setup

Two entry points cooperate:

### 13.1 `rondel init` / `rondel add agent`

- `rondel init --org X` creates `state/goals/X/goals.json` with an
  empty skeleton (`{version: 1, org: "X", northStar: "", dailyFocus: "", updatedAt: now}`).
- `rondel add agent <name>` creates `state/goals/{org}/agents/{name}.json`
  with an empty skeleton (`{version: 1, org, agent: name, focus: "",
  goals: [], updatedBy: "system", updatedAt: now}`).
- Both emit `GOALS.md` mirror files with the "no goals set yet" placeholder
  content — so the user has a visible file from day one, even if empty.
- Creating the skeletons on provisioning (not lazily on first read)
  means `checkStaleness` produces deterministic `north_star_missing`
  (rather than "record entirely absent" which is ambiguous between
  "new install" and "deleted by hand").

### 13.2 Orchestrator's first morning-review

When the orchestrator role lands (§4 of the plan), its first
morning-review skill detects `north_star === ""` and asks the user
a richer onboarding question:

> "You don't have a north-star set yet. What are you trying to build over
> the next year or so? (A sentence or two is fine — we can refine.)"

The user answers; orchestrator calls `rondel_goals_set_north_star` and
then proceeds into the normal daily-focus flow.

**No special onboarding code path inside the daemon** — onboarding is
behavior, and behavior lives in the skill's Markdown. The daemon only
promises "reading from an empty-skeleton state is safe" and "writes
work on empty skeletons." Everything else is skill prose.

### 13.3 Before the orchestrator exists

For Phase 1 pre-orchestrator: an admin specialist can call
`rondel_goals_set_north_star` + `rondel_goals_set_daily_focus` +
`rondel_goals_set_agent_goals` via any channel. The framework skill
`rondel-goal-cascade` (eventually orchestrator-only) runs universally
in the interim, gated by `caller.isAdmin`. Same forward-compat
discipline as heartbeat's `readAll`.

---

## 14. Testing strategy

Follows `docs/TESTING.md` taxonomy. Matches the coverage pattern already
present for heartbeats + tasks.

### Unit — pure modules

**`goal-staleness.unit.test.ts`** — no filesystem, no mocks.

- `north_star_missing` when org.northStar is empty.
- `daily_focus_stale` when `dailyFocusSetAt` absent.
- `daily_focus_stale` when `dailyFocusSetAt` > 24h ago; `fresh` at 23h59m.
- `agent_goals_stale` when `updatedAt` > 24h ago.
- `agent_goals_stale` when agent is in registry but no file exists.
- Unknown agent in registry → stale; known agent with fresh record → fresh.

**`goal-renderer.unit.test.ts`** — pure string output.

- Full inputs → expected Markdown.
- Empty bottleneck → bottleneck line omitted.
- Zero-length goals array → `## Your Goals` section present with
  `_(none set)_` placeholder (same for the full `.md` mirror and the
  prompt section).
- Undefined org or undefined agent → rendered with the missing side
  silently skipped (never throws).
- Idempotency — same inputs produce byte-identical output.

**`sections/goals.unit.test.ts`** — same shape as `sections/memory.unit.test.ts`.

- `isEphemeral: true` → returns null.
- Everything empty → returns null.
- Only north-star set → section shows just north-star.
- Full inputs → full section.
- Mode `agent-mail` → returns null (explicit check inside the section).

### Integration — store

**`goal-store.integration.test.ts`** — filesystem fixtures, no network.
Uses `mkdtempSync` (identical setup to task-store tests).

- Write + read org goals round-trip.
- Write + read agent goals round-trip.
- List all agent goals for an org.
- GOALS.md mirror is written after each set; format matches `renderGoalsMd`.
- Mirror write failure (directory missing, permission denied) does NOT
  fail the JSON write; returns with an error log.
- User-edit detection:
  - Clean state: detect returns `{userEdited: false}`.
  - Touch GOALS.md (bump mtime past JSON updatedAt): detect returns
    `{userEdited: true, fileMtime: ...}`.
  - mtime regression (file older than JSON): detect returns
    `{userEdited: false}`.
- Malformed JSON (hand-corrupted `goals.json`) → read returns
  `undefined`, logged once, next write overwrites cleanly.
- Path-traversal rejection: `writeAgentGoals` with `agent: "../../etc/passwd"`
  rejects via regex.

### Integration — service

**`goal-service.integration.test.ts`** — full service wired against
real store + real hooks + real `OrgLookup`.

- Full lifecycle: set north-star → set daily-focus → set agent goals →
  get pair returns the populated state.
- `rondel_goals_set_daily_focus` bumps `dailyFocusSetAt`; two calls in
  the same turn don't both reset it unless the content differs (TBD
  in implementation — flagged trade-off).
- Hook fan-out: register listeners on all four `goals:*` events; run
  the full lifecycle; verify each fires exactly once with the right
  payload.
- `checkStaleness` with seeded timestamps:
  - All fresh → empty stale list.
  - Daily-focus 25h old → `daily_focus_stale` in the report.
  - One agent with 25h-old goals → that agent in the stale list.
- Agent deleted → `onAgentDeleted` removes both the goals file and the
  GOALS.md mirror.

### Integration — edges

**`goal-service.edge.integration.test.ts`**.

- Cross-org: agent in org A tries to read goals in org B → `cross_org`;
  admin succeeds.
- Forbidden: non-admin non-orchestrator tries to call any `set_*` →
  `forbidden`.
- Unknown agent: `callerAgent` not in registry → `unknown_agent`.
- `setAgentGoals` with `goals.length === 1` or `goals.length === 6` →
  `validation`.
- Write to unknown target agent → `unknown_agent`.

### Prompt-assembly integration

Extends `apps/daemon/src/config/prompt/__tests__/assemble.integration.test.ts`:

- With `goalService` unset in the loader args → prompt assembles without
  the section (backward-compat path).
- With empty goals state → section absent from the output.
- With full goals state → section present, positioned between org
  CONTEXT.md and AGENT.md.
- `mode: "cron"` with full goals state → section absent.
- `mode: "agent-mail"` with full goals state → section absent.

### Stream source

**`goal-stream.unit.test.ts`** — matches `heartbeat-stream.unit.test.ts`.

- Subscribe → unsubscribe leaves no hook listeners.
- Multiple clients receive the same delta; one throwing sender doesn't
  block the others.
- `asyncSnapshot` includes both org-level and per-agent records.

### E2E scenario (one scripted test)

Admin agent sets north-star → sets daily focus → sets goals for two
specialists → each specialist's next prompt assembly contains the
section → the ledger has four events (1 north-star + 1 daily-focus
+ 2 agent-set) → a follow-up `checkStaleness(now)` returns fresh.
Then fast-forward time (inject a clock fn) by 25h, re-run
`checkStaleness` → `daily_focus_stale` is reported.

---

## 15. Migration

New domain; no existing data. Green-field startup wiring.

### Startup wiring

`index.ts` wiring, matching the tasks / heartbeats pattern:

```ts
const goalPaths: GoalPaths = {
  stateRootDir: join(stateDir, "goals"),
  workspacesRootDir: workspacesDir,
};
const goalService = new GoalService({
  paths: goalPaths,
  hooks,
  orgLookup,
  isKnownAgent: agentManager.isKnown.bind(agentManager),
  log,
});
await goalService.init();
const goalStream = new GoalStreamSource(hooks);
// bridge constructor gains goalService + goalStream params
// prompt loader gains optional goalService param (see §5)
```

The prompt loader receives `goalService` from the agent-manager spawn
path — the same place where `orgDir` / `globalContextDir` are already
resolved.

### State-file policy (per CLAUDE.md)

Documented in `ARCHITECTURE.md` in the same PR:

> `state/goals/{org}/goals.json` — org-level objectives. One file per
> org, overwritten in place. Grows linearly with org count.
>
> `state/goals/{org}/agents/{name}.json` — per-agent objectives. One
> file per agent, overwritten in place. Grows linearly with fleet size.
>
> `workspaces/{org}/agents/{name}/GOALS.md` — user-facing rendered
> view. Best-effort; not on the critical path. Grows linearly with
> fleet size.
>
> Retention: overwrite-in-place; the ledger carries history. No
> archival in Phase 1.

### `agent.json`

No change. Goal participation is automatic for every agent in an org.
(If opting out ever becomes a requirement, add `goals.enabled: true`
as a hot-reloadable field — deferred.)

### BRIDGE_API_VERSION

Bump from 16 → 17. History entry:

> 17 — Goal system domain: `rondel_goals_*` MCP tools,
> `POST/GET /goals/*` endpoints, `GET /goals/tail` SSE, 4 new ledger
> kinds (`goals_north_star_set`, `goals_daily_focus_set`,
> `goals_agent_set`, `goals_stale`), new stream source for the web UI.

Matching `apps/web/lib/bridge/schemas.ts` + `WEB_REQUIRES_API_VERSION`
in the same commit (CLAUDE.md parity rule).

---

## 16. Engineering sequence

Build inside the domain folder top-down:

1. **Types + schemas** — `shared/types/goals.ts` + `bridge/schemas.ts`
   additions. No runtime behavior.
2. **`goal-staleness.ts` + unit tests** — pure classifier with tests
   passing before any I/O exists.
3. **`goal-renderer.ts` + unit tests** — pure renderer covering both
   the mirror-`.md` and the prompt-section output shapes.
4. **`goal-store.ts` + integration tests** — including user-edit
   detection test.
5. **`goal-service.ts` + integration tests** — CRUD paths, staleness,
   cascade-adjacent flows.
6. **Hooks + ledger writer wiring** — add the four event cases to
   `hooks.ts` and `LedgerWriter.wireHooks`. Bump `BRIDGE_API_VERSION`
   (and update the web schemas in the same commit).
7. **Prompt section** — `sections/goals.ts` + unit tests + wire into
   `assemble.ts` + update the integration test.
8. **Bridge endpoints + handler tests** — GET first, then POST.
9. **MCP tools in `mcp-server.ts`** — thin adapters.
10. **Stream source + web schema mirror + dashboard snippet** — even a
    trivial Next.js route reading the snapshot makes the goals visible.
11. **Framework skill** — `rondel-goal-cascade/SKILL.md`. Last because
    it references tool names and contracts that must now be stable.
    Dropped in alongside the orchestrator template in Phase 1 §4;
    in the interim, the admin-gated tools are directly callable.

Each step ships with its tests. Each commit leaves the system runnable.

---

## 17. Open questions

Deliberately flagged for iteration — not design commitments.

1. **`cron` mode inclusion.** Plan is to exclude goals from cron mode
   (§5). Morning-review + heartbeat skills pull goals via
   `rondel_goals_get` when needed. Cheap, but a scheduled "check X"
   cron that would benefit from knowing today's focus gets nothing.
   Revisit if we see a class of crons that want it — candidate is to
   add a per-cron `includeGoals: boolean` hot-reload field.
2. **Goals in `MEMORY.md` checkpoints.** Should the heartbeat skill's
   memory-checkpoint step snapshot the day's goals into MEMORY.md for
   posterity? Probably no (MEMORY is for learnings, goals are
   forward), but worth naming the question. Defer.
3. **Onboarding UX.** Today: `rondel init` creates empty skeletons;
   first morning-review fills them in. Alternative: `rondel init`
   prompts "what's your north star?" interactively. The CLI path is
   simpler but the chat path is the natural experience once the
   orchestrator is alive. Leaning toward: CLI stays minimal, chat
   does the rich onboarding. Revisit.
4. **Goal ↔ task coupling.** Right now goals and tasks are
   independent. Morning-review creates tasks *after* cascading goals,
   but there's no formal "this task supports goal X" link. CortexOS
   doesn't have it either. Candidate for a `supportsGoals: string[]`
   field on tasks in a follow-up — cheap metadata, no new mechanism.
5. **Bottleneck escalation.** CortexOS has an org-level `bottleneck`
   field that we've dropped. Agent-level bottleneck lives on the
   agent record. If multiple agents report the same bottleneck, does
   the system aggregate? Phase 1: no. Heartbeat skill surfaces them
   separately.
6. **`dailyFocusSetAt` debounce.** If the orchestrator calls
   `setDailyFocus` twice in quick succession with the same text
   (idempotent no-op), should `dailyFocusSetAt` advance? Argument for
   yes (user intent was re-asserted); argument for no (content
   hasn't changed, don't reset the stale clock). Current proposal:
   advance only on content change. Revisit after seeing real traffic.
7. **User-edit full reconciliation (Phase 2).** §3's mtime-detection
   is a stub for a full bidirectional sync. When we do it, leading
   candidate: YAML front-matter on `GOALS.md` with the canonical
   fields, and the service parses the front-matter on reconciliation
   (not the prose). Front-matter is structured enough to parse
   reliably; prose remains for the human reader.
8. **Goal staleness auto-trigger.** Should a stale daily-focus
   automatically invoke the orchestrator's morning-review skill
   (instead of waiting for 08:00)? Phase 1: no — skill invocation is
   the orchestrator's decision. Phase 2 candidate if the user ends
   up manually triggering it repeatedly.
9. **Per-agent goal visibility.** Right now, any same-org agent can
   read any teammate's goals via `rondel_goals_get`. Is that the
   right privacy default? For Rondel's single-user fleet it's fine
   (you own all the agents). If Rondel ever goes multi-user-in-one-org,
   revisit.
10. **History / snapshots.** The ledger carries every change, so
    "yesterday's focus" is retrievable via ledger query. Not
    retrievable: "what was the full org + all agents goal state at
    time T?" as a single snapshot. Question: is that ever needed?
    Candidate follow-up: periodic snapshot into
    `state/goals/{org}/history/{date}.json` written by the
    evening-review skill. No daemon-level history for Phase 1.
