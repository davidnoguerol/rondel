/**
 * Typed client for the Rondel daemon's HTTP bridge.
 *
 * ## What this is
 *
 * One file, one exported object — `bridge` — with one method per endpoint
 * the web package consumes. Every data-fetching surface in the app
 * (Server Components, Server Actions, the /api/bridge proxy) goes through
 * here. No file outside `lib/bridge/` calls `fetch` against the bridge
 * directly.
 *
 * ## Why `server-only`
 *
 * This module resolves `~/.rondel/state/rondel.lock` and sends bridge
 * requests — both are strictly server-side concerns. The `"server-only"`
 * import makes the Next bundler error at build time if a Client Component
 * accidentally imports this file, protecting us from leaking bridge URLs,
 * PIDs, and lock-file paths into the browser.
 *
 * ## Why `cache()` wrapping
 *
 * React's `cache()` (NOT the fetch cache — these are different things)
 * memoizes a function for the lifetime of a single RSC render. If a page
 * and a nested server component both call `bridge.agents.list()`, only
 * one HTTP request fires. This is the correct fix for server-side N+1 in
 * App Router; it's cheap and prevents accidental duplicate work.
 *
 * ## Why no React Query / SWR / Redux
 *
 * RSC IS the data layer. Server components fetch in their async body;
 * mutations revalidate via `revalidateTag()`. Adding a client-side store
 * on top of RSC is a trap — the data lives in two places, they drift,
 * and everything gets slower. We use URL search params for shared UI
 * state (filters, selected tabs) and local `useState` for truly local
 * state. Nothing else.
 *
 * ## Rules
 *
 * 1. Every method resolves the bridge URL and delegates HTTP to `fetcher.ts`.
 * 2. Every read method is wrapped in `cache()`.
 * 3. Every response is parsed through a Zod schema from `./schemas.js`.
 *    On failure, throw `BridgeSchemaError` with the Zod issues.
 * 4. Every read sets Next cache tags via the fetcher (`agent:<name>`,
 *    `ledger:<name>`, `memory:<name>`) so Server Actions can invalidate
 *    surgically with `revalidateTag()`.
 * 5. Version handshake (`ensureCompatibleVersion`) runs lazily on the
 *    first bridge call of the process and is cached for the lifetime
 *    of the module. Mismatches throw `BridgeVersionMismatchError`.
 */
import "server-only";

import { cache } from "react";

import {
  BridgeSchemaError,
  BridgeVersionMismatchError,
} from "./errors";
import { bridgeFetch } from "./fetcher";
import {
  AgentPromptResponseSchema,
  ApprovalListResponseSchema,
  ApprovalRecordSchema,
  ApprovalResolveResponseSchema,
  ConversationHistoryResponseSchema,
  ConversationsResponseSchema,
  LedgerEventSchema,
  LedgerQueryResponseSchema,
  ListAgentsResponseSchema,
  MemoryResponseSchema,
  MemoryWriteResponseSchema,
  ScheduleDeleteResponseSchema,
  ScheduleListResponseSchema,
  ScheduleRunResponseSchema,
  ScheduleSummarySchema,
  VersionResponseSchema,
  WebSendResponseSchema,
  type AgentPromptResponse,
  type AgentSummary,
  type ApprovalDecision,
  type ApprovalListResponse,
  type ApprovalRecord,
  type ConversationHistoryResponse,
  type LedgerEvent,
  type ScheduleCreateInput,
  type ScheduleSummary,
  type ScheduleUpdateInput,
  type VersionResponse,
} from "./schemas";

// -----------------------------------------------------------------------------
// Version handshake
// -----------------------------------------------------------------------------

/**
 * Minimum bridge API version this web client requires. Bump when a new
 * release of the web package depends on a bridge feature that doesn't
 * exist in older daemons.
 *
 * On a mismatch, every read throws `BridgeVersionMismatchError` and the
 * user sees "daemon too old, please upgrade" — not a wall of Zod errors.
 *
 * History:
 *   1 — M1 request-response surface
 *   2 — M2 SSE streams (/ledger/tail, /ledger/tail/:agent, /agents/state/tail).
 *   3 — Web chat surface: POST /web/messages/send,
 *       GET /conversations/:agent/:channelType/:chatId/history,
 *       GET /conversations/:agent/:channelType/:chatId/tail (SSE).
 *   4 — Token-level streaming: new `agent_response_delta` frame kind
 *       and optional `blockId` on `agent_response`. The UI uses deltas
 *       for progressive rendering and reconciles against the canonical
 *       complete block.
 *  14 — Schedules surface: GET/POST/PATCH/DELETE /schedules[/:id],
 *       POST /schedules/:id/run, GET /schedules/tail (SSE),
 *       new `schedule:ran` hook carried on the stream.
 */
const WEB_REQUIRES_API_VERSION = 14;

/** Lazy one-shot handshake — resolved once per module lifetime. */
let versionCheck: Promise<VersionResponse> | null = null;

async function ensureCompatibleVersion(): Promise<VersionResponse> {
  if (versionCheck) return versionCheck;
  versionCheck = (async () => {
    const raw = await bridgeFetch("/version");
    const parsed = VersionResponseSchema.safeParse(raw);
    if (!parsed.success) {
      // Reset so the next call retries — this is likely a transient
      // error (e.g. empty response during a race with daemon startup).
      versionCheck = null;
      throw new BridgeSchemaError("/version", formatZodIssues(parsed.error));
    }
    if (parsed.data.apiVersion < WEB_REQUIRES_API_VERSION) {
      throw new BridgeVersionMismatchError(
        WEB_REQUIRES_API_VERSION,
        parsed.data.apiVersion,
      );
    }
    return parsed.data;
  })();
  return versionCheck;
}

// -----------------------------------------------------------------------------
// Zod helpers
// -----------------------------------------------------------------------------

import type { ZodError } from "zod";

function formatZodIssues(err: ZodError): string {
  return err.issues
    .map((issue) => {
      const path = issue.path.length ? `${issue.path.join(".")}: ` : "";
      return `${path}${issue.message}`;
    })
    .join("; ");
}

async function getValidated<T>(
  endpoint: string,
  schema: { safeParse: (data: unknown) => { success: true; data: T } | { success: false; error: ZodError } },
  opts?: { tags?: readonly string[] },
): Promise<T> {
  await ensureCompatibleVersion();
  const raw = await bridgeFetch(endpoint, { tags: opts?.tags });
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new BridgeSchemaError(endpoint, formatZodIssues(parsed.error));
  }
  return parsed.data;
}

// -----------------------------------------------------------------------------
// Bridge methods — one per endpoint
// -----------------------------------------------------------------------------
//
// Reads are wrapped in `cache()` for request-scoped memoization across
// multiple server components in one render. Writes are NOT cached — they
// always hit the bridge and call `revalidateTag()` at the action site.

export const bridge = {
  /** System handshake — exposed so a future dashboard can show daemon version. */
  version: cache(async (): Promise<VersionResponse> => {
    return ensureCompatibleVersion();
  }),

  agents: {
    /** GET /agents — list all known agents and their active conversations. */
    list: cache(async (): Promise<readonly AgentSummary[]> => {
      const res = await getValidated("/agents", ListAgentsResponseSchema, {
        tags: ["agents"],
      });
      return res.agents;
    }),

    /** GET /conversations/:name — list conversations for one agent. */
    conversations: cache(async (name: string) => {
      const res = await getValidated(
        `/conversations/${encodeURIComponent(name)}`,
        ConversationsResponseSchema,
        { tags: [`agent:${name}`] },
      );
      return res.conversations;
    }),

    /**
     * GET /agents/:name/prompt — the raw assembled system prompts for an
     * agent. Returns both the main-conversation variant and the agent-mail
     * variant as plain strings — exactly what gets passed to Claude CLI via
     * `--system-prompt`. Powers the /agents/:name/context page.
     */
    prompt: cache(async (name: string): Promise<AgentPromptResponse> => {
      return getValidated(
        `/agents/${encodeURIComponent(name)}/prompt`,
        AgentPromptResponseSchema,
        { tags: [`agent:${name}:prompt`] },
      );
    }),
  },

  ledger: {
    /**
     * GET /ledger/query — events for one agent (optionally filtered by time,
     * kinds, limit). Returns newest-first as emitted by the daemon.
     */
    query: cache(async (
      params: {
        agent?: string;
        since?: string;
        kinds?: readonly string[];
        limit?: number;
      },
    ): Promise<readonly LedgerEvent[]> => {
      const qs = new URLSearchParams();
      if (params.agent) qs.set("agent", params.agent);
      if (params.since) qs.set("since", params.since);
      if (params.kinds && params.kinds.length > 0) {
        qs.set("kinds", params.kinds.join(","));
      }
      if (params.limit !== undefined) qs.set("limit", String(params.limit));

      const endpoint = `/ledger/query?${qs.toString()}`;
      const tag = params.agent ? `ledger:${params.agent}` : "ledger";
      const res = await getValidated(endpoint, LedgerQueryResponseSchema, {
        tags: [tag],
      });
      return res.events;
    }),
  },

  conversations: {
    /**
     * GET /conversations/:agent/:channelType/:chatId/history
     *
     * Returns ordered user/assistant turns parsed from the transcript. Used
     * by the chat page to rehydrate history on load. Cached per
     * `(agent, channelType, chatId)` tuple so a parent RSC + child component
     * share one round-trip.
     */
    history: cache(async (
      agent: string,
      channelType: string,
      chatId: string,
    ): Promise<ConversationHistoryResponse> => {
      const endpoint =
        `/conversations/${encodeURIComponent(agent)}/${encodeURIComponent(channelType)}/${encodeURIComponent(chatId)}/history`;
      return getValidated(endpoint, ConversationHistoryResponseSchema, {
        tags: [`conversation:${agent}:${channelType}:${chatId}`],
      });
    }),

    /**
     * POST /web/messages/send — inject a user message into a web conversation.
     *
     * Not cached (writes never are). The agent's response streams back over
     * the conversation tail SSE endpoint, not this HTTP call.
     */
    send: async (agentName: string, chatId: string, text: string): Promise<void> => {
      await ensureCompatibleVersion();
      const raw = await bridgeFetch("/web/messages/send", {
        method: "POST",
        body: { agent_name: agentName, chat_id: chatId, text },
      });
      const parsed = WebSendResponseSchema.safeParse(raw);
      if (!parsed.success) {
        throw new BridgeSchemaError(
          "POST /web/messages/send",
          formatZodIssues(parsed.error),
        );
      }
    },
  },

  approvals: {
    /** GET /approvals — list pending + recent resolved approvals. */
    list: cache(async (): Promise<ApprovalListResponse> => {
      return getValidated("/approvals", ApprovalListResponseSchema, {
        tags: ["approvals"],
      });
    }),

    /** GET /approvals/:id — fetch a single approval record (pending or resolved). */
    get: cache(async (requestId: string): Promise<ApprovalRecord> => {
      return getValidated(
        `/approvals/${encodeURIComponent(requestId)}`,
        ApprovalRecordSchema,
        { tags: [`approval:${requestId}`] },
      );
    }),

    /**
     * POST /approvals/:id/resolve — allow or deny a pending approval from
     * the web UI. Equivalent to a Telegram button tap: the daemon moves
     * the record to resolved, unblocks the waiting hook, and emits the
     * ledger event.
     *
     * NOT cached (writes never are). Call `revalidateTag("approvals")`
     * at the action site afterward to refresh the page.
     */
    resolve: async (requestId: string, decision: ApprovalDecision, resolvedBy?: string): Promise<void> => {
      await ensureCompatibleVersion();
      const raw = await bridgeFetch(
        `/approvals/${encodeURIComponent(requestId)}/resolve`,
        { method: "POST", body: { decision, resolvedBy } },
      );
      const parsed = ApprovalResolveResponseSchema.safeParse(raw);
      if (!parsed.success) {
        throw new BridgeSchemaError(
          `POST /approvals/${requestId}/resolve`,
          formatZodIssues(parsed.error),
        );
      }
    },
  },

  memory: {
    /** GET /memory/:agent — read the agent's MEMORY.md file. */
    read: cache(async (agent: string): Promise<string | null> => {
      const res = await getValidated(
        `/memory/${encodeURIComponent(agent)}`,
        MemoryResponseSchema,
        { tags: [`memory:${agent}`] },
      );
      return res.content;
    }),

    /**
     * PUT /memory/:agent — replace the agent's MEMORY.md file.
     * NOT wrapped in `cache()` — writes always hit the daemon. Call
     * `revalidateTag("memory:<agent>")` at the action site afterward.
     */
    write: async (agent: string, content: string): Promise<void> => {
      await ensureCompatibleVersion();
      const raw = await bridgeFetch(
        `/memory/${encodeURIComponent(agent)}`,
        { method: "PUT", body: { content } },
      );
      const parsed = MemoryWriteResponseSchema.safeParse(raw);
      if (!parsed.success) {
        throw new BridgeSchemaError(
          `PUT /memory/${agent}`,
          formatZodIssues(parsed.error),
        );
      }
    },
  },

  schedules: {
    /**
     * GET /schedules?callerAgent=<agent>&isAdmin=true
     *
     * The web is a loopback-only admin surface, so every call names the
     * target agent as both caller AND subject. The daemon's owner-vs-
     * admin check passes trivially (admin flag set), and schedules listed
     * here are always owned by `agent`.
     */
    list: cache(async (agent: string): Promise<readonly ScheduleSummary[]> => {
      const qs = new URLSearchParams({
        callerAgent: agent,
        isAdmin: "true",
        includeDisabled: "true",
      });
      const res = await getValidated(
        `/schedules?${qs.toString()}`,
        ScheduleListResponseSchema,
        { tags: [`schedules:${agent}`] },
      );
      return res.schedules;
    }),

    /**
     * POST /schedules — create a new runtime schedule owned by `agent`.
     *
     * The caller context deliberately omits chat metadata so
     * ScheduleService.resolveDelivery doesn't default delivery to a
     * conversation the web doesn't participate in. Users pick delivery
     * explicitly in the dialog; anything else means `none`.
     */
    create: async (agent: string, input: ScheduleCreateInput): Promise<ScheduleSummary> => {
      await ensureCompatibleVersion();
      const raw = await bridgeFetch("/schedules", {
        method: "POST",
        body: {
          caller: { agentName: agent, isAdmin: true },
          input: { ...input, targetAgent: agent },
        },
      });
      const parsed = ScheduleSummarySchema.safeParse(raw);
      if (!parsed.success) {
        throw new BridgeSchemaError("POST /schedules", formatZodIssues(parsed.error));
      }
      return parsed.data;
    },

    /** PATCH /schedules/:id */
    update: async (
      agent: string,
      scheduleId: string,
      patch: ScheduleUpdateInput,
    ): Promise<ScheduleSummary> => {
      await ensureCompatibleVersion();
      const raw = await bridgeFetch(`/schedules/${encodeURIComponent(scheduleId)}`, {
        method: "PATCH",
        body: { caller: { agentName: agent, isAdmin: true }, patch },
      });
      const parsed = ScheduleSummarySchema.safeParse(raw);
      if (!parsed.success) {
        throw new BridgeSchemaError(
          `PATCH /schedules/${scheduleId}`,
          formatZodIssues(parsed.error),
        );
      }
      return parsed.data;
    },

    /** DELETE /schedules/:id */
    remove: async (agent: string, scheduleId: string): Promise<void> => {
      await ensureCompatibleVersion();
      const raw = await bridgeFetch(`/schedules/${encodeURIComponent(scheduleId)}`, {
        method: "DELETE",
        body: { caller: { agentName: agent, isAdmin: true } },
      });
      const parsed = ScheduleDeleteResponseSchema.safeParse(raw);
      if (!parsed.success) {
        throw new BridgeSchemaError(
          `DELETE /schedules/${scheduleId}`,
          formatZodIssues(parsed.error),
        );
      }
    },

    /** POST /schedules/:id/run — fire a schedule immediately. */
    runNow: async (agent: string, scheduleId: string): Promise<void> => {
      await ensureCompatibleVersion();
      const raw = await bridgeFetch(`/schedules/${encodeURIComponent(scheduleId)}/run`, {
        method: "POST",
        body: { caller: { agentName: agent, isAdmin: true } },
      });
      const parsed = ScheduleRunResponseSchema.safeParse(raw);
      if (!parsed.success) {
        throw new BridgeSchemaError(
          `POST /schedules/${scheduleId}/run`,
          formatZodIssues(parsed.error),
        );
      }
    },
  },
} as const;
