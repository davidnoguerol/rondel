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
- **Organizations**: Optional grouping layer marked by `org.json` (auto-discovered like `agent.json`). Agents within an org get org-specific shared context (`{org}/shared/CONTEXT.md`) injected between global and per-agent context. `org.json` carries `orgName`, optional `displayName`, and `enabled` flag. Nested orgs are disallowed. Cross-org communication is disabled by default (future constraint — no inter-agent messaging exists yet).
- **Context composition**: System prompts are assembled in layers: `workspaces/global/CONTEXT.md` → `{org}/shared/CONTEXT.md` (if agent belongs to an org) → per-agent files (`AGENT.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`, `MEMORY.md`, `BOOTSTRAP.md`). Each bootstrap file is prefixed with a `# filename` heading. USER.md has a fallback chain: agent's own → `{org}/shared/USER.md` → `global/USER.md`. Falls back to legacy `SYSTEM.md` if no bootstrap files exist. Subagent/cron contexts strip `MEMORY.md`, `USER.md`, and `BOOTSTRAP.md`.
- **Agent memory**: Persistent knowledge stored in the agent's directory as `MEMORY.md`. Agents read/write via MCP tools (`rondel_memory_read`, `rondel_memory_save`). Survives session resets, restarts, and context compaction. Included in system prompt on every spawn (main sessions only).
- **Admin tool scoping**: Agents with `admin: true` in agent.json get admin MCP tools (add agent, update config, set env, reload). Non-admin agents only get `rondel_system_status` (read-only). The first agent created by `rondel init` is admin by default. Agents created via `rondel_add_agent` are non-admin by default. Follows OpenClaw's `ownerOnly` pattern — privilege is orthogonal to agent identity.
- **Runtime agent hot-add**: Admin agents can create new agents at runtime via `rondel_add_agent`. The bridge scaffolds the directory, loads config, registers the Telegram bot, and starts polling — no restart needed. Discovery is recursive filesystem scan, so agents can be placed in any `workspaces/` subdirectory (including org-specific paths).
- **Skills (on-demand instructions)**: Agents learn HOW to do things via Claude Code native skills. Framework skills ship at `templates/framework-skills/.claude/skills/` and are injected via `--add-dir` at spawn time — always current from source, never copied. Per-agent skills live at `<agentDir>/.claude/skills/` (user's space). Skills ≠ permissions: skills are informational, admin gating is at the MCP tool layer. AGENT.md holds behavioral rules only (Tool Call Style, Safety, Memory, Red Lines); operational workflows live in skills.
- **First-run bootstrap**: New agents include a `BOOTSTRAP.md` file that triggers a one-time onboarding ritual on the agent's first conversation. The agent asks the user about preferences and saves answers to `USER.md`/`SOUL.md`. The file is deleted after completion and never recreated.
- **Inter-agent communication**: File-based message bus with org isolation enforced at the bus level.
- **Per-conversation isolation**: Each unique `(agentName, chatId)` pair gets its own Claude CLI process with its own session. Agent config is a *template* — no processes exist until a conversation starts. Three users messaging the same bot = three independent processes. This is a correctness invariant, not an optimization. Never share a process across conversations.
- **Block streaming**: Text blocks are emitted immediately as `assistant` events arrive — not buffered until turn end. The user sees intermediate messages ("Creating agent...") while tools run. Each block fires a `response` event sent to Telegram independently.
- **Session identity vs. session state**: The conversation key (`agentName:chatId`) is permanent and used for routing. The session ID is mutable — it rotates on `/new` and can be replaced without changing the routing key. Don't conflate these. The key tells you *which* conversation; the session ID tells you *which context window*.
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
- **One writer per conversation at a time**: A conversation is a serial execution context. Never send a second message to an agent process that's already busy — queue it and drain on idle. This is a correctness invariant (not just a Claude CLI limitation). The `sendOrQueue` pattern is the canonical approach for any internal message injection (subagent results, cron delivery, inter-agent messages).
- **Channel adapters own their protocol quirks**: Message chunking, typing indicators, markdown flavor, media constraints, rate limits — these all belong inside the adapter, not in the router or agent manager. The router sends text; the adapter decides how to deliver it within the channel's constraints.
- **Inbound normalization, outbound adaptation**: Messages entering the system get normalized to `ChannelMessage` at the adapter boundary. Messages leaving get adapted (chunking, markdown, typing indicators) at the adapter boundary. The core never thinks in channel-specific terms.

### Error Handling Patterns

- **Classify errors as transient or permanent at the point of failure**: Transient errors (rate limits, network timeouts, 5xx responses, process crashes) are retryable. Permanent errors (bad config, auth rejected, invalid input, process halted after crash limit) are not. Every error path should make this distinction explicit — it determines whether the system retries, backs off, or gives up.
- **Backoff strategy follows the job type**: One-shot operations (subagent runs, webhook deliveries) retry a fixed number of times with increasing delays, then fail permanently. Recurring operations (cron jobs, polling loops) use exponential backoff but stay enabled — backoff resets on the next success. Never apply the same retry logic to both.
- **Degrade gracefully on non-critical failures**: If a delivery fails but the core operation succeeded, log and continue — don't fail the whole operation. Use `.catch(() => {})` for side-effects like notifications and transcript writes. The agent's work matters more than the notification about it.

### Lifecycle and State

- **State files need maintenance policies**: Every persistent file (sessions.json, cron-state.json, transcripts) should have a defined retention strategy — even if it's just "grows forever for now, prune later." Document the expectation in ARCHITECTURE.md when adding new state files.
- **Config hot-reload must classify changes**: Not all config changes are safe to apply at runtime. When adding a new config field, explicitly decide: is it hot-reloadable (cron schedules, model preferences) or restart-required (process spawning parameters, server ports)? Applying a restart-required change at runtime is worse than not reloading at all.

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

### Project Structure

Rondel has two distinct directory structures: the **source code** (this repository) and the **installation** (`~/.rondel/`, created by `rondel init`).

#### Source code (this repository)

```
rondel/                        # Source repository
├── CLAUDE.md                    # This file — coding standards, conventions
├── ARCHITECTURE.md              # Current architecture as built (living doc)
├── DEVLOG.md                    # Development log — decisions, progress
├── RONDEL-PLAN.md             # North star architectural vision
├── README.md                    # User-facing getting started guide
├── package.json                 # Dependencies, scripts, bin field
├── tsconfig.json                # TypeScript config
│
├── templates/
│   ├── context/                 # Agent bootstrap file templates (AGENT.md, SOUL.md, etc.)
│   └── framework-skills/        # Framework skills (injected via --add-dir at spawn)
│       └── .claude/skills/      # rondel-create-agent, rondel-delegation, rondel-manage-config
│
└── src/                         # Source code (domain-organized)
    ├── index.ts                 # Orchestrator entry — exports startOrchestrator()
    ├── cli/                     # CLI commands (init, add agent/org, stop, restart, logs, status, doctor, service)
    ├── agents/                  # Agent process lifecycle (spawn, crash, resume, track)
    ├── bridge/                  # IPC between Rondel core and MCP server processes
    ├── channels/                # Channel abstraction + implementations (Telegram, future)
    ├── config/                  # Config loading, agent discovery, system prompt assembly
    ├── routing/                 # Inbound message flow: channel → agent
    ├── scheduling/              # Timer-driven cron execution
    ├── shared/                  # Cross-cutting: types, logger, hooks, utilities
    └── system/                  # Process-level concerns (instance lock, OS service management)
```

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
├── templates/                   # Subagent blueprints (framework-level)
│   └── {name}/                  # SYSTEM.md, agent.json
│
└── state/                       # Runtime ephemera (NOT committed)
    ├── sessions.json            # Session index
    ├── cron-state.json          # Cron job state
    ├── rondel.lock            # Instance lock + bridge URL + log path
    ├── rondel.log             # Daemon log output (rotated at 10MB)
    └── transcripts/             # JSONL conversation history
```

**Key separation:** `workspaces/` is the user's domain — agents, identity, memory, shared knowledge. This is what gets committed to git. `state/` is runtime ephemera that Rondel manages — never committed.

**Discovery:** Rondel recursively scans `workspaces/` for directories containing `org.json` (organizations) and `agent.json` (agents) in a single pass. `orgName` and `agentName` fields are the unique identifiers — duplicates produce startup errors. The filesystem is the source of truth; no explicit lists in config. `enabled: false` in either file disables it (a disabled org skips its entire agent subtree). Agents found under an org's directory tree are automatically associated with that org.

#### Source code organization

**`src/` is organized by domain, not by layer.** The question is: *"If I'm working on feature X, which directory do I open?"*

**Mental model for where things go:**

- **Is it a user-facing command?** → `cli/`
- **Would a new channel adapter need this?** → `channels/`
- **Is it about spawning, crashing, or managing a Claude process?** → `agents/`
- **Is it about when things run on a timer?** → `scheduling/`
- **Is it about getting a message from point A to point B?** → `routing/`
- **Does every module import it?** → `shared/`
- **Is it about how Rondel talks to its own child processes?** → `bridge/`

**Rules for this structure:**

- **Each directory has a barrel `index.ts`** that re-exports the public API. External consumers import from the directory (`../agents`), not from internal files (`../agents/agent-process`). Internal files within a directory import each other directly (`./agent-process`).
- **Organize by domain, not by type.** Don't create `interfaces/`, `utils/`, or `models/` directories. A type used only by scheduling lives in `scheduling/`, not in a global `types/` folder. Only truly cross-cutting types belong in `shared/types.ts`.
- **New files go in the directory they belong to.** If a new file doesn't fit any existing directory and you can't justify a new one, it probably belongs in `shared/` or the file's responsibilities need rethinking.
- **New directories need justification.** Don't create a directory for a single file unless you're confident it will grow. A directory is a commitment to a domain boundary. If the domain doesn't exist yet, the file lives in the closest neighbor until it does.
- **Dependencies flow inward.** `shared/` depends on nothing. Domain directories depend on `shared/` and occasionally on each other. `index.ts` depends on everything. If you find `shared/` importing from a domain directory, the boundary is wrong — move the shared piece down or rethink the dependency.
- **No circular dependencies between directories.** If `agents/` imports from `scheduling/` and `scheduling/` imports from `agents/`, extract the shared concern into `shared/` or rethink the boundary. Use `type` imports where possible to break compile-time cycles.

**Knowledge base policy:** Root holds only living documents you actively reference during development. Don't add new markdown files to the root unless they'll be actively maintained.

---

## Key Documents

- **[ARCHITECTURE.md](ARCHITECTURE.md)** — Current architecture as built. Component map, message flows, process model, MCP injection, and key interfaces. Describes what exists in code right now — not the plan.
- **[RONDEL-PLAN.md](RONDEL-PLAN.md)** — The north star. Full architectural vision for where Rondel is headed. Use this as a reference for the end-state design, but don't implement it top-down. Build incrementally and let the plan guide direction, not dictate every detail.
- **[DEVLOG.md](DEVLOG.md)** — Living development log. Tracks what we've built, what worked, what didn't, decisions made and why, and discoveries along the way. Updated as we go. This is the ground truth for where the project actually is vs. where the plan says it should be.
- **[CLI-REFERENCE.md](CLI-REFERENCE.md)** — Claude CLI flags, stream-json protocol, MCP config format, and environment variables relevant to Rondel. Read this before modifying agent process spawning or adding new CLI flags.
- **[OPENCLAW-INDEX.md](OPENCLAW-INDEX.md)** — The reference implementation we draw architectural patterns from. IMPORTANT: when designing a new Rondel feature, check how OpenClaw solved the same problem before inventing from scratch.

---

## Development Approach

- **Iterate, don't waterfall**: Build the simplest working version of a feature, validate it works, then improve. Don't try to build the "final" version on the first pass.
- **Keep the system runnable**: Every change should leave the system in a working state. If a refactor is large, do it incrementally.
- **When in doubt, keep it simple**: If you're debating between a simple approach and a sophisticated one, start with simple. We can always add complexity — removing it is harder.
- **Clean breaks between phases**: When a phase is validated and we move to the next, fully replace the old approach. No backward-compatibility shims, no `// legacy` code paths, no supporting both old and new config formats. The previous phase's code served its purpose — refactor it properly for the new phase. Keeping dead paths around makes the code confusing and harder to evolve.
- **Validate the happy path before hardening**: Get the core flow working end-to-end first. Add error handling, edge cases, timeouts, and retry logic in a second pass. A working but fragile feature tells you more about the right design than a robust one that handles every edge case but doesn't work yet.
- **Check OpenClaw before inventing**: When designing a new feature (message queuing, session management, scheduling, delivery semantics), check how OpenClaw solved it first. Not to copy blindly — OpenClaw is more complex than we need — but to learn from their failure modes and edge cases. Focus on the *why* behind their patterns, not the *how* of their implementation.
