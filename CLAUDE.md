# Rondel

**ALWAYS respond in English.**

Multi-agent orchestration framework built on the Claude CLI. Scaffolding,
not a pre-built agent team. File-based state, no database. Convention over
config. Early-stage — architecture is still evolving; don't over-commit to
current patterns if a better one emerges.

## Where Rondel is heading

Rondel today is **reactive** — an agent process only exists while a user is
talking to it. The current direction (Phase 1+) is turning it into a
**proactive agent team** with a heartbeat ritual, shared task board, goal
cascade, standing orchestrator role, and morning/evening rituals. Read
[VISION.md](VISION.md) for the long arc; read
[docs/PHASE-1-PLAN.md](docs/PHASE-1-PLAN.md) for what's actually being
designed right now.

## Docs: where to look before writing

Read the relevant section of these **before** touching a domain. Don't
reinvent what's already documented.

| Document | What it is | When to read it |
|---|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | **Authoritative** "how the system is built right now." Component map, message flows, process model, hooks, MCP tools, scheduler, approvals, filesystem tools, skills. ~1500 lines, section-indexed. | Any time you're about to modify or extend existing code. Start here. |
| [VISION.md](VISION.md) | Layers 0–4. Where we're going. Research sources. Reference scenarios (self-evolution, declarative workflows). | Framing a new capability; understanding why something exists. |
| [docs/PHASE-1-PLAN.md](docs/PHASE-1-PLAN.md) | Active phase. Heartbeat / task board / goals / orchestrator role / review rituals. Modularity contract shared across Phase 1 domains. | Building anything in Phase 1 scope. |
| [docs/GAP-ANALYSIS-CORTEXTOS.md](docs/GAP-ANALYSIS-CORTEXTOS.md) | Code-level comparison against CortexOS. Motivates Phase 1+. | Understanding the *why* behind the proactive push. |
| [docs/phase-{1..4}/](docs/) | Per-capability kickoff docs (design chat briefs — each is a self-contained context for designing one capability). | Jumping into a specific capability design session. |
| [docs/TESTING.md](docs/TESTING.md) | Test taxonomy (unit / integration), vitest setup, directory conventions, shared helpers, checklist for adding a test. | **Before** writing or modifying tests. |
| [README.md](README.md) | User-facing install + CLI reference + `~/.rondel/` layout. | Onboarding a user, not yourself. |
| [DEVLOG.md](DEVLOG.md) | Append-only log of critical learnings. **Write-only.** Used later for content generation. | **Never** read for development context. Don't cite it. |

### External reference codebases

Live on the user's machine, not in this repo. Check how they solved a
problem before inventing from scratch — learn from their failure modes, not
their code.

- **OpenClaw** — `/Users/david/Code/openclaw`. Reference for agent /
  subagent split, session management, inter-agent messaging, workflow gates.
- **CortexOS** — `/Users/david/Code/cortextos`. Reference for the
  discipline layer (heartbeats, 3-layer memory, task board, standing roles,
  guardrails self-improvement) that Phase 1+ is porting the ideas of.

When referencing either, dispatch a subagent (see any
`docs/phase-*/0*-kickoff.md` for the parallel-research pattern) — don't
load their codebase into your own context.

## Non-Negotiable Invariants

Correctness rules. Violating them is a bug, not a style choice.

### Per-conversation isolation
Each unique `(agentName, chatId)` pair gets its own Claude CLI process with
its own session. Never share a process across conversations. This is
correctness, not optimization.

### One writer per conversation
A conversation is a serial execution context. Never send a second message
to an agent process that's already busy — queue it and drain on idle.
Enforced by the Router's per-conversation `AsyncLock`. The `sendOrQueue`
pattern is canonical for any internal message injection (subagent results,
cron delivery, inter-agent mail).

### Persist-before-ack
For any message Rondel has accepted responsibility for, write to disk
**before** the accept returns. In-memory state is a cache; disk is truth.
See `apps/daemon/src/routing/router.ts` (`enqueue`) and
`apps/daemon/src/messaging/inbox.ts`.

### `AsyncLock` for keyed serialization
When you need "one operation at a time for a given resource" (per-file
inbox, per-conversation dispatch, per-path session persist), use
`apps/daemon/src/shared/async-lock.ts`. Don't invent ad-hoc `Promise`
chains. Prior rejections don't deadlock later work; errors don't cross call
boundaries.

### Session identity ≠ session state
Conversation key (`agentName:chatId`) is permanent and used for routing.
Session ID is mutable — rotates on `/new`. Never conflate them. Keys are
branded types (`shared/types/sessions.ts`); always construct via
`conversationKey(agent, chatId)`, never by string interpolation.

### User space vs framework space
Every file Rondel touches belongs to exactly one category. **Putting
framework-critical content in user space is a bug** — the user can delete
anything in user space without warning.

**User space** (in `~/.rondel/workspaces/`, user-owned, deletable — never
put invariants here):
- `workspaces/global/CONTEXT.md`, `workspaces/global/USER.md`
- `workspaces/{org}/{org.json, shared/CONTEXT.md, shared/USER.md}`
- `workspaces/**/agents/{name}/{AGENT,SOUL,IDENTITY,USER,MEMORY,BOOTSTRAP}.md`
- `workspaces/**/agents/{name}/.claude/skills/`
- Most `agent.json` fields (exceptions: `agentName`, `enabled`, `admin`
  are schema-enforced)
- `.env`

**Framework space** (shipped with daemon under `apps/daemon/templates/`,
never copied into user space):
- `apps/daemon/templates/framework-skills/` — injected into every agent
  spawn via `--add-dir`; always current from source
- `apps/daemon/templates/framework-context/` — Layer-0 system-prompt
  fragments (tool invariants, disallowed natives, protocol contracts)
- `apps/daemon/templates/context/*.md` — **only** as scaffold templates
  (copied once by `rondel add agent`, then user-owned from that moment)
- The daemon binary + MCP tool descriptions

**Rule to apply before every edit:**
- Would removing this change which tools the agent calls, cause errors,
  or break the framework's contract with the LLM? → **framework-critical.**
  Put it in `framework-context/` or the MCP tool's own description.
- Would removing this only change personality, phrasing, or task
  priorities? → **user space.**

Never replicate framework content into user space "for convenience." If
the same sentence ends up in every `AGENT.md` template, it belongs in
`framework-context/`.

## Coding Conventions

### Modularity

New features are built as **self-contained domains**, not cross-cutting
additions. Every capability should be something you could remove by
deleting a directory and unsubscribing a few hook listeners — not a
tangle that requires tracing edits across five unrelated modules.

- **Single responsibility per domain.** A domain owns one concern and
  all of its state, types, and I/O. If `tasks/` also handles heartbeat
  persistence, split it.
- **Communicate via hooks, not direct reach-in.** Cross-domain coupling
  flows through `RondelHooks` events (see `shared/hooks.ts`). Ledger
  writes, stream fan-out, Telegram notifications all subscribe —
  emitters don't know who's listening. Adding a new observer is a
  listener, never an edit to the emitter.
- **Extend by adding, not by modifying.** New capability? Add a domain
  folder, a hook, a prompt section builder, a stream source, an MCP
  tool. Don't thread new behavior through an existing module's core
  loop.
- **Explicit dependencies.** Imports at the top of the file are the only
  coupling. No globals, no service locators, no hidden registries.
- **Removability test.** Before committing a design, ask: "If we rip
  this feature out in three months, what breaks?" If the answer is
  more than its own directory + a handful of hook subscriptions + a few
  MCP tool registrations, the boundary is wrong.

### Structure
- `apps/daemon/src/` is organized **by domain, not layer**. Current
  domains: `agents/ approvals/ bridge/ channels/ cli/ config/
  filesystem/ ledger/ messaging/ routing/ scheduling/ shared/ streams/
  system/ tools/`. No `utils/`, `models/`, `interfaces/` directories.
- Each directory has a barrel `index.ts`. External consumers import from
  the directory (`../agents`); internal files import each other directly
  (`./agent-process`).
- Cross-cutting types live in `shared/types/`, split by domain. Zero
  runtime imports in type files.
- Dependencies flow inward. `shared/` depends on nothing.
- New file doesn't fit an existing domain? Put it in `shared/` or
  rethink responsibilities. New directory needs justification — it's a
  commitment to a domain boundary.
- **Canonical domain shape** (applied to `agents/`, `approvals/`,
  `scheduling/`, and every Phase 1+ domain — `heartbeats/`, `tasks/`,
  `goals/`): split into `<domain>-store.ts` (file I/O only, pure enough
  to unit-test without mocks), `<domain>-service.ts` (business logic,
  dependency-injected), and MCP tools registered in
  `bridge/mcp-server.ts`. Types in `shared/types/<domain>.ts`. Stream
  source in `streams/<domain>-stream.ts`. Zod schemas at the HTTP/MCP
  boundary only. See
  [docs/PHASE-1-PLAN.md](docs/PHASE-1-PLAN.md) "Shared modularity
  contract" for the full template.

### TypeScript
- Strict mode. `unknown` + narrowing over `any`.
- **Zod at system boundaries** (HTTP, MCP tool inputs, external APIs,
  config parsing). Inside the system, trust the types.
- **Branded types for composite keys** (e.g. `ConversationKey`). Never
  assemble with string interpolation — use the constructor function.

### Daemon ↔ web wire-format parity
The web package (`apps/web`) is a client of the daemon's HTTP bridge and
validates every response with its own Zod schemas. When the two sides
drift, **there is no build-time error** — you get a runtime "Bridge
response schema mismatch" in the dashboard.

Any change to a daemon enum, union, or object shape that crosses the HTTP
wire must land in **the same commit** on both sides:

- `apps/daemon/src/ledger/ledger-types.ts` (`LedgerEventKind`,
  `LEDGER_EVENT_KINDS`) ↔ `apps/web/lib/bridge/schemas.ts`
  (`LedgerEventKindSchema`)
- New or changed Zod schemas in `apps/daemon/src/bridge/schemas.ts` ↔
  mirror in `apps/web/lib/bridge/schemas.ts`
- New SSE frame kinds on a stream source ↔ discriminated union in the
  web's frame schema for that stream
- New enum values on approval reasons, schedule statuses, health tiers,
  etc.

**Version bump rule** (see `BRIDGE_API_VERSION` history at the top of
`apps/daemon/src/bridge/schemas.ts`): adding a new **enum value** or a
new **endpoint the web will call** bumps the API version. Adding an
optional field does not. When bumping daemon-side, update
`WEB_REQUIRES_API_VERSION` in `apps/web/lib/bridge/client.ts` in the
same commit — otherwise the handshake won't catch old-daemon/new-web
skew.

Before committing a change that touches the HTTP surface, grep
`apps/web/lib/bridge/schemas.ts` for the corresponding schema and
confirm it was updated. The symptom of getting this wrong is a dashboard
error banner; the user-visible fix is always "add the missing entry to
the web schema + bump the version."

### Channel adapters
- One folder per channel under `channels/`. Files named by role
  (`adapter.ts`, `mcp-tools.ts`, `index.ts`), not by channel.
- Shared interfaces in `channels/core/`.
- Adapters own their protocol quirks (chunking, markdown flavor, rate
  limits, typing indicators). The router sends text; the adapter decides
  delivery.
- Inbound normalizes to `ChannelMessage` at the adapter boundary.
  Outbound adapts at the adapter boundary. Core never thinks in
  channel-specific terms.
- Credentials: primary secret via `credentialEnvVar`, extras via
  `extraEnvVars`. Single-secret adapters ignore `extra`.
- Don't create stub folders for channels you haven't implemented yet.

### Events & hooks
- Hooks **must not block the emitter** — slow work is fire-and-forget.
- Hooks **must not throw into the emitter** — catch at the hook
  boundary. One failing handler must never crash the agent process or
  prevent other handlers from running.
- Filter early (event type, agent name) before doing work.
- Prefer hook emission over direct calls for cross-cutting concerns
  (ledger writes, stream fan-out, notifications). This keeps modules
  decoupled and makes adding new listeners trivial.

### Errors
- Classify **at the point of failure**: transient (rate limit, network,
  5xx, crash) → retryable; permanent (bad config, auth rejected, invalid
  input) → not.
- **One-shot** ops (subagent, webhook) retry fixed count with backoff,
  then fail. **Recurring** ops (cron, polling) use exponential backoff
  but stay enabled — backoff resets on next success.
- Non-critical delivery failures (notifications, transcript writes) log
  and continue. The agent's work matters more than the notification
  about it.

## Development Approach

- **Iterate, don't waterfall.** Simplest working version first, then
  improve. Validate the happy path end-to-end before hardening edges.
- **Keep the system runnable.** Large refactors go in incrementally.
- **Clean breaks between phases.** When a phase is done, fully replace
  the old approach — no back-compat shims, no `// legacy` paths, no
  supporting both config formats. Dead paths make the code confusing and
  harder to evolve.
- **Check OpenClaw / CortexOS before inventing.** New capability
  (queuing, sessions, scheduling, heartbeats, task boards)? Dispatch a
  research subagent at their codebases first. See any
  `docs/phase-*/0*-kickoff.md` for the parallel-research pattern.

## State-File Policy

Every new persistent file under `~/.rondel/state/` needs a documented
retention strategy in ARCHITECTURE.md (even if it's "grows forever for
now"). Every new `agent.json` field needs a documented hot-reload
classification: hot-reloadable (cron schedules, model preferences) vs
restart-required (process spawning parameters, server ports). Applying a
restart-required change at runtime is worse than not reloading at all.
