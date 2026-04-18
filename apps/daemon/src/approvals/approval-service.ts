/**
 * ApprovalService — central owner of HITL approval state.
 *
 * Handles the tool-use escalation flow: a dangerous `rondel_*` tool
 * call is sent here, the service persists a pending record, fans out
 * an interactive card to the originating channel (Telegram buttons +
 * web UI), and resolves when the operator taps Approve/Deny (or times
 * out).
 *
 * The service is deliberately unaware of HOW the tool waits (polling
 * over HTTP today, SSE later). It just flips records from pending to
 * resolved — the bridge GET endpoint is the source of truth the tool
 * reads.
 */

import { mkdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import type { RondelHooks } from "../shared/hooks.js";
import type { Logger } from "../shared/logger.js";
import type { ChannelRegistry } from "../channels/core/registry.js";
import type { ChannelAdapter, InteractiveButton } from "../channels/core/channel.js";
import type {
  ApprovalDecision,
  ApprovalRecord,
  ToolUseApprovalRecord,
  ToolUseApprovalRequest,
} from "./types.js";
import {
  listPending,
  listResolved,
  readAny,
  readPending,
  removePending,
  writePending,
  writeResolved,
  type ApprovalPaths,
} from "./approval-store.js";
import { summarizeToolUse } from "./tool-summary.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * How long we wait for a human decision before auto-denying.
 *
 * Default: 30 minutes. Override via RONDEL_APPROVAL_TIMEOUT_MS for tests.
 * Matches cortextos's hook-permission-telegram 1800s window.
 */
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

function resolveTimeoutMs(): number {
  const raw = process.env.RONDEL_APPROVAL_TIMEOUT_MS;
  if (!raw) return DEFAULT_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

/**
 * Given (agentName, channelType), return the accountId the agent uses
 * on that channel, or undefined if the agent has no binding there.
 *
 * Provided by the orchestrator at construction time — the approval
 * service doesn't want a hard dep on AgentManager, and the lookup
 * is just a config peek.
 */
export type ResolveAccountId = (agentName: string, channelType: string) => string | undefined;

export interface ApprovalServiceDeps {
  readonly paths: ApprovalPaths;
  readonly hooks: RondelHooks;
  readonly channels: ChannelRegistry;
  readonly resolveAccountId: ResolveAccountId;
  readonly log: Logger;
}

// ---------------------------------------------------------------------------
// Pending resolver map
// ---------------------------------------------------------------------------

/**
 * Each pending record has exactly one in-process promise waiting on it.
 * The resolver unblocks the `decision` promise returned by
 * `requestToolUse`; the timeout handle auto-denies the record if the
 * user never decides.
 */
interface PendingResolver {
  readonly resolve: (decision: ApprovalDecision) => void;
  readonly timeoutHandle: NodeJS.Timeout;
  readonly onTimeout: () => void | Promise<void>;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class ApprovalService {
  private readonly log: Logger;
  private readonly timeoutMs = resolveTimeoutMs();
  private readonly resolvers = new Map<string, PendingResolver>();
  /**
   * Synchronous guard against concurrent `resolve()` calls on the same
   * requestId. A real-world race: the 30-min timeout fires in the same
   * tick as the user taps Approve. Both callers pass the async "pending
   * exists" check, then both issue writeResolved (last-writer-wins on
   * disk) and emit `approval:resolved` twice with conflicting decisions.
   * The `resolvers` map is checked inside the resolving critical section
   * too, but only the first caller to reach that point wins — adding a
   * synchronous has/add/delete around the whole method closes the outer
   * door.
   */
  private readonly resolving = new Set<string>();

  constructor(private readonly deps: ApprovalServiceDeps) {
    this.log = deps.log.child("approvals");
  }

  // -------------------------------------------------------------------------
  // Startup
  // -------------------------------------------------------------------------

  /**
   * Ensure approval dirs exist. Call once at startup before agents spawn.
   */
  async init(): Promise<void> {
    await mkdir(this.deps.paths.pendingDir, { recursive: true });
    await mkdir(this.deps.paths.resolvedDir, { recursive: true });
  }

  /**
   * Auto-resolve any pending records left from a previous run.
   *
   * The in-memory resolver map cannot survive a restart, so the hook
   * scripts that posted those requests are long gone (their parent
   * Claude CLI process crashed or was killed alongside the daemon).
   * Leaving the files would orphan them — the next startup would see
   * them forever. Every orphan is written to resolved with
   * `decision: "deny"`.
   *
   * TODO(hitl-future): re-post to Telegram and restore resolvers for
   * records young enough that the agent might still be waiting.
   */
  async recoverPending(): Promise<void> {
    const pending = await listPending(this.deps.paths);
    if (pending.length === 0) return;

    this.log.warn(`Auto-resolving ${pending.length} orphaned pending approval(s) from previous run`);
    const now = new Date().toISOString();
    for (const record of pending) {
      const resolved: ToolUseApprovalRecord = {
        ...record,
        status: "resolved",
        decision: "deny",
        resolvedAt: now,
        resolvedBy: "daemon-restart",
      };
      await writeResolved(this.deps.paths, resolved);
      await removePending(this.deps.paths, record.requestId);
    }
  }

  // -------------------------------------------------------------------------
  // Tier 1: PreToolUse safety-net escalation
  // -------------------------------------------------------------------------

  /**
   * Record a new tool-use approval request and dispatch it.
   *
   * Returns `{requestId, decision}` once the pending record is on disk.
   * The bridge endpoint awaits this, returns `{requestId}` to the hook,
   * and discards the `decision` promise — the hook polls GET /approvals/:id
   * to learn the outcome. In-process callers can await `decision` directly.
   *
   * Timeout: auto-denies after `this.timeoutMs`.
   */
  async requestToolUse(
    req: ToolUseApprovalRequest,
  ): Promise<{ requestId: string; decision: Promise<ApprovalDecision> }> {
    const requestId = newRequestId();
    const createdAt = new Date().toISOString();
    const summary = summarizeToolUse(req.toolName, req.toolInput);

    const record: ToolUseApprovalRecord = {
      requestId,
      status: "pending",
      agentName: req.agentName,
      channelType: req.channelType,
      chatId: req.chatId,
      toolName: req.toolName,
      toolInput: req.toolInput,
      summary,
      reason: req.reason,
      createdAt,
    };

    // Persist first. Any downstream I/O must not observe a "pending"
    // request that isn't yet on disk.
    await writePending(this.deps.paths, record);

    // Build the resolver promise and register it before any I/O that
    // might call resolve() back.
    const decision = new Promise<ApprovalDecision>((resolve) => {
      const timeoutHandle = setTimeout(() => {
        // Belt-and-suspenders: if the resolver was already consumed by a
        // real decision synchronously before this timer fired, skip the
        // auto-deny. `resolving` in resolve() is the primary guard; this
        // avoids even queuing the deny when the decision is already known.
        if (!this.resolvers.has(requestId)) return;
        this.log.warn(`Approval ${requestId} timed out after ${this.timeoutMs}ms — auto-denying`);
        void this.resolve(requestId, "deny", "timeout");
      }, this.timeoutMs);
      timeoutHandle.unref?.();
      this.resolvers.set(requestId, {
        resolve,
        timeoutHandle,
        onTimeout: () => this.resolve(requestId, "deny", "timeout"),
      });
    });

    this.deps.hooks.emit("approval:requested", { record });

    // Fan out to the originating channel. Fire-and-forget — the web UI
    // is always a valid fallback because the record is already on disk.
    this.dispatchToolUseInteractive(record).catch((err) => {
      this.log.error(`Approval ${requestId} dispatch failed: ${errMessage(err)}`);
    });

    return { requestId, decision };
  }

  /**
   * Send the tool-use approval card through the originating channel.
   */
  private async dispatchToolUseInteractive(record: ToolUseApprovalRecord): Promise<void> {
    const adapter = this.resolveInteractiveAdapter(record);
    if (!adapter) return;

    const message = buildToolUseMessage(record);
    const buttons: InteractiveButton[] = [
      { label: "✅ Approve", callbackData: `rondel_appr_allow_${record.requestId}` },
      { label: "❌ Deny", callbackData: `rondel_appr_deny_${record.requestId}` },
    ];

    await adapter.adapter.sendInteractive(adapter.accountId, record.chatId ?? "", message, buttons);
  }

  // -------------------------------------------------------------------------
  // Tool-use resolution
  // -------------------------------------------------------------------------

  /**
   * Resolve a pending tool-use approval. Idempotent — a second call on
   * the same id is a no-op.
   */
  async resolve(requestId: string, decision: ApprovalDecision, resolvedBy: string): Promise<void> {
    // Synchronous concurrency guard. The has/add pair runs before any
    // await, so two concurrent callers (user tap + timeout in the same
    // tick) race here, not on the async pending-read below.
    if (this.resolving.has(requestId)) {
      this.log.debug(`resolve(${requestId}): already in-flight, ignoring duplicate`);
      return;
    }
    this.resolving.add(requestId);
    try {
      const pending = await readPending(this.deps.paths, requestId);
      if (!pending) {
        this.log.debug(`resolve(${requestId}): no pending record, ignoring`);
        return;
      }

      const resolved: ToolUseApprovalRecord = {
        ...pending,
        status: "resolved",
        decision,
        resolvedAt: new Date().toISOString(),
        resolvedBy,
      };

      await writeResolved(this.deps.paths, resolved);
      await removePending(this.deps.paths, requestId);

      const resolver = this.resolvers.get(requestId);
      if (resolver) {
        clearTimeout(resolver.timeoutHandle);
        resolver.resolve(decision);
        this.resolvers.delete(requestId);
      }

      this.deps.hooks.emit("approval:resolved", { record: resolved });
      this.log.info(`Approval ${requestId}: ${decision} by ${resolvedBy}`);
    } finally {
      this.resolving.delete(requestId);
    }
  }

  // -------------------------------------------------------------------------
  // Read helpers
  // -------------------------------------------------------------------------

  /**
   * Lookup helper used by the bridge GET endpoint. The hook script
   * polls this via HTTP; returns undefined if the request id is unknown.
   */
  async getById(requestId: string): Promise<ApprovalRecord | undefined> {
    return readAny(this.deps.paths, requestId);
  }

  /**
   * List endpoint for the web UI.
   *
   * Returns all currently pending + the most recent `resolvedLimit`
   * resolved records so the UI can show both at once.
   */
  async list(resolvedLimit = 50): Promise<{ pending: ApprovalRecord[]; resolved: ApprovalRecord[] }> {
    const [pending, resolved] = await Promise.all([
      listPending(this.deps.paths),
      listResolved(this.deps.paths, resolvedLimit),
    ]);
    return { pending, resolved };
  }

  // -------------------------------------------------------------------------
  // Shared channel resolution
  // -------------------------------------------------------------------------

  /**
   * Find the account + adapter to use when fanning out an interactive
   * message for this record. Returns undefined when no interactive path
   * is available — callers fall through to the web UI silently.
   */
  private resolveInteractiveAdapter(record: ApprovalRecord): { adapter: ChannelAdapter; accountId: string } | undefined {
    if (!record.channelType || !record.chatId) {
      this.log.info(`Approval ${record.requestId} has no channel binding — web UI only`);
      return undefined;
    }

    const adapter = this.deps.channels.get(record.channelType);
    if (!adapter || !adapter.supportsInteractive) {
      this.log.info(
        `Approval ${record.requestId}: channel ${record.channelType} has no interactive support — web UI only`,
      );
      return undefined;
    }

    const accountId = this.deps.resolveAccountId(record.agentName, record.channelType);
    if (!accountId) {
      this.log.warn(
        `Approval ${record.requestId}: no account binding for ${record.agentName}/${record.channelType} — web UI only`,
      );
      return undefined;
    }

    return { adapter, accountId };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function newRequestId(): string {
  const epoch = Math.floor(Date.now() / 1000);
  const rand = randomBytes(4).toString("hex");
  return `appr_${epoch}_${rand}`;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Build the text block shown to the user for a tool_use approval card.
 */
function buildToolUseMessage(record: ToolUseApprovalRecord): string {
  const lines = [
    "🔔 *Permission request*",
    `Agent: \`${record.agentName}\``,
    `Tool: \`${record.toolName}\``,
    `Why: ${record.reason}`,
    "",
    "```",
    record.summary,
    "```",
  ];
  return lines.join("\n");
}
