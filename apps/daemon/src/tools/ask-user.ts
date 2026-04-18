/**
 * rondel_ask_user — structured multiple-choice prompt to the user.
 *
 * This is NOT an approval flow. There's no safety classifier, no
 * allow/deny decision, and it doesn't route through ApprovalService.
 * It's a question flow with typed options — the agent hands a prompt
 * and a set of labels to the bridge, the bridge renders them as
 * interactive buttons on the originating channel (Telegram inline
 * keyboard, web UI, etc.), and the tool returns the selected option
 * once the user taps one.
 *
 * Observability: every completion (success or timeout/error) emits a
 * `tool_call` ledger event via POST /ledger/tool-call. The summary is
 * `ask_user: <prompt-truncated>` so the ledger shows which question
 * each answer corresponds to.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  emitToolCall,
  fetchJson,
  resolveBridgeContext,
  toolError,
  toolJson,
  type BridgeContext,
} from "./_common.js";
import { summarizeToolUse } from "../approvals/tool-summary.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default wait window before the tool gives up on a human response. */
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
/** Tool-side hard cap — matches the bridge's schema ceiling. */
const MAX_TIMEOUT_MS = 30 * 60 * 1000;
/** Minimum practical timeout — anything shorter races with the poll cadence. */
const MIN_TIMEOUT_MS = 5_000;

/** Poll cadence while waiting for the user. */
const POLL_INTERVAL_MS = 1_000;
/** Extra slack over the nominal timeout before we give up polling. */
const POLL_GRACE_MS = 2_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AskUserResult {
  readonly status: "pending" | "resolved" | "timeout";
  readonly selected_index?: number;
  readonly selected_label?: string;
  readonly resolvedBy?: string;
}

// ---------------------------------------------------------------------------
// Prompt GET helper
// ---------------------------------------------------------------------------
//
// We intentionally don't use _common.ts's `fetchJson` for the poll GET:
// we need three distinct outcomes from one call —
//   200   → decode the body (pending / resolved / timeout)
//   404   → hard timeout (daemon lost the record; further polling is futile)
//   other → transient; keep polling until deadline
// `fetchJson` would collapse 404 and transient failures into the same
// thrown error, which would break the hard-timeout case.

async function fetchPromptResult(
  ctx: BridgeContext,
  requestId: string,
): Promise<AskUserResult | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(
      `${ctx.bridgeUrl}/prompts/ask-user/${encodeURIComponent(requestId)}`,
      { method: "GET", signal: controller.signal },
    );
    if (res.status === 404) {
      // Daemon restarted mid-prompt — treat as a hard timeout.
      return { status: "timeout" };
    }
    if (!res.ok) return undefined; // transient, keep polling
    return (await res.json()) as AskUserResult;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

const DESCRIPTION =
  "Ask the user a multiple-choice question via the active channel (Telegram " +
  "inline keyboard, web UI button, etc.). Returns the selected option's " +
  "label and index.\n\n" +
  "Use this tool when you need an explicit decision with a KNOWN option set " +
  "(e.g. \"Pick a color: red / blue / green\"). For free-text questions, " +
  "just ask the user in your response — do not invoke this tool. For " +
  "dangerous operations that need human sign-off, rely on the built-in " +
  "safety classifier of the rondel_bash / rondel_write_file / rondel_edit_file " +
  "tools instead — they escalate automatically.\n\n" +
  "Limits: prompt <= 4000 chars, options 1-8 entries, default 5-min " +
  "timeout (clamped to [5s, 30min]).";

export function registerAskUserTool(server: McpServer): void {
  server.registerTool(
    "rondel_ask_user",
    {
      description: DESCRIPTION,
      inputSchema: {
        prompt: z.string().min(1).max(4000),
        options: z
          .array(
            z.object({
              label: z.string().min(1).max(200),
              description: z.string().max(500).optional(),
            }),
          )
          .min(1)
          .max(8),
        timeout_ms: z.number().int().min(MIN_TIMEOUT_MS).max(MAX_TIMEOUT_MS).optional(),
      },
    },
    async ({ prompt, options, timeout_ms }) => {
      const effectiveTimeoutMs = timeout_ms ?? DEFAULT_TIMEOUT_MS;
      const summary = summarizeToolUse("rondel_ask_user", { prompt });
      const toolInput = { prompt, options, timeout_ms: effectiveTimeoutMs };

      const ctx = resolveBridgeContext(process.env);
      if (!ctx) {
        return toolError(
          "rondel_ask_user requires bridge context. Is the agent running under Rondel?",
        );
      }

      const startedAt = Date.now();

      // Bind the fixed emit args so every call site is a one-liner.
      const emit = (
        outcome: "success" | "error",
        durationMs: number,
        error?: string,
      ): Promise<void> =>
        emitToolCall(ctx, {
          toolName: "rondel_ask_user",
          toolInput,
          summary,
          outcome,
          durationMs,
          ...(error !== undefined ? { error } : {}),
        });

      let requestId: string;
      try {
        const created = await fetchJson<{ requestId?: string }>(
          `${ctx.bridgeUrl}/prompts/ask-user`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              agentName: ctx.agent,
              channelType: ctx.channelType,
              chatId: ctx.chatId,
              prompt,
              options,
              timeout_ms: effectiveTimeoutMs,
            }),
          },
        );
        if (!created.requestId) {
          throw new Error("POST /prompts/ask-user returned no requestId");
        }
        requestId = created.requestId;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await emit("error", Date.now() - startedAt, msg);
        return toolError(msg);
      }

      const deadline = Date.now() + effectiveTimeoutMs + POLL_GRACE_MS;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        const result = await fetchPromptResult(ctx, requestId).catch(() => undefined);
        if (!result) continue;
        if (result.status === "pending") continue;

        const durationMs = Date.now() - startedAt;
        if (result.status === "resolved") {
          if (
            typeof result.selected_index !== "number" ||
            typeof result.selected_label !== "string"
          ) {
            const msg = "ask-user resolved without selection payload";
            await emit("error", durationMs, msg);
            return toolError(msg);
          }
          await emit("success", durationMs);
          return toolJson({
            selected_index: result.selected_index,
            selected_label: result.selected_label,
            ...(result.resolvedBy ? { resolved_by: result.resolvedBy } : {}),
          });
        }
        if (result.status === "timeout") {
          await emit("error", durationMs, "timeout");
          return toolError("User did not answer within the timeout.");
        }
      }

      await emit("error", Date.now() - startedAt, "timeout");
      return toolError("User did not answer within the timeout.");
    },
  );
}
