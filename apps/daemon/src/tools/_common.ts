/**
 * Shared helpers for first-class Rondel MCP tools.
 *
 * Every tool in this directory runs in the per-agent MCP server process
 * and shares the same bridge contract:
 *  - Env vars stamped at spawn time (RONDEL_BRIDGE_URL / RONDEL_PARENT_*).
 *  - Approval requests via POST /approvals/tool-use + poll.
 *  - Ledger emits via POST /ledger/tool-call.
 *  - sha256 content hashes for staleness tracking.
 *
 * Centralising these means individual tool files read as straight
 * "what should this tool do" code without wrapping every fetch in
 * error-handling boilerplate.
 *
 * Filesystem-specific tools additionally require RONDEL_PARENT_SESSION_ID
 * so read-state records are keyed per-session; see resolveFilesystemContext.
 *
 * --------------------------------------------------------------------------
 * Env var dual role (naming is historical — RONDEL_PARENT_* predates
 * subagent/cron support):
 *
 *  - `RONDEL_PARENT_AGENT`: the parent agent's name. For subagents and cron
 *    runs this is still the parent agent, NOT the ephemeral spawn's id, so
 *    read-state / file-history / ledger tool_call events attribute back to
 *    the parent. The bridge validates this against AgentManager's name set.
 *  - `RONDEL_PARENT_SESSION_ID`: the session that *called* the tool.
 *    Always unique per Claude CLI process: main conversations use the
 *    conversation's sessionId; subagents use the ephemeral subagent id;
 *    cron isolated runs use the cron run id. The `(agent, sessionId, path)`
 *    tuple keys read-state records — session uniqueness is what isolates
 *    subagent/cron read-state from the parent conversation.
 *  - `RONDEL_PARENT_CHANNEL_TYPE` / `RONDEL_PARENT_CHAT_ID`: the USER-
 *    FACING conversation. Approvals fan out to this surface (so the
 *    Telegram operator sees a subagent's approval card in their regular
 *    chat). Cron runs without a delivery channel omit channelType — the
 *    env validator defaults it to "internal" and approvals silently fall
 *    back to the web UI.
 * --------------------------------------------------------------------------
 */

import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";

// ---------------------------------------------------------------------------
// Bridge context resolution
// ---------------------------------------------------------------------------

export interface BridgeContext {
  readonly bridgeUrl: string;
  readonly agent: string;
  readonly channelType: string;
  readonly chatId: string;
  /**
   * Session id, only populated for filesystem tools (see
   * resolveFilesystemContext). Empty string for tools that don't need it
   * (rondel_bash uses resolveBridgeContext directly).
   */
  readonly sessionId: string;
}

/**
 * Read bridge context from the environment. Returns undefined when any
 * required var is missing. Tools that don't use session-scoped state
 * (rondel_bash) call this directly.
 */
export function resolveBridgeContext(env: NodeJS.ProcessEnv = process.env): BridgeContext | undefined {
  const bridgeUrl = env.RONDEL_BRIDGE_URL ?? "";
  const agent = env.RONDEL_PARENT_AGENT ?? "";
  const channelType = env.RONDEL_PARENT_CHANNEL_TYPE || "internal";
  const chatId = env.RONDEL_PARENT_CHAT_ID ?? "";
  const sessionId = env.RONDEL_PARENT_SESSION_ID ?? "";
  if (!bridgeUrl || !agent || !chatId) return undefined;
  return { bridgeUrl, agent, channelType, chatId, sessionId };
}

/**
 * Bridge context + sessionId. Filesystem tools need a non-empty sessionId
 * to key read-state records, so we fail fast with a clear error when it's
 * missing rather than silently degrading staleness checks.
 */
export function resolveFilesystemContext(
  env: NodeJS.ProcessEnv = process.env,
): { ok: true; ctx: BridgeContext } | { ok: false; error: string } {
  const ctx = resolveBridgeContext(env);
  if (!ctx) {
    return {
      ok: false,
      error: "Missing RONDEL_BRIDGE_URL / RONDEL_PARENT_AGENT / RONDEL_PARENT_CHAT_ID — is the agent running under Rondel?",
    };
  }
  if (!ctx.sessionId) {
    return {
      ok: false,
      error: "Missing RONDEL_PARENT_SESSION_ID — filesystem tools require session context for staleness tracking.",
    };
  }
  return { ok: true, ctx };
}

// ---------------------------------------------------------------------------
// Path + content helpers
// ---------------------------------------------------------------------------

/**
 * sha256 hex digest of `content`. Used as the read-state key so write/edit
 * tools can detect that the on-disk content has drifted since the recorded
 * read.
 */
export function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Validate that `path` is usable as a destination. Rejects relative paths,
 * UNC paths, and paths containing null bytes. Does NOT check existence or
 * safe-zone membership — those are the tool's responsibility downstream.
 */
export function validateAbsolutePath(
  path: unknown,
): { ok: true; path: string } | { ok: false; error: string } {
  if (typeof path !== "string" || path.length === 0) {
    return { ok: false, error: "Path must be a non-empty string." };
  }
  // UNC check before isAbsolute: POSIX's isAbsolute("\\\\...") is false,
  // so the absolute-path error would mask the UNC-specific message.
  if (path.startsWith("\\\\") || path.startsWith("//")) {
    return { ok: false, error: "UNC paths are not allowed." };
  }
  if (path.includes("\0")) {
    return { ok: false, error: "Path contains a null byte." };
  }
  if (!isAbsolute(path)) {
    return { ok: false, error: `Path must be absolute; got '${path}'.` };
  }
  return { ok: true, path };
}

// ---------------------------------------------------------------------------
// Bridge HTTP helpers
// ---------------------------------------------------------------------------

/**
 * fetch() with an abort-on-timeout wrapper. Returns the Response on success
 * or throws on transport / timeout / non-2xx.
 */
export async function fetchJson<T>(
  url: string,
  init: RequestInit = {},
  timeoutMs = 10_000,
): Promise<T> {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: c.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`${init.method ?? "GET"} ${url} → ${res.status}: ${body}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(t);
  }
}

/**
 * GET /filesystem/read-state/{agent}?sessionId=X&path=Y. Returns the
 * recorded record or undefined if none exists (404).
 */
export async function readFileStateGet(
  ctx: BridgeContext,
  path: string,
): Promise<{ contentHash: string; readAt: string } | undefined> {
  const url =
    `${ctx.bridgeUrl}/filesystem/read-state/${encodeURIComponent(ctx.agent)}` +
    `?sessionId=${encodeURIComponent(ctx.sessionId)}` +
    `&path=${encodeURIComponent(path)}`;
  const res = await fetch(url);
  if (res.status === 404) return undefined;
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GET ${url} → ${res.status}: ${body}`);
  }
  return (await res.json()) as { contentHash: string; readAt: string };
}

/** POST /filesystem/read-state/{agent} — record a successful read. */
export async function readFileStateRecord(
  ctx: BridgeContext,
  path: string,
  hash: string,
): Promise<void> {
  await fetchJson(
    `${ctx.bridgeUrl}/filesystem/read-state/${encodeURIComponent(ctx.agent)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: ctx.sessionId, path, contentHash: hash }),
    },
  );
}

/**
 * POST /filesystem/history/{agent}/backup — capture a pre-image before a
 * destructive write. Returns the backup id.
 */
export async function createBackup(
  ctx: BridgeContext,
  originalPath: string,
  content: string,
): Promise<string> {
  const data = await fetchJson<{ backupId: string }>(
    `${ctx.bridgeUrl}/filesystem/history/${encodeURIComponent(ctx.agent)}/backup`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ originalPath, content }),
    },
    20_000,
  );
  return data.backupId;
}

// ---------------------------------------------------------------------------
// Ledger + approval helpers
// ---------------------------------------------------------------------------

export interface ToolCallEmit {
  readonly toolName: string;
  readonly toolInput: unknown;
  readonly summary: string;
  readonly outcome: "success" | "error";
  readonly durationMs: number;
  readonly exitCode?: number;
  readonly error?: string;
}

/**
 * Best-effort POST /ledger/tool-call. Swallows all failures — the ledger
 * is observability, not correctness. Writing to stderr on failure keeps
 * failures visible in daemon logs without bubbling into the tool.
 */
export async function emitToolCall(ctx: BridgeContext, ev: ToolCallEmit): Promise<void> {
  try {
    await fetchJson(
      `${ctx.bridgeUrl}/ledger/tool-call`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentName: ctx.agent,
          channelType: ctx.channelType,
          chatId: ctx.chatId,
          toolName: ev.toolName,
          toolInput: ev.toolInput,
          summary: ev.summary,
          outcome: ev.outcome,
          durationMs: ev.durationMs,
          ...(ev.exitCode !== undefined ? { exitCode: ev.exitCode } : {}),
          ...(ev.error !== undefined ? { error: ev.error } : {}),
        }),
      },
      5_000,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[rondel tool ${ev.toolName}] emitToolCall failed: ${msg}\n`);
  }
}

export type ApprovalOutcome =
  | { kind: "allow"; resolvedBy?: string }
  | { kind: "deny"; resolvedBy?: string }
  | { kind: "timeout" }
  | { kind: "error"; message: string };

const APPROVAL_POLL_INTERVAL_MS = 1000;
const APPROVAL_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Request approval for a tool call and poll until it resolves, is denied,
 * or the deadline passes. Mirrors the rondel_bash flow exactly so operator
 * UX (Telegram card + web UI) is uniform across first-class tools.
 */
export async function requestApprovalAndWait(
  ctx: BridgeContext,
  toolName: string,
  toolInput: unknown,
  reason: string,
): Promise<ApprovalOutcome> {
  let requestId: string;
  try {
    const created = await fetchJson<{ requestId: string }>(
      `${ctx.bridgeUrl}/approvals/tool-use`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentName: ctx.agent,
          channelType: ctx.channelType,
          chatId: ctx.chatId,
          toolName,
          toolInput,
          reason,
        }),
      },
      10_000,
    );
    requestId = created.requestId;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { kind: "error", message: `Approval POST failed: ${message}` };
  }

  const deadline = Date.now() + APPROVAL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, APPROVAL_POLL_INTERVAL_MS));
    try {
      const record = await fetchJson<{
        status?: string;
        decision?: string;
        resolvedBy?: string;
      }>(`${ctx.bridgeUrl}/approvals/${encodeURIComponent(requestId)}`, { method: "GET" }, 10_000);
      if (record.status !== "resolved") continue;
      return record.decision === "allow"
        ? { kind: "allow", resolvedBy: record.resolvedBy }
        : { kind: "deny", resolvedBy: record.resolvedBy };
    } catch {
      // transient — keep polling until deadline
    }
  }
  return { kind: "timeout" };
}

// ---------------------------------------------------------------------------
// MCP result helpers
// ---------------------------------------------------------------------------

export function toolError(message: string): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}

export function toolJson(payload: unknown, isError = false): {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
} {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    isError,
  };
}
