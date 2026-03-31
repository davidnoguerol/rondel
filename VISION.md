# Vision: Multi-Agent Orchestration

> This document describes where Rondel is headed — not what's being built right now. It captures design thinking, research findings, and architectural patterns that future phases will draw from. Read this for the big picture. Read the phase-specific plans for what's actually being built.

---

## The Layers

Everything stacks. Each layer depends on the ones below it.

```
Layer 4:  Declarative Workflows (YAML pipelines, human gates, parallel execution)
Layer 3:  Self-Evolution (agents observe, learn, improve each other)
Layer 2:  Inter-Agent Messaging ✅ (agents talk to each other)
Layer 1:  Conversation Ledger ✅ (structured, queryable record of all activity)
Layer 0:  Current Rondel (agents, subagents, orgs, cron, MCP tools)
```

**Why this order:**
- You can't build self-evolution (Layer 3) without observability (Layer 1) — can't improve what you can't see.
- You can't build workflows (Layer 4) without messaging (Layer 2) — workflow steps are messages to agents.
- The ledger is the nervous system. Messaging is the circulatory system. Everything else is built on top.

---

## Layer 1: Conversation Ledger

> **Status:** Implemented. See [ARCHITECTURE.md Section 11](../../ARCHITECTURE.md) for full details.

### What Was Built

A structured, append-only JSONL event log per agent at `state/ledger/{agentName}.jsonl`. The `LedgerWriter` subscribes to all `RondelHooks` events and appends business-level entries (summaries, not full content). Queryable by agents via `rondel_ledger_query` MCP tool with filtering by agent, time range, event kinds, and result limit.

### Event Kinds (13 implemented)

`user_message`, `agent_response`, `inter_agent_sent`, `inter_agent_received`, `subagent_spawned`, `subagent_result`, `cron_completed`, `cron_failed`, `session_start`, `session_resumed`, `session_reset`, `crash`, `halt`.

Tool call events were deferred — add when a Layer 3 scenario concretely needs them. Future phases add more event kinds (workflow step completion, approval events, self-improvement actions) without changing the ledger infrastructure.

### Key Properties

- **Append-only JSONL** — one file per agent, immutable once written
- **Standardized event schema** — every event has the same shape (`ts`, `agent`, `kind`, `chatId?`, `summary`, `detail?`)
- **Summaries, not content** — user messages truncated to 100 chars, inter-agent to 80 chars. Full content lives in transcripts.
- **Queryable via MCP tool** — `rondel_ledger_query` with `agent?`, `since?` (relative or ISO 8601), `kinds?`, `limit?`
- **Emitted via hooks** — the LedgerWriter is decoupled from event sources. 7 new hooks added (conversation + session lifecycle), existing hooks (subagent, cron, messaging) also feed the ledger.
- **Subsumes `messages.jsonl`** — inter-agent events now go to per-agent ledger files. The old global file is no longer written.

### What's Not Yet Built

- **Visibility controls** — all agents can currently query all ledgers. Org-scoped visibility (reusing existing `checkOrgIsolation()`) is a follow-up.
- **Retention/rotation** — files grow unbounded. Daily rotation with configurable retention will be added when data volumes warrant it.

---

## Layer 2: Inter-Agent Messaging

> **Status:** Implemented. See [ARCHITECTURE.md Section 5b](../../ARCHITECTURE.md) for full details.

### What Was Built

Top-level agents send async messages to each other via `rondel_send_message` MCP tool. Each agent gets a synthetic "agent-mail" conversation — a separate Claude CLI process isolated from user chats. Responses are automatically routed back to the sender's original conversation by the Router.

### Delivery Model

**Push-based from day one.** We skipped the pull-based phase because `sendOrQueue` already provided the push primitive. Messages flow: Bridge HTTP → Router → `sendOrQueue()` → agent-mail process stdin. No polling, no delay.

**Disk-backed inboxes** at `state/inboxes/{agent}.json` provide durability. Messages are written to disk before delivery and removed after. Undelivered messages are recovered on startup. The inbox is a safety net — the push path handles 99% of delivery.

### 1-Turn Request-Response

Multi-turn ping-pong was deferred to Layer 4 (workflows). For Layer 2, every exchange is 1-turn: Agent A sends → Agent B responds → reply delivered back to A. Thread IDs exist as type seams (`threadId`, `turnNumber`, `maxTurns` on `InterAgentMessage`) but are unused.

**Why this is enough:** Agents have persistent context via `--resume`. If Kai sends a follow-up to Atlas, Atlas's context window already contains the previous exchange. The context window IS the thread.

### Org Isolation

Same-org messaging: always allowed. Cross-org messaging: blocked by default. Global agents (no org): unrestricted. Enforced at the Bridge layer before delivery. Cross-org `allowedPairs` config is a future addition.

### Observability

All sends and replies are logged to `state/messages.jsonl` as structured JSONL events. Hooks: `message:sent` (on send), `message:delivered` (after delivery), `message:reply` (when response routes back to sender).

### Large Artifacts

Agents write documents, drafts, and other large content to a shared drive folder (`{org}/shared/drive/`) and reference the file path in their message. This is a convention taught via skills — no framework-level artifact management.

---

## Layer 3: Self-Evolution

### The Vision

A system where agents observe, learn from, and improve each other autonomously. The "self-evolving organism."

### Reference Scenario

Agent A repeatedly hands off work to Agent B. Agent B always comes back with the same feedback ("missing SEO keywords"). Agent C (a monitor) notices this pattern by reading the ledger, understands that Agent A's instructions never mention SEO, and updates Agent A's config to include SEO requirements.

### How It Works

1. **Monitor agent** runs on a cron schedule (e.g., every 6 hours)
2. Queries the ledger for patterns: repeated feedback loops, error patterns, slow responses
3. Reads relevant agents' configs and skills
4. Proposes or applies improvements (if admin)

No new infrastructure needed beyond Layers 1 + 2. The monitor agent uses existing tools (`flowclaw_ledger_query`, `flowclaw_update_agent`, `flowclaw_system_status`). The ledger is the enabler.

### Patterns from Research

**The retraining loop** (most production-ready pattern):
```
Baseline Agent → Multiple Graders → Pass/Fail → Metaprompt Optimizer → Improved Prompt → Re-evaluate
```
- Versioned prompts with rollback capability
- Multiple evaluation metrics (not just one grader)
- Max retry limits before escalating to human
- Maps to Rondel's skill system — skills could be versioned, evaluated, optimized

**What to evolve:**
- Context (memory + prompts) — lowest hanging fruit, no model fine-tuning needed
- Tools (discovery/creation) — agents learn to use new MCP tools more effectively
- Architecture (topology) — which agents collaborate on what, team composition

**Memory evolution:**
- Decay mechanisms (memories lose relevance without reinforcement)
- Self-evaluation loops (agent reviews stored knowledge for accuracy)
- Pattern recognition across temporal data (time-series of recurring sequences)
- ADD/MERGE/DELETE operations (not just append)

### Guardrails

- Human approval for high-impact changes (modifying another agent's core identity)
- Rollback capability (versioned configs)
- Max improvement attempts before escalating
- Periodic manual audits of self-applied changes
- Conservative acceptance thresholds

---

## Layer 4: Declarative Workflows

### The Vision

YAML files that define multi-agent pipelines. A workflow engine parses them into step sequences, manages state, handles parallelism and human gates.

### Reference Workflow: Feature Build Pipeline

```yaml
name: build-feature
org: acme
worktree: true

inputs:
  feature_description: string

steps:
  - id: prd
    agent: pm
    task: "Write a PRD for: {{feature_description}}"
    output: prd.md
    approval: human

  - id: architecture
    agent: architect
    task: "Create architecture based on PRD"
    inputs: [prd.md]
    output: architecture.md

  - id: architecture-review
    agent: architect
    role: reviewer                    # Same identity, stripped context
    task: "Review this architecture plan. Be critical."
    inputs: [prd.md, architecture.md]
    output: review-feedback.md

  - id: architecture-revise
    agent: architect
    task: "Revise based on review feedback"
    inputs: [architecture.md, review-feedback.md]
    output: architecture-final.md
    approval: human

  - id: implement
    parallel:
      - id: code
        agent: developer
        task: "Implement the feature"
        inputs: [prd.md, architecture-final.md]
        output: code-summary.md
      - id: tests
        agent: qa
        task: "Write tests for the feature"
        inputs: [prd.md, architecture-final.md]
        output: test-summary.md

  - id: review
    agent: architect
    role: reviewer
    task: "Review code and tests against architecture"
    inputs: [architecture-final.md, code-summary.md, test-summary.md]
    output: review-result.md

  - id: test
    agent: tester
    task: "Open browser and test the application"
    inputs: [prd.md, code-summary.md, test-summary.md]
    output: test-results.md
    onFail: { goto: code }
```

### Key Concepts

#### Agent Identity vs Instance

An agent identity is the template — AGENT.md, SOUL.md, skills, personality. An agent instance is a running process doing a specific job.

Today, Rondel ties these together: one agent = one directory = one bot. Workflows need to separate them:

| Concept | Has Telegram? | Lifespan | Context |
|---------|--------------|----------|---------|
| Persistent agent | Yes (ongoing human relationship) | Forever | Full (MEMORY.md, USER.md, etc.) |
| Workflow instance | No (internal only) | Duration of workflow run | Stripped (only workflow artifacts + identity) |

A workflow step like `agent: architect, role: reviewer` means: "spawn a process with the architect's identity (skills, personality) but ONLY give it the workflow artifacts as context — no MEMORY.md, no creation bias, no Telegram."

This is an evolution of what subagents already do (same template, stripped context, ephemeral process). The difference is workflow instances may need multiple turns within a step, not just one-shot execution.

#### Artifact Store

Each workflow run gets its own folder for accumulated outputs:

```
state/workflows/{run-id}/
  run.json              # Workflow state machine (current step, completions, pending)
  definition.yaml       # Snapshot of the workflow definition
  artifacts/
    prd.md              # PM's output
    architecture.md     # Architect's output
    review-feedback.md  # Reviewer's output
    ...
```

Each step reads artifacts from previous steps and writes its own. The workflow engine manages this — agents just read/write files in their working directory.

#### Git Worktrees for Parallel Features

When running multiple workflows on the same repo simultaneously (3 features at once), each workflow run gets its own git worktree:

```
state/workflows/
├── run-auth-a1b2c3/
│   └── worktree/ → /repo-worktree-a1b2c3     # isolated branch
├── run-payments-d4e5f6/
│   └── worktree/ → /repo-worktree-d4e5f6     # isolated branch
└── run-dashboard-g7h8i9/
    └── worktree/ → /repo-worktree-g7h8i9     # isolated branch
```

Same agent identities used across all three. Different instances, completely isolated code and artifacts.

#### Parallel Execution (Fan-Out + Join)

Workflow engine sends work to N agents simultaneously. Each works independently. Workflow advances when ALL N agents report completion.

The state machine tracks:
```json
{
  "implement": {
    "status": "running",
    "parallel": {
      "code":  { "status": "completed", "agent": "developer" },
      "tests": { "status": "running",   "agent": "qa" }
    }
  }
}
```

#### Human Approval Gates

Workflow pauses. Notification goes to a channel (Telegram group, DM). Human responds (approve / give feedback). If feedback → loops back to the relevant agent. If approved → workflow continues.

The mechanism: workflow state persists to disk, a message goes to the human's channel, and when the human responds, the workflow engine reads the response and advances.

#### Channel Per Workflow (War Room)

Each workflow run can have its own Telegram group or Slack channel where the human sees progress updates. Agents post summaries, approval requests surface there, and the human can intervene at any point.

The human sees a clean stream:
```
🔵 PM: PRD draft ready for review.
👤 You: Approved
🔵 Architect: Researching API patterns...
🔵 Architect: Architecture plan ready. Sending to review.
🔵 Reviewer: Review complete. 2 suggestions incorporated.
🔵 Architect: Final plan ready.
⏸️  Waiting for approval to proceed to implementation.
```

Agent-to-agent full conversations live in the ledger, not the war room.

#### Squad Replication

The same "squad" (PM + Architect + Dev + QA + Tester) can run multiple features concurrently. Each workflow run instantiates the squad independently. No shared state between runs.

---

## Mechanisms Summary

| Mechanism | Which Layer | Description |
|-----------|------------|-------------|
| Conversation Ledger | L1 | ✅ Per-agent JSONL event log, 13 event kinds, queryable via `rondel_ledger_query` MCP tool |
| Ledger visibility controls | L1 | self / org / all — what an agent can observe (not yet implemented — all agents can query all ledgers) |
| Inter-agent messaging | L2 | ✅ Push-based delivery, file-backed inbox, org isolation, observability log |
| Ping-pong with turn limits | L4 | Bounded multi-turn agent conversations (deferred — 1-turn sufficient for L2) |
| Thread continuity | L2 | ✅ Context accumulates naturally via agent-mail session `--resume` |
| Monitor agent + ledger queries | L3 | Pattern detection across agent interactions |
| Versioned prompt optimization | L3 | Retraining loop with rollback |
| Workflow state machine | L4 | YAML → step graph → execution tracking |
| Artifact store | L4 | Shared folder per workflow run |
| Agent identity vs instance | L4 | Same identity, different context per workflow step |
| Git worktrees | L4 | Parallel feature development isolation |
| Fan-out + join | L4 | Parallel steps with sync barrier |
| Human approval gates | L4 | Pause workflow, notify human, resume on response |
| Channel per workflow | L4 | War room for workflow progress visibility |
| Squad replication | L4 | Same roles, multiple concurrent workflows |

---

## Research Sources

### Industry
- [Survey of Self-Evolving Agents](https://arxiv.org/html/2507.21046v4) — taxonomy of what/when/how to evolve
- [OpenAI Self-Evolving Agents Cookbook](https://developers.openai.com/cookbook/examples/partners/self_evolving_agents/autonomous_agent_retraining) — production retraining loop
- [AgentOps: Enabling Observability](https://arxiv.org/html/2411.05285v2) — hierarchical span model
- [MetaGPT: structured document communication](https://www.ibm.com/think/topics/metagpt) — blackboard pattern
- [LangGraph vs CrewAI vs AutoGen](https://o-mega.ai/articles/langgraph-vs-crewai-vs-autogen-top-10-agent-frameworks-2026) — framework comparison
- [Cloudflare Human-in-the-Loop Patterns](https://developers.cloudflare.com/agents/guides/human-in-the-loop/)
- [Multi-Agent Communication Survey](https://arxiv.org/html/2502.14321v1)

### OpenClaw Reference
- Inter-agent: `sessions_send` with allow-lists, ping-pong max 5 turns, `REPLY_SKIP` early exit
- Observability: JSONL transcripts, web dashboard, session visibility (`self`/`tree`/`agent`/`all`)
- Workflow: No built-in engine. Lobster as optional external tool with approval gates.

### Anthropic
- "Building Effective Agents" — workflow vs agent distinction, composable patterns
- "Multi-Agent Research System" — lead + subagent architecture, file-based artifact passing
- "Effective Harnesses for Long-Running Agents" — structured progress, session handoffs
