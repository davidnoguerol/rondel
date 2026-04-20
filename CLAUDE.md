# Rondel

## What This Is

Rondel is a **multi-agent orchestration framework** built on the Claude CLI. It's scaffolding — not a pre-built agent team. Users define their own agents, configure identities and skills, and Rondel handles lifecycle, communication, and messaging integration.

This project is in active development. The architecture is still evolving. We're building toward a system that can manage multiple companies/projects through semi-autonomous agent teams, but we're finding the best approach as we go. Expect the design to shift — don't over-commit to current patterns if a better one emerges.

### Core Direction

- **Framework, not product** — Rondel provides the engine. Users define the agents.
- **File-based state, no database** — All persistence via JSON/JSONL files. Debuggable, portable, git-friendly.
- **Convention over configuration** — Drop files in the right folder structure and Rondel discovers them.
- **Progressive complexity** — Start flat with just `agents/`. Add organizations when you need isolation. The org layer is optional.
- **Multi-org isolation** — When orgs are used, agents run across multiple companies/projects with shared and isolated context.
- **Plugin-ready from day 1** — Channel adapters, agent backends, and tools are interfaces — even if we only ship one implementation initially.

### Key Concepts

- **Top-level agents**: Persistent Claude CLI processes with their own identity, system prompt, and messaging channels.
- **Subagents**: Ephemeral processes spawned by top-level agents for specific tasks. They report back and exit.
- **Organizations**: Optional grouping layer marked by `org.json` (auto-discovered like `agent.json`). Agents within an org get org-specific shared context (`{org}/shared/CONTEXT.md`) injected between global and per-agent context. `org.json` carries `orgName`, optional `displayName`, and `enabled` flag. Nested orgs are disallowed. Cross-org messaging is blocked by default (enforced at the bridge layer). Same-org and global agents communicate freely.
- **Context composition**: System prompts are assembled by the `config/prompt/` module via a pure `buildPrompt(inputs)` (no I/O) fed by an async `loadPromptInputs(args)` that reads disk. Three `PromptMode`s: `main` (user conversations), `agent-mail` (inter-agent — appends the AGENT-MAIL.md block), `cron` (ephemeral + prepends a cron preamble). Block order, joined with a single `\n\n` (no `---` horizontal rules, no synthetic `# FILENAME` headings — bootstrap files already open with their own H1): framework sections (Identity, Safety, Tool Call Style, Memory*, Execution Bias, Tool Invariants from `templates/framework-context/TOOLS.md`, Admin Tool Guidance*, CLI Quick Reference*, Current Date & Time, Workspace, Runtime) → `workspaces/global/CONTEXT.md` → `{org}/shared/CONTEXT.md` (if in an org) → per-agent files (`AGENT.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`*, `MEMORY.md`*, `BOOTSTRAP.md`*). Sections marked `*` are persistent-mode only — `cron` (the only ephemeral mode) strips them. USER.md has a fallback chain: agent's own → `{org}/shared/USER.md` → `global/USER.md`. **Subagents bypass `buildPrompt` entirely**: `rondel_spawn_subagent` callers pass a `system_prompt` inline (often sourced from a skill's recipe) — reusable role prompts live in skills, not a separate filesystem convention. Matches OpenClaw's agent/subagent split — their `buildSubagentSystemPrompt` is a completely separate builder too.
- **Agent memory**: Persistent knowledge stored in the agent's directory as `MEMORY.md`. Agents read/write via MCP tools (`rondel_memory_read`, `rondel_memory_save`). Survives session resets, restarts, and context compaction. Included in system prompt on every spawn (main sessions only).
- **Admin tool scoping**: Agents with `admin: true` in agent.json get admin MCP tools (add agent, update config, set env, reload). Non-admin agents only get `rondel_system_status` (read-only). The first agent created by `rondel init` is admin by default. Agents created via `rondel_add_agent` are non-admin by default. Follows OpenClaw's `ownerOnly` pattern — privilege is orthogonal to agent identity.
- **Runtime agent hot-add**: Admin agents can create new agents at runtime via `rondel_add_agent`. The bridge scaffolds the directory, loads config, registers the Telegram bot, and starts polling — no restart needed. Discovery is recursive filesystem scan, so agents can be placed in any `workspaces/` subdirectory (including org-specific paths).
- **Skills (on-demand instructions)**: Agents learn HOW to do things via Claude Code native skills. Framework skills ship at `templates/framework-skills/.claude/skills/` and are injected via `--add-dir` at spawn time — always current from source, never copied. Per-agent skills live at `<agentDir>/.claude/skills/` (user's space). Skills ≠ permissions: skills are informational, admin gating is at the MCP tool layer. AGENT.md holds behavioral rules only (Tool Call Style, Safety, Memory, Red Lines); operational workflows live in skills. Agents can author new per-agent skills at runtime via the `rondel-create-skill` framework skill and then call `rondel_reload_skills` — this schedules a post-turn process restart (consumed by the Router on the next `idle` transition before drain, session preserved via `--resume`) so the new skill becomes discoverable without losing context.
- **First-run bootstrap**: New agents include a `BOOTSTRAP.md` file that triggers a one-time onboarding ritual on the agent's first conversation. The agent asks the user about preferences and saves answers to `USER.md`/`SOUL.md`. The file is deleted after completion and never recreated.
- **Inter-agent messaging**: Agents send async messages to each other via `rondel_send_message` MCP tool. Messages are delivered to a synthetic "agent-mail" conversation per recipient (keyed as `agentName:agent-mail`), completely isolated from user conversations. Responses are automatically routed back to the sender's original conversation by the Router. Org isolation enforced at the bridge: global agents unrestricted, same-org allowed, cross-org blocked. Messages are persisted to disk-based inboxes (`state/inboxes/{agentName}.json`) before delivery and removed after — undelivered messages are recovered on restart. 1-turn request-response only (no multi-turn ping-pong). For large artifacts, agents write to a shared drive folder and reference the file path in their message. Agent-mail conversations get additional framework context (`templates/context/AGENT-MAIL.md`) appended to their system prompt — this instructs agents to be direct and concise when handling inter-agent messages. Agents can recall their recent user conversation via `rondel_recall_user_conversation` to provide live context beyond what's in MEMORY.md.
- **Per-conversation isolation**: Each unique `(agentName, chatId)` pair gets its own Claude CLI process with its own session. Agent config is a *template* — no processes exist until a conversation starts. Three users messaging the same bot = three independent processes. This is a correctness invariant, not an optimization. Never share a process across conversations.
- **Block streaming**: Text blocks are emitted immediately as `assistant` events arrive — not buffered until turn end. The user sees intermediate messages ("Creating agent...") while tools run. Each block fires a `response` event sent to Telegram independently.
- **Session identity vs. session state**: The conversation key (`agentName:chatId`) is permanent and used for routing. The session ID is mutable — it rotates on `/new` and can be replaced without changing the routing key. Don't conflate these. The key tells you *which* conversation; the session ID tells you *which context window*.
- **Conversation ledger**: Structured, append-only JSONL event log at `state/ledger/{agentName}.jsonl`. Captures business-level events: user messages, agent responses, inter-agent messages, subagent lifecycle, cron results, session lifecycle (start, resume, reset, crash, halt). Events carry summaries (truncated, not full content) — the ledger is an index, not a transcript. Written by `LedgerWriter` which subscribes to all `RondelHooks` events. Queryable by agents via `rondel_ledger_query` MCP tool (filter by agent, time range, event kinds, limit). Enables Layer 3 (monitor agents observing patterns across agents). Subsumes the old `messages.jsonl` — all inter-agent events now go to per-agent ledger files instead.
- **Session resilience**: New session entries only persist to disk after Claude CLI confirms the session. Resume failure detection falls back to fresh session within 10s regardless of exit code. Two layers: prevention (don't write stale entries) + recovery (detect and recover from stale entries).

---

## Coding Standards

### Think Modular, Think Expansion

This project will grow significantly. Every module you write should be designed with the assumption that it will need to support capabilities that don't exist yet. That doesn't mean over-engineering — it means writing clean boundaries.

- **Interfaces first**: When a component talks to an external concern (channels, storage, agent backends), define the interface before the implementation. The first implementation may be the only one for a while, but the seam should exist.
- **One responsibility per module**: If a file is doing two unrelated things, split it. If a function has an "and" in its description, it's probably two functions.
- **No god objects**: State and logic should be distributed across focused managers/services, not centralized in one mega-class.

### Code Quality

- **Readable over clever**: If a pattern requires a comment to explain why it's not confusing, use a simpler pattern instead.
- **Name things precisely**: A function called `process()` tells you nothing. `routeMessageToAgent()` tells you everything. Spend time on names — they're the primary documentation.
- **Small functions**: If a function doesn't fit on one screen, it's too long. Extract logical steps into well-named helpers.
- **Explicit over implicit**: Prefer passing dependencies explicitly over relying on module-level singletons or global state. This makes testing easier and data flow visible.
- **Fail loudly at boundaries**: Validate inputs at system boundaries (user input, config files, external APIs). Inside the system, trust the types.

### Patterns to Follow

- **Dependency injection over imports**: Core services (logger, config, state) should be injectable. This keeps modules testable and avoids tight coupling.
- **Events over direct calls for cross-cutting concerns**: When module A doesn't need a response from module B, use events. This keeps modules decoupled and makes adding new listeners trivial. Conventions for our hook system:
  - **Hooks must not block the emitter**: If a hook does slow work (Telegram notification, transcript write), it runs fire-and-forget. Never delay the emitting module.
  - **Hooks must not throw into the emitter**: Catch and log errors at the hook boundary. A failing notification handler must never crash the agent process. Other handlers must still run.
  - **Filter early**: Check relevance (event type, agent name) before doing work. Avoid expensive operations on events that don't apply.
- **Composition over inheritance**: Build behavior by combining small, focused pieces — not by extending base classes.
- **Errors as values where it matters**: For expected failure modes (agent crash, message delivery failure), handle them as part of normal flow. Reserve exceptions for truly unexpected situations.
- **One writer per conversation at a time**: A conversation is a serial execution context. Never send a second message to an agent process that's already busy — queue it and drain on idle. This is a correctness invariant (not just a Claude CLI limitation). The `sendOrQueue` pattern is the canonical approach for any internal message injection (subagent results, cron delivery, inter-agent messages). For agent-mail conversations, `sendOrQueue` carries `AgentMailReplyTo` metadata so the Router can route responses back to the correct sender.
- **Channel adapters own their protocol quirks**: Message chunking, typing indicators, markdown flavor, media constraints, rate limits — these all belong inside the adapter, not in the router or agent manager. The router sends text; the adapter decides how to deliver it within the channel's constraints.
- **One folder per channel**: Each channel lives in its own subfolder under `apps/daemon/src/channels/` (e.g. `telegram/`). Inside the folder, files are named by role (`adapter.ts`, `mcp-tools.ts`, `index.ts`), not by channel. Shared interfaces and the registry live in `apps/daemon/src/channels/core/`. External code imports from the top-level barrel (`../channels`) or a specific channel barrel (`../channels/telegram`) — never from concrete adapter files. New adapters follow the same shape: one folder, one `adapter.ts`, one `mcp-tools.ts` if the channel needs outbound MCP tools, one `index.ts` barrel. Don't create stub folders for channels you haven't implemented yet.
- **Channel credentials**: Each `ChannelBinding` in `agent.json` has a `credentialEnvVar` (primary secret — bot token, OAuth token) and an optional `extraEnvVars` map for channels that need more than one secret (e.g. a channel needing a bot token *and* an app-level token would use `extraEnvVars: { appToken: "<env var>" }`). The adapter's `addAccount(accountId, credentials)` receives both via `ChannelCredentials = { primary, extra }`. Single-secret adapters (Telegram) ignore `extra`.
- **Inbound normalization, outbound adaptation**: Messages entering the system get normalized to `ChannelMessage` at the adapter boundary. Messages leaving get adapted (chunking, markdown, typing indicators) at the adapter boundary. The core never thinks in channel-specific terms.

### Error Handling Patterns

- **Classify errors as transient or permanent at the point of failure**: Transient errors (rate limits, network timeouts, 5xx responses, process crashes) are retryable. Permanent errors (bad config, auth rejected, invalid input, process halted after crash limit) are not. Every error path should make this distinction explicit — it determines whether the system retries, backs off, or gives up.
- **Backoff strategy follows the job type**: One-shot operations (subagent runs, webhook deliveries) retry a fixed number of times with increasing delays, then fail permanently. Recurring operations (cron jobs, polling loops) use exponential backoff but stay enabled — backoff resets on the next success. Never apply the same retry logic to both.
- **Degrade gracefully on non-critical failures**: If a delivery fails but the core operation succeeded, log and continue — don't fail the whole operation. Use `.catch(() => {})` for side-effects like notifications and transcript writes. The agent's work matters more than the notification about it.

### Lifecycle and State

- **State files need maintenance policies**: Every persistent file (sessions.json, cron-state.json, transcripts) should have a defined retention strategy — even if it's just "grows forever for now, prune later." Document the expectation in ARCHITECTURE.md when adding new state files.
- **Config hot-reload must classify changes**: Not all config changes are safe to apply at runtime. When adding a new config field, explicitly decide: is it hot-reloadable (cron schedules, model preferences) or restart-required (process spawning parameters, server ports)? Applying a restart-required change at runtime is worse than not reloading at all.

### User Space vs Framework Space (critical — do not cross this boundary)

Every file Rondel touches belongs to exactly one of two categories. Putting framework-critical content in user space is a bug — the user owns their files and can delete anything in them without warning. If their edit can break agent behavior, the content was in the wrong place.

**User-configurable files (never put system invariants here):**
- `workspaces/global/CONTEXT.md`, `workspaces/global/USER.md`
- `workspaces/{org}/org.json` (user fields only; required fields are framework-critical but schema-enforced)
- `workspaces/{org}/shared/CONTEXT.md`, `workspaces/{org}/shared/USER.md`
- `workspaces/**/agents/{name}/AGENT.md`
- `workspaces/**/agents/{name}/SOUL.md`
- `workspaces/**/agents/{name}/IDENTITY.md`
- `workspaces/**/agents/{name}/USER.md`
- `workspaces/**/agents/{name}/MEMORY.md` (agent-owned at runtime; still user-visible and deletable)
- `workspaces/**/agents/{name}/BOOTSTRAP.md`
- `workspaces/**/agents/{name}/.claude/skills/` (per-agent authored skills)
- Most `agent.json` fields (model, channels, tools, crons, working_directory). Exceptions: `agentName`, `enabled`, `admin` — schema-enforced.
- `.env` — user-owned secrets.

**Framework-owned files (shipped with the daemon, never copied into user space):**
- `apps/daemon/templates/framework-skills/` (agent capability skills injected via `--add-dir`)
- `apps/daemon/templates/framework-context/` (system-prompt fragments prepended as Layer 0 — carries tool surface, disallowed natives, protocol invariants)
- `apps/daemon/templates/context/*.md` when used as **scaffold templates** (copied once into a new agent's directory by `rondel add agent`; after that they are user-owned)
- The daemon binary + its MCP tool descriptions.

**Bootstrap templates are a half-exception**: `apps/daemon/templates/context/AGENT.md` is a scaffold copied into a new agent's directory on creation. From that moment it is user-owned. A user deleting lines from their agent's AGENT.md must not be able to break the agent. Consequence: AGENT.md is for personality / role / preferences / behavioral style only. It is NOT for framework-critical instructions (tool names, disallow lists, protocol contracts, safety invariants). Those go in framework-context.

**Rule to apply before every edit**:
- If removing this content would change which tools the agent calls, produce errors, or break the framework's contract with the LLM → it's framework-critical. Put it in `apps/daemon/templates/framework-context/` or the MCP tool's own description, never in user space.
- If removing this content would only change the agent's personality, phrasing, or task priorities → it's user space.

**Never replicate framework content into user space as a convenience.** If you find yourself copying the same sentence into every AGENT.md template, that sentence belongs in framework-context.

### What to Avoid

- **Premature abstraction**: Don't build elaborate systems for purely hypothetical futures. But when the direction is known and the cost is low, build the seam now. A composite key `(channelType, channelId)` when multi-channel is planned next month isn't premature — a full plugin SDK when there's one plugin is. Use judgment: if the abstraction is cheap and the expansion is certain, do it. If it's expensive and speculative, don't.
- **Circular dependencies**: If module A imports B and B imports A, the boundary is wrong. Refactor.
- **Leaking internals**: A module's public API should be intentional. Don't export everything just because it's convenient.
- **Deep nesting**: More than 2-3 levels of nesting (callbacks, conditionals) is a signal to restructure. Early returns, guard clauses, and extraction help.

### TypeScript Conventions

- Use strict TypeScript. Avoid `any` — use `unknown` and narrow when the type is genuinely uncertain.
- Prefer `interface` for object shapes, `type` for unions and computed types.
- Use `readonly` where mutation isn't needed.
- Barrel exports (`index.ts`) are fine for public APIs of a module, but don't re-export internal details.
- **Branded types for composite keys**: Use `string & { readonly __brand: "X" }` for identifiers that are constructed from multiple parts (e.g., `ConversationKey`). Provide constructor functions — never assemble the key with string interpolation. This catches misuse at compile time.
- **Zod validation at system boundaries**: Validate HTTP request bodies and external input with Zod schemas (already a dependency). Use `safeParse()` and return structured errors. Internal module-to-module calls trust the types — don't re-validate.

### Project Structure

Rondel has two distinct directory structures: the **source code** (this repository) and the **installation** (`~/.rondel/`, created by `rondel init`).

#### Source code (this repository)

```
rondel/                           # Source repository (pnpm workspace root)
├── CLAUDE.md                     # This file — coding standards, conventions
├── ARCHITECTURE.md               # Current architecture as built (living doc)
├── DEVLOG.md                     # Development log — decisions, progress
├── README.md                     # User-facing getting started guide
├── package.json                  # Workspace root: dev/build scripts, root `bin` shim, devDeps
├── pnpm-workspace.yaml           # Declares apps/* as workspace packages
├── tsconfig.json                 # Project-references stub
├── tsconfig.base.json            # Shared strict TS flags (extended by every package)
├── .npmrc                        # pnpm settings (strict-peer-deps, link-workspace-packages)
│
└── apps/
    ├── daemon/                   # @rondel/daemon — Node CLI + bridge + agent lifecycle
    │   ├── package.json          # Daemon deps, `bin: dist/cli/index.js`
    │   ├── tsconfig.json         # Extends ../../tsconfig.base.json
    │   ├── templates/
    │   │   ├── context/          # Agent bootstrap file templates (AGENT.md, SOUL.md, etc.)
    │   │   └── framework-skills/ # Framework skills (injected via --add-dir at spawn)
    │   └── src/                  # Source code (domain-organized)
    │       ├── index.ts          # Orchestrator entry — exports startOrchestrator()
    │       ├── cli/              # CLI commands (init, add agent/org, stop, restart, logs, status, doctor, service)
    │       ├── agents/           # Agent process lifecycle (spawn, crash, resume, track)
    │       ├── approvals/        # HITL approval service (fires when rondel_* tool classifiers escalate)
    │       ├── bridge/           # IPC between Rondel core and MCP server processes
    │       │   ├── bridge.ts         # HTTP server + read-only endpoints + routing
    │       │   ├── admin-api.ts      # Admin mutation logic (add/update/delete agent, orgs, env, reload)
    │       │   ├── schemas.ts        # Zod validation schemas for admin endpoints + bridge responses
    │       │   └── mcp-server.ts     # Standalone MCP server process (spawned by Claude CLI)
    │       ├── channels/         # Channel abstraction + per-adapter implementations
    │       │   ├── core/             # ChannelAdapter + ChannelCredentials + ChannelMessage + ChannelRegistry
    │       │   └── telegram/         # TelegramAdapter + registerTelegramTools (adapter.ts, mcp-tools.ts)
    │       ├── config/           # Config loading, agent discovery, system prompt assembly
    │       │   ├── config.ts         # RondelConfig + agent/org discovery + ${ENV} substitution
    │       │   ├── env-loader.ts     # Minimal .env parser (loads into process.env)
    │       │   └── prompt/           # System-prompt assembly module
    │       │       ├── assemble.ts       # buildPrompt() (pure) + loadPromptInputs() (I/O)
    │       │       ├── sections/         # 11 pure framework-section builders (identity, safety,
    │       │       │                     # tool-call-style, memory, execution-bias, tool-invariants,
    │       │       │                     # admin-tool-guidance, cli-quick-reference, current-date-time,
    │       │       │                     # workspace, runtime)
    │       │       ├── bootstrap.ts      # Reads AGENT/SOUL/IDENTITY/USER/MEMORY/BOOTSTRAP.md
    │       │       ├── shared-context.ts # Reads global + org shared CONTEXT.md
    │       │       ├── cron-preamble.ts  # Cron-mode-only prepended block
    │       │       ├── agent-mail.ts     # Agent-mail-mode-only appended block
    │       │       ├── template-subagent.ts # Separate pipeline for named-template subagents
    │       │       └── types.ts          # PromptInputs, PromptMode, etc.
    │       ├── ledger/           # Conversation ledger (Layer 1) — structured event log
    │       │   ├── ledger-types.ts   # LedgerEvent, LedgerEventKind, Zod query schema
    │       │   ├── ledger-writer.ts  # LedgerWriter — subscribes to hooks, appends JSONL
    │       │   ├── ledger-reader.ts  # queryLedger() — reads/filters for bridge endpoint
    │       │   └── index.ts          # Barrel exports
    │       ├── messaging/        # Inter-agent message persistence (file-based inbox)
    │       ├── routing/          # Inbound message flow: channel → agent + inter-agent delivery
    │       ├── scheduling/       # Timer-driven cron execution
    │       ├── streams/          # Live SSE streams — fan-out sources + wire handler
    │       │   ├── sse-types.ts      # SseFrame + StreamSource<T> interface
    │       │   ├── sse-handler.ts    # Generic handler: headers, subscribe→replay→flush, heartbeats
    │       │   ├── ledger-stream.ts  # LedgerStreamSource — wraps LedgerWriter.onAppended
    │       │   ├── agent-state-stream.ts # AgentStateStreamSource — snapshot + deltas from ConversationManager
    │       │   └── index.ts          # Barrel exports
    │       ├── shared/           # Cross-cutting: types, logger, hooks, utilities
    │       │   └── types/            # Domain-aligned type definitions (zero runtime imports)
    │       │       ├── config.ts         # RondelConfig, AgentConfig, OrgConfig, discovery types
    │       │       ├── agents.ts         # AgentState, AgentEvent, stream-json protocol types
    │       │       ├── subagents.ts      # SubagentSpawnRequest, SubagentState, SubagentInfo
    │       │       ├── scheduling.ts     # CronJob, CronSchedule, CronJobState, CronRunResult
    │       │       ├── sessions.ts       # ConversationKey (branded), SessionEntry, SessionIndex
    │       │       ├── routing.ts        # QueuedMessage (with AgentMailReplyTo)
    │       │       ├── transcripts.ts    # TranscriptSessionHeader, TranscriptUserEntry
    │       │       └── messaging.ts      # InterAgentMessage, AgentMailReplyTo, hook event types
    │       └── system/           # Process-level concerns (instance lock, OS service management)
    │
    └── web/                      # @rondel/web — Next.js human UI (client of the bridge)
        ├── package.json          # Next 15, React 19, Tailwind v4, shadcn/ui, assistant-ui, Zod
        ├── components.json       # shadcn config (style: new-york, baseColor: zinc, CSS variables)
        ├── postcss.config.mjs    # Tailwind v4 via @tailwindcss/postcss (no autoprefixer — bundled)
        ├── styles/globals.css    # CSS-first Tailwind v4 @theme + dark palette on :root + .light overrides
        ├── tsconfig.json         # Extends ../../tsconfig.base.json (+ Next specifics, verbatimModuleSyntax)
        ├── app/                  # App Router: (dashboard)/agents/[name]/{page,ledger,memory,chat}
        ├── lib/
        │   ├── bridge/           # discovery.ts, fetcher.ts, errors.ts, schemas.ts, client.ts, streams/
        │   ├── streams/          # React hooks wrapping EventSource (use-event-stream, …)
        │   └── utils.ts          # cn() helper (clsx + tailwind-merge) used by every ui/ primitive
        ├── components/
        │   ├── ui/                   # shadcn primitives (button, card, dialog, command, tooltip, …) — owned here, edit freely
        │   ├── assistant-ui/         # assistant-ui's scaffolded Thread/Composer/Markdown (chat surface)
        │   ├── chat/                 # rondel-runtime.tsx (ExternalStoreRuntime bridging web channel → assistant-ui) + chat-view.tsx
        │   ├── layout/               # topbar.tsx, sidebar.tsx, route-transition.tsx, live-agent-badges.tsx
        │   ├── agents/, approvals/, ledger/  # feature surfaces — presentational, no data fetching
        │   ├── command-palette.tsx   # cmdk-powered ⌘K palette (navigate agents, toggle theme, …)
        │   ├── hotkey-provider.tsx   # react-hotkeys-hook bindings (g a, g p, ⌘.)
        │   ├── theme-provider.tsx    # next-themes wrapper (class attribute, dark default, no system)
        │   └── theme-toggle.tsx      # sun/moon toggle button
        └── middleware.ts         # Loopback gate — rejects non-127.0.0.1/localhost requests
```

**Package boundary:** `@rondel/web` is a *client* of `@rondel/daemon`'s HTTP bridge. It never imports runtime values — or source files — from the daemon. Domain types for the web package are derived from Zod schemas at the HTTP boundary in [apps/web/lib/bridge/schemas.ts](apps/web/lib/bridge/schemas.ts) via `z.infer<typeof Schema>`, and consumers import them from the `@/lib/bridge` barrel. That file is the **canonical source** — if a type is missing, add it alongside its Zod schema. The wire format and the TypeScript types can never drift because they come from the same source. This also keeps the daemon shippable without the web package and keeps Node-only modules out of the Next.js client bundle.

**UI conventions:**
- **shadcn/ui lives in [apps/web/components/ui/](apps/web/components/ui/)** — the files are checked in and owned by this repo. Edit them freely; the shadcn CLI is only used to add new primitives. Use `cn()` from `@/lib/utils` (clsx + tailwind-merge) in every new component.
- **assistant-ui is the chat primitive, not the chat adapter.** The scaffolded `Thread` / `Composer` / `Markdown` components live in [apps/web/components/assistant-ui/](apps/web/components/assistant-ui/). The Rondel-specific transport — wiring assistant-ui's `ExternalStoreRuntime` to the web channel's `POST /web/messages/send` + SSE tail — lives in [apps/web/components/chat/rondel-runtime.tsx](apps/web/components/chat/rondel-runtime.tsx). Never talk to assistant-ui's store from outside the runtime file; never talk to the bridge from inside the Thread components.
- **Tailwind v4, CSS-first.** Tokens are declared in `@theme` blocks inside [apps/web/styles/globals.css](apps/web/styles/globals.css). There is no `tailwind.config.ts`. Dark is the default palette on `:root`; light is applied by `next-themes` via a `.light` class on `<html>`. System-preference mode is disabled.

#### Installation (`~/.rondel/`)

Created by `rondel init`. Override location with `RONDEL_HOME` env var.

```
~/.rondel/                     # THE one Rondel installation
├── config.json                  # Global config (defaultModel, allowedUsers)
├── .env                         # Secrets (bot tokens, API keys)
├── .gitignore                   # Excludes state/ and .env
│
├── workspaces/                  # User-organized content (git-committed)
│   ├── global/
│   │   ├── CONTEXT.md           # Cross-agent shared context
│   │   └── agents/
│   │       └── {name}/          # agent.json + AGENT.md + SOUL.md + IDENTITY.md
│   │                            #   + USER.md + MEMORY.md + BOOTSTRAP.md
│   │                            #   + .claude/skills/ (per-agent skills)
│   ├── {org}/                   # Optional org grouping (auto-discovered via org.json)
│   │   ├── org.json             # Org config: orgName, displayName, enabled
│   │   ├── agents/
│   │   │   └── {name}/          # Same structure as global agents (orgName auto-set)
│   │   └── shared/              # Org-specific shared knowledge
│   │       ├── CONTEXT.md       # Org context (injected between global and agent)
│   │       └── USER.md          # Org-level USER.md fallback
│   └���─ ...                      # User organizes as they wish
│
└── state/                       # Runtime ephemera (NOT committed)
    ├── sessions.json            # Session index
    ├── cron-state.json          # Cron job state
    ├── ledger/                  # Conversation ledger — per-agent structured event logs
    │   └── {agentName}.jsonl    # Business-level events (summaries, not full content)
    ├── inboxes/                 # Per-agent pending inter-agent messages
    │   └── {agentName}.json     # Inbox queue (written before delivery, removed after)
    ├── approvals/               # HITL approval records
    │   ├── pending/             # Active requests awaiting human decision
    │   │   └── {requestId}.json
    │   └── resolved/            # Completed approvals (audit trail)
    │       └── {requestId}.json
    ├── rondel.lock            # Instance lock + bridge URL + log path
    ├── rondel.log             # Daemon log output (rotated at 10MB)
    └── transcripts/             # JSONL conversation history (raw stream-json)
```

**Key separation:** `workspaces/` is the user's domain — agents, identity, memory, shared knowledge. This is what gets committed to git. `state/` is runtime ephemera that Rondel manages — never committed.

**Discovery:** Rondel recursively scans `workspaces/` for directories containing `org.json` (organizations) and `agent.json` (agents) in a single pass. `orgName` and `agentName` fields are the unique identifiers — duplicates produce startup errors. The filesystem is the source of truth; no explicit lists in config. `enabled: false` in either file disables it (a disabled org skips its entire agent subtree). Agents found under an org's directory tree are automatically associated with that org.

#### Source code organization

**`apps/daemon/src/` is organized by domain, not by layer.** The question is: *"If I'm working on feature X, which directory do I open?"*

**Mental model for where things go:**

- **Is it a user-facing command?** → `cli/`
- **Would a new channel adapter need this?** → `channels/`
- **Is it about spawning, crashing, or managing a Claude process?** → `agents/`
- **Is it about when things run on a timer?** → `scheduling/`
- **Is it about getting a message from point A to point B?** → `routing/`
- **Is it about observing what agents did?** → `ledger/`
- **Is it about asking a human to approve or answer something?** → `approvals/`
- **Does every module import it?** → `shared/`
- **Is it about how Rondel talks to its own child processes?** → `bridge/`

**Rules for this structure:**

- **Each directory has a barrel `index.ts`** that re-exports the public API. External consumers import from the directory (`../agents`), not from internal files (`../agents/agent-process`). Internal files within a directory import each other directly (`./agent-process`).
- **Organize by domain, not by type.** Don't create `interfaces/`, `utils/`, or `models/` directories. A type used only by scheduling lives in `scheduling/`, not in a global `types/` folder. Cross-cutting types live in `shared/types/`, split by domain (config, agents, subagents, scheduling, sessions, routing, transcripts, messaging). Each type file has zero runtime imports — pure type definitions only. The barrel `shared/types/index.ts` re-exports everything.
- **New files go in the directory they belong to.** If a new file doesn't fit any existing directory and you can't justify a new one, it probably belongs in `shared/` or the file's responsibilities need rethinking.
- **New directories need justification.** Don't create a directory for a single file unless you're confident it will grow. A directory is a commitment to a domain boundary. If the domain doesn't exist yet, the file lives in the closest neighbor until it does.
- **Dependencies flow inward.** `shared/` depends on nothing. Domain directories depend on `shared/` and occasionally on each other. `index.ts` depends on everything. If you find `shared/` importing from a domain directory, the boundary is wrong — move the shared piece down or rethink the dependency.
- **No circular dependencies between directories.** If `agents/` imports from `scheduling/` and `scheduling/` imports from `agents/`, extract the shared concern into `shared/` or rethink the boundary. Use `type` imports where possible to break compile-time cycles.

**Knowledge base policy:** Root holds only living documents you actively reference during development. Don't add new markdown files to the root unless they'll be actively maintained.

---

## Key Documents

- **[ARCHITECTURE.md](ARCHITECTURE.md)** — Current architecture as built. Component map, message flows, process model, MCP injection, and key interfaces. Describes what exists in code right now — not the plan.
- **[docs/RONDEL-PLAN.md](docs/RONDEL-PLAN.md)** — The north star. Full architectural vision for where Rondel is headed. Use this as a reference for the end-state design, but don't implement it top-down. Build incrementally and let the plan guide direction, not dictate every detail.
- **[DEVLOG.md](DEVLOG.md)** — Living development log. Tracks what we've built, what worked, what didn't, decisions made and why, and discoveries along the way. Updated as we go. This is the ground truth for where the project actually is vs. where the plan says it should be.
- **[docs/CLI-REFERENCE.md](docs/CLI-REFERENCE.md)** — Claude CLI flags, stream-json protocol, MCP config format, and environment variables relevant to Rondel. Read this before modifying agent process spawning or adding new CLI flags.
- **[docs/TESTING.md](docs/TESTING.md)** — Test strategy, patterns, and standards. Taxonomy (unit/integration/contract/e2e), directory conventions, mocking philosophy, shared helper reference, and the checklist for adding a new test. Read this before writing or modifying tests.
- **[docs/openclaw/OPENCLAW-INDEX.md](docs/openclaw/OPENCLAW-INDEX.md)** — The reference implementation we draw architectural patterns from. IMPORTANT: when designing a new Rondel feature, check how OpenClaw solved the same problem before inventing from scratch.

---

## Development Approach

- **Iterate, don't waterfall**: Build the simplest working version of a feature, validate it works, then improve. Don't try to build the "final" version on the first pass.
- **Keep the system runnable**: Every change should leave the system in a working state. If a refactor is large, do it incrementally.
- **When in doubt, keep it simple**: If you're debating between a simple approach and a sophisticated one, start with simple. We can always add complexity — removing it is harder.
- **Clean breaks between phases**: When a phase is validated and we move to the next, fully replace the old approach. No backward-compatibility shims, no `// legacy` code paths, no supporting both old and new config formats. The previous phase's code served its purpose — refactor it properly for the new phase. Keeping dead paths around makes the code confusing and harder to evolve.
- **Validate the happy path before hardening**: Get the core flow working end-to-end first. Add error handling, edge cases, timeouts, and retry logic in a second pass. A working but fragile feature tells you more about the right design than a robust one that handles every edge case but doesn't work yet.
- **Check OpenClaw before inventing**: When designing a new feature (message queuing, session management, scheduling, delivery semantics), check how OpenClaw solved it first. Not to copy blindly — OpenClaw is more complex than we need — but to learn from their failure modes and edge cases. Focus on the *why* behind their patterns, not the *how* of their implementation.

NOTE: Do NOT read `DEVLOG.md` as a development reference. It is a write-only log of critical learnings used later for content creation — not a source of context, decisions, or implementation details.
