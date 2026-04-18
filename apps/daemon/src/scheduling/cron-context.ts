/**
 * Pure helpers for the cron execution contract.
 *
 * Two concerns live here:
 *
 * 1. `resolveDelivery` — converts a `CronDelivery` (the user/agent's
 *    expressed intent) into the concrete `{channelType, accountId,
 *    chatId}` the scheduler actually sends to. Centralized so the
 *    scheduler (which does the send) and the cron-runner (which tells
 *    the subagent about the send in its system prompt) cannot drift.
 *
 * 2. `buildCronContextPrompt` — produces the scheduled-task preamble
 *    prepended to the subagent's system prompt. The critical contract
 *    it communicates: the scheduler auto-delivers the subagent's final
 *    response text, so the subagent must NOT call its own channel tools
 *    to deliver the same text (doing so would double-send).
 *
 * Both functions are intentionally pure — no logger, no fs, no env —
 * so they can be unit-tested in isolation. Every real-world trip
 * through the cron path (isolated runs, future scheduler changes, log
 * lines) should route through these rather than reimplementing the
 * logic inline.
 */

import type { CronDelivery, CronJob } from "../shared/types/index.js";

// ---------------------------------------------------------------------------
// Delivery resolution
// ---------------------------------------------------------------------------

/**
 * The concrete target the scheduler will actually send cron output to.
 * All three fields required — anything less is not deliverable.
 */
export interface ResolvedDelivery {
  readonly channelType: string;
  readonly accountId: string;
  readonly chatId: string;
}

/** Minimal view of a primary-channel fallback — decouples this module from AgentManager. */
export type PrimaryChannelLookup = () => { channelType: string; accountId: string } | undefined;

/**
 * Resolve a cron delivery spec to the concrete `(channelType, accountId,
 * chatId)` tuple the scheduler will actually deliver to, or `null` if
 * the job has no user-facing delivery (mode "none" or a partial spec
 * with no primary-channel fallback available).
 *
 * Partial specs (delivery with a chatId but missing channelType or
 * accountId) are filled in from the agent's primary channel binding —
 * a declarative-cron convenience preserved from the original design.
 * Runtime-created schedules typically carry all three fields explicitly.
 */
export function resolveDelivery(
  delivery: CronDelivery | undefined,
  primaryFallback: PrimaryChannelLookup,
): ResolvedDelivery | null {
  if (!delivery || delivery.mode !== "announce") return null;

  let { channelType, accountId } = delivery;
  if (!channelType || !accountId) {
    const primary = primaryFallback();
    if (!primary) return null;
    channelType = channelType ?? primary.channelType;
    accountId = accountId ?? primary.accountId;
  }

  return { channelType, accountId, chatId: delivery.chatId };
}

// ---------------------------------------------------------------------------
// System-prompt context block
// ---------------------------------------------------------------------------

/**
 * Build the scheduled-task preamble prepended to the cron subagent's
 * system prompt.
 *
 * The preamble names the delivery contract explicitly so the LLM does
 * not have to infer it. Two variants:
 *
 * - **auto-deliver present** (`delivery` non-null): the subagent is
 *   told its response text will be forwarded by the scheduler to the
 *   exact chat/channel/account tuple that will be used. It is
 *   instructed NOT to call channel tools to deliver that same text —
 *   this is the fix for the double-send bug where the subagent called
 *   `rondel_send_telegram` itself while the scheduler also announced
 *   the turn's final text.
 *
 * - **no auto-delivery** (`delivery` null): the subagent is told its
 *   response text is captured to the ledger but not forwarded. If the
 *   task requires messaging a human, it must call the appropriate
 *   channel tool explicitly.
 *
 * Channel-tool names are included when the resolved channel has a
 * known mapping, so the LLM has a concrete tool reference in context
 * for the "no auto-delivery" case. Unknown channels get a neutral
 * wording that points at `rondel_send_message` for inter-agent fallback.
 */
export function buildCronContextPrompt(job: CronJob, delivery: ResolvedDelivery | null): string {
  const meta = [
    `- Schedule: "${job.name}" (${job.id})`,
    job.owner ? `- Registered by: ${job.owner}` : null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");

  if (delivery) {
    return [
      "# Scheduled task context",
      "",
      "You are running as a one-shot subagent for a scheduled task. The scheduler",
      "will AUTOMATICALLY deliver your final response text to the user — do NOT",
      "call `rondel_send_telegram`, `rondel_send_message`, or any other channel",
      "tool to send that same message yourself. Doing so produces a duplicate.",
      "",
      meta,
      `- Auto-delivery target: ${delivery.channelType} / account \`${delivery.accountId}\` / chat \`${delivery.chatId}\``,
      "",
      "Produce the message the user should see as your response text, then stop.",
      "Channel tools remain available only if the task genuinely requires",
      "messaging a DIFFERENT chat or user beyond the auto-delivered response.",
    ].join("\n");
  }

  return [
    "# Scheduled task context",
    "",
    "You are running as a one-shot subagent for a scheduled task. This run has",
    "NO automatic delivery — your response text is captured to the conversation",
    "ledger but is NOT forwarded to any user-facing chat. If the task requires",
    "messaging a human, call the appropriate channel tool (e.g.",
    "`rondel_send_telegram`) explicitly with the target chat id.",
    "",
    meta,
    "- Auto-delivery target: none (output captured to ledger only)",
  ].join("\n");
}
