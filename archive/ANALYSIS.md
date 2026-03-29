# Rondel — Architecture Analysis

## Viability: Yes, strongly viable

The plan is well-grounded for several reasons:

1. **It builds on proven primitives.** Claude CLI's `--input-format stream-json` / `--output-format stream-json` is the official programmatic interface. Using `child_process.spawn()` with bidirectional JSON pipes is the correct, supported way to manage persistent Claude processes from Node.js. This isn't a hack.

2. **The scope is right-sized for an MVP.** The doc doesn't try to rebuild OpenClaw. It picks the ~15 features that matter for a multi-agent orchestrator and leaves the rest for v2+. The 4-week phased plan is realistic because each phase has a concrete, testable deliverable.

3. **The external dependency surface is minimal.** Node.js, the `claude` CLI, and the Telegram Bot API. No database, no Redis, no message broker. This means fewer failure modes and simpler deployment.

## Cleanliness & Maintainability: Very good

### Strengths

- **Clear module boundaries.** The `src/` layout maps 1:1 to the architecture diagram. Each subsystem (agents, channels, bus, routing, mcp, scheduler) is its own directory with focused responsibilities. No god-module.

- **The three-layer context model is elegant.** Global + Org + Agent is simple to reason about, simple to implement (concatenate markdown files), and matches how people actually organize multi-project work. The fact that orgs are optional and the system degrades gracefully to a flat structure is well-designed.

- **MCP for tool injection is the right call.** It's structured, typed, extensible, and standard. Compared to `--append-system-prompt` (which shoves tool descriptions into text), MCP gives Claude proper tool schemas. Adding new Rondel tools later means adding a handler, not rewriting prompt text.

- **File-based state with atomic writes.** The `inbox/ -> inflight/ -> processed/` pattern is a lightweight, battle-tested queue. Atomic rename for writes prevents corruption. This is the same pattern that email MTAs, spool directories, and OpenClaw itself use successfully.

- **The ChannelAdapter interface is clean.** Simple contract: connect/disconnect/send/receive. Easy to implement for Slack, WhatsApp, or a WebSocket-based Web UI later.

### Minor concerns

- **MCP server per agent process.** Each agent's `--mcp-config` spawns a separate MCP server child process. With 10 agents, that's 10 MCP server processes + 10 Claude processes = 20 child processes. This is fine for typical use, but worth noting in docs. Consider whether one shared MCP server with agent-ID-scoped requests would be cleaner (though per-agent isolation is simpler to reason about for org boundaries).

- **Inbox polling at 5s intervals.** This is fine for MVP, but inter-agent messages will have 0-5s latency. If agents need tighter coordination, consider `fs.watch` or a lightweight event emitter within the Node process (since the MCP server already runs in the same Rondel core process and can signal the inbox poller directly).

## Future-proofness: Strong

This is where Rondel's design really shines when compared against OpenClaw's architecture:

1. **Channel adapters are a clean extension point.** The `ChannelAdapter` interface is minimal enough that adding Slack, WhatsApp, or a Web UI requires zero changes to the core. OpenClaw has 17+ channel plugins; Rondel's interface is a simplified version of the same pattern. The doc correctly identifies that a Web UI is "just another channel adapter" — this is true and means the architecture doesn't need to change.

2. **The org layer scales naturally.** Adding more orgs is just adding directories. Cross-org communication is opt-in with explicit allowlists. This maps well to real-world use cases (agency managing multiple clients, developer with multiple projects).

3. **The binding system is borrowed from OpenClaw and proven.** OpenClaw's routing system (bindings matching on channel/peer/account/guild/team) has been battle-tested across 17+ channels. Rondel's simplified version (channel/bot/command/chatType) covers the Telegram use case perfectly and leaves room to grow into OpenClaw's full matching power when more channels are added.

4. **MCP tools are trivially extensible.** Need a new capability? Add a tool handler to the MCP server. The agent gets it automatically at next spawn. No prompt engineering needed.

5. **The scheduler avoids Claude CLI's `/loop` limitations.** This is a good architectural decision. Node-native scheduling survives agent restarts and supports cron expressions — much more robust than relying on the CLI's built-in loop.

## Where Rondel diverges from OpenClaw (and why that's correct)

| Aspect | OpenClaw | Rondel | Verdict |
|--------|----------|----------|---------|
| AI backend | Embedded Pi agent (in-process model calls) | External Claude CLI processes | Correct — Claude CLI handles model auth, context, tools natively |
| Plugin system | 81 plugins, full SDK, manifest registry | No plugin system in v1, interfaces ready | Right call — plugin systems are expensive to get right, interfaces are enough for now |
| Config | JSON5 with $include, multi-stage pipeline, hot reload | JSON with env vars, simple loading | Appropriate for scope |
| Channel complexity | ~15 adapter interfaces per channel | 5-method ChannelAdapter | Right level of abstraction for a framework that ships one channel |
| Process model | Single gateway process with embedded agent runner | One Node process + N Claude child processes | Correct trade-off — process isolation gives crash recovery and resource isolation for free |

## Risks to watch

1. **System prompt size limits.** Concatenating Global + Org + Agent markdown plus skill definitions could get large. The doc doesn't mention token budgets for system prompts. Consider adding a validation step that warns if the assembled prompt exceeds a threshold.

2. **Session bloat over time.** The 71h refresh interval is a good default, but long-running agents with many turns will accumulate context. Consider documenting how Claude CLI's session management interacts with Rondel's session refresh.

3. **`--dangerously-skip-permissions` in production.** The doc uses this flag everywhere. It's necessary for autonomous agents but should be prominently documented as a security consideration, especially for agents with `Bash` tool access to arbitrary working directories.

4. **No graceful drain on shutdown.** The doc covers crash recovery but doesn't detail what happens to in-flight turns when Rondel receives SIGTERM. Consider: wait for active turns to complete (with timeout), then kill child processes.

## Bottom line

This is a well-designed, well-scoped framework. The architecture is clean, the extension points are in the right places, and the design decisions are justified by concrete rationale. It borrows the right patterns from OpenClaw (bindings, file-based state, channel adapters, multi-agent routing) without inheriting unnecessary complexity (81 plugins, embedded model runner, multi-provider auth). It's viable, maintainable, and future-proof for the stated goals of expanding channels, adding a Web UI, YAML workflows, and a plugin system.
