/**
 * Cron-specific preamble prepended to the subagent's system prompt for
 * scheduled runs.
 *
 * Ported verbatim from the former `scheduling/cron-context.ts`. Two
 * concerns kept together:
 *
 * 1. `resolveDelivery` — converts a `CronDelivery` spec into the concrete
 *    `{channelType, accountId, chatId}` the scheduler will actually send
 *    to. Centralized so the scheduler (which does the send) and the
 *    preamble (which tells the subagent about the send) cannot drift.
 *
 * 2. `buildCronPreamble` — produces the text block. The critical contract:
 *    when auto-delivery is active, the scheduler forwards the subagent's
 *    final response text, so the subagent must NOT call channel tools to
 *    deliver the same text itself (double-send bug).
 */

import type { CronDelivery, CronJob } from "../../shared/types/index.js";

/** Concrete delivery target the scheduler will send cron output to. */
export interface ResolvedDelivery {
  readonly channelType: string;
  readonly accountId: string;
  readonly chatId: string;
}

/** Minimal view of the primary-channel fallback — decouples this from AgentManager. */
export type PrimaryChannelLookup = () => { channelType: string; accountId: string } | undefined;

/**
 * Resolve a cron delivery spec to the concrete tuple the scheduler will
 * actually deliver to, or `null` for non-delivering runs.
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

/**
 * Build the scheduled-task preamble. Two variants matching the legacy
 * text verbatim — changing phrasing here would alter behavior of every
 * cron run.
 */
export function buildCronPreamble(job: CronJob, delivery: ResolvedDelivery | null): string {
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
