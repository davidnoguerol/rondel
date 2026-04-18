# approvals

HITL (Human-In-The-Loop) approval service. See the "HITL Approvals" section
in the repo-root [ARCHITECTURE.md](../../../../ARCHITECTURE.md) for the full
design.

## Module layout

```
approvals/
├── types.ts                           — pure types, no runtime imports
├── approval-store.ts                  — file-backed pending/resolved persistence
├── approval-service.ts                — main service: request, resolve, recover
├── tool-summary.ts                    — pure Bash/Write/Edit/... summarizer
├── index.ts                           — barrel
├── tool-summary.unit.test.ts
├── approval-store.integration.test.ts
└── approval-service.integration.test.ts
```

After Phase 5 there is **no external PreToolUse hook**. Approval requests
originate from first-class Rondel MCP tools under
`apps/daemon/src/tools/` — each tool runs its own safety
classifier inline (from `shared/safety/`) and calls
`POST /approvals/tool-use` when it needs a human decision.

`AgentConfig.permissionMode` has also been removed; safety classification
is per-tool, not per-agent. Per-agent overrides (if we ever want them)
will be a separate schema change.

## Tool-use safety net (current)

```ts
// In the daemon orchestrator
const approvals = new ApprovalService({
  paths: { pendingDir, resolvedDir },
  hooks,
  channels,
  resolveAccountId: (agent, channelType) => /* look up accountId */,
  log,
});
await approvals.init();
await approvals.recoverPending();

// A rondel_* MCP tool POSTs here via the bridge when its classifier
// says "escalate":
const { requestId, decision } = await approvals.requestToolUse({
  agentName: "bot1",
  channelType: "telegram",
  chatId: "5948773741",
  toolName: "rondel_bash",
  toolInput: { command: "rm -rf /" },
  reason: "dangerous_bash",
});
// decision: Promise<"allow" | "deny"> — awaited by in-process callers,
// polled via GET /approvals/:id by the MCP tool process.
```

## Recovery

On daemon start, `recoverPending()` walks the `pending/` directory and
auto-denies any orphan records left by a crashed previous run. The in-memory
resolver map cannot survive a restart, so leaving orphans in `pending/`
would have them linger forever — we move them to `resolved/` with
`decision: "deny"` and `resolvedBy: "daemon-restart"`.

## Store layout

```
state/approvals/
├── pending/
│   └── appr_<epoch>_<hex>.json   — one file per in-flight request
└── resolved/
    └── appr_<epoch>_<hex>.json   — same shape, with decision/resolvedAt/resolvedBy
```

Atomic writes, no locking (single in-process writer). Path-traversal in
the `requestId` is rejected by a strict regex at the store boundary.

## SSE tail

`GET /approvals/tail` streams `approval.requested` / `approval.resolved`
frames to the web UI via `apps/daemon/src/streams/approval-stream.ts`.
Consumers use the existing `handleSseRequest` infrastructure — no custom
transport. See the ledger stream for the canonical pattern.

## Deferred work — grep `TODO(hitl-future):`

- Agent-initiated approvals via a `rondel_request_approval` MCP tool —
  same backend, new entry point that takes a free-text title/context
  from the agent and returns a Promise resolving to the operator's
  decision.
- Org-level activity channel fallback for cron/subagent-originated approvals
- Persistent in-flight recovery (re-post young pending records to Telegram)
- Reply-based approvals for text-only channels
- Approval request batching
- Approval history / filter / export in the web UI
