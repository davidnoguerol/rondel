# Phase 4 Kickoff — Async Priority Inbox for Inter-Agent Messaging

## Your job in this chat

Design the **async priority inbox** enhancement for inter-agent messaging in Rondel, to spec-level quality, following our modularity contract. **Do not implement it.** Produce a design document I can review, iterate on, and then hand to a future implementation chat.

---

## Context

### Rondel, in one paragraph
Rondel is a multi-agent orchestration framework built on the Claude CLI. The long-term vision is an **agentic self-evolving harness** that manages real operations. Inter-agent messaging already exists today via `rondel_send_message`, but it is 1-turn request/response only — the sender waits inline for a reply. For Phase 4 we extend it to support async, priority-ordered, fire-and-forget delivery with at-least-once semantics and on-wake-up draining.

### What Phase 4 is
Phase 4 is polish — async messaging, auto-commit, anything else useful after the substrate is solid. Each item is independently valuable but not critical for the core vision. See [`docs/GAP-ANALYSIS-CORTEXTOS.md`](../GAP-ANALYSIS-CORTEXTOS.md) section 8.

### This item — Priority inbox
Today's `rondel_send_message` is great for Q&A ("hey specialist, what's your status?") but awkward for bursts ("here are 5 tasks to pick up overnight") and impossible for fire-and-forget ("FYI the goal changed"). The priority inbox adds: (1) priority levels (`urgent` / `normal` / `low`), (2) an `expect_reply: false` option (sender returns immediately), (3) per-agent inbox drain semantics — agents sweep their inbox on heartbeat and process queued messages, (4) at-least-once delivery with inflight-recovery for crash resilience. CortexOS has a file-based inbox in `inbox/{agent}/` with FIFO-by-priority, HMAC signing, and 5-minute inflight-recovery; we'll study it carefully.

### Dependencies
Phase 1 items 1, 2 (heartbeat is the drain trigger; tasks often get delivered via inbox).

### Files to read if you need depth
- `CLAUDE.md`
- `docs/GAP-ANALYSIS-CORTEXTOS.md` — section 8
- `apps/daemon/src/messaging/` and `apps/daemon/src/routing/` in Rondel

---

## Step 1 — Parallel research (dispatch two subagents)

### Subagent A — OpenClaw
**Path**: `/Users/david/Code/openclaw`
**Focus**: does OpenClaw have inter-agent messaging beyond spawn/return? Any queue semantics? Priority? Async delivery? Fan-out? How does one agent tell another something without waiting for a response? Dead-letter handling? HMAC / signing?

### Subagent B — CortexOS
**Path**: `/Users/david/Code/cortextos`
**Focus**: map the file-based inbox. Key files: `src/bus/message.ts` (sendMessage, checkInbox), `bus/send-message.sh`, `bus/check-inbox.sh`, `bus/ack-inbox.sh`. Cover: file-name format (`{pnum}-{epoch}-from-{sender}-{rand}.json`), priority encoding, FIFO ordering, inflight directory semantics (5-minute recovery), ACK flow (inbox → inflight → processed), HMAC signing (key location, verification, failure mode), reply_to field for threading, how FastChecker polls at 1 Hz, injection format when a message hits the agent.

### Shared output schema

```
## 1. Concept presence
Yes / Partial / No — 1-sentence summary

## 2. Delivery model
- Sync / async / both
- Priority levels
- Ordering guarantees
- At-most-once / at-least-once / exactly-once

## 3. Data model
- On-disk / in-memory / both
- File-name format and why
- Schema per message
- Per-agent vs shared queue

## 4. State machine
- Transitions: pending → inflight → processed / failed / expired
- Timeouts per state
- Recovery / retry semantics

## 5. Security
- Signing / authentication
- Replay protection
- Cross-org isolation

## 6. Polling / push model
- How consumers wake up to messages
- Latency vs load trade-off

## 7. Reply / threading
- How reply_to links messages
- Multi-turn support

## 8. Integration points
- Heartbeat (drain trigger)
- Tasks (task dispatch via inbox)
- Approvals (decisions via inbox)

## 9. Strengths worth adopting for Rondel
## 10. Anti-patterns / not to copy
## 11. Key file paths (absolute)
```

---

## Step 2 — Rondel codebase research

1. **Current messaging** — `apps/daemon/src/messaging/` (InterAgentMessage types, inbox persistence), `apps/daemon/src/routing/` (Router, AgentMailReplyTo metadata, sendOrQueue pattern). Fully understand today's flow.
2. **`rondel_send_message` tool** — where it's defined, privilege model, org isolation.
3. **Agent-mail conversation** — CLAUDE.md describes the synthetic `agent-mail` conversation per recipient. The new async inbox needs to coexist with this without duplicating state.
4. **Queue semantics** — today's `sendOrQueue` pattern. Study before adding more queuing.
5. **Hooks** — how inbox events emit to the ledger.
6. **Heartbeat skill** — Phase 1. The drain step happens here.
7. **Bridge** — expose inbox read for web dashboard? Or strictly agent-consumed?
8. **Existing inbox directory** — `state/inboxes/{agentName}.json` — today's on-restart recovery file. Need to evolve or sit alongside.

---

## Step 3 — Synthesize the design

1. **Scope** — Phase 4: async + priority + drain-on-heartbeat + at-least-once. Defer: dead-letter queues, message TTL beyond inflight recovery, multi-tenant queues within an org, fan-out / pub-sub.
2. **Backwards compatibility** — today's synchronous `rondel_send_message` semantics must stay. New behavior is opt-in via a flag.
3. **Data model evolution** — today's state layout vs proposed. Migrate via store version or new directory alongside.
4. **API surface** — `rondel_send_message` gets new optional params: `priority: "urgent" | "normal" | "low"` (default `"normal"`), `expect_reply: boolean` (default `true` for backward compat). Schemas.
5. **New tools** — `rondel_inbox_list` (self-read), `rondel_inbox_drain` (heartbeat-skill invoked; processes pending), `rondel_inbox_ack` (mark processed). Schemas, privilege.
6. **Delivery semantics** — FIFO-by-priority, at-least-once, inflight-recovery window. Thresholds.
7. **HMAC signing** — do we add this? Rondel is single-host today; cross-host is not Phase 4. If yes: key location, rotation. If no: decision.
8. **Heartbeat drain step** — skill prose update. What the agent does when sweeping.
9. **Ledger events** — `message:sent`, `message:delivered`, `message:acked`, `message:recovered`, `message:expired`.
10. **Org isolation** — cross-org inbox writes continue to be blocked at the tool layer.
11. **Testing strategy** — unit (priority ordering, state machine), integration (crash mid-delivery + recover), end-to-end (burst of 10 messages delivered in priority order on drain).
12. **Migration** — existing in-flight messages on upgrade; default behavior unchanged for existing callers.
13. **Open questions** — HMAC yes/no for Phase 4, whether expect_reply=false should still appear in the thread ledger, whether drain yields multiple Claude turns or batches into one, inbox-visible-in-dashboard yes/no.

---

## Deliverable

Save to `docs/phase-4/01-priority-inbox-design.md`. Editable.

---

## Guardrails for this chat

- **Do not implement.** Design only.
- **Follow Rondel patterns** (CLAUDE.md).
- **Do not over-engineer.** No DLQ, no TTL, no pub-sub for Phase 4.
- **Backwards compatible by default** — callers who don't opt in keep the current behavior.
- **Flag every trade-off** — I'll decide.
- **Minimize this chat's context** — rely on subagents.
