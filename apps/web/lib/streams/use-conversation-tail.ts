"use client";

/**
 * Typed wrapper over `useEventStream` for a single conversation's live tail.
 *
 * Subscribes to `GET /conversations/{agent}/{channelType}/{chatId}/tail`.
 * Each frame is validated via `ConversationStreamFrameSchema` — unknown
 * shapes are dropped rather than crashing the consumer.
 *
 * Pass `null` for any of the identifiers to disable the connection while
 * the consumer waits for parameters to resolve.
 */

import {
  ConversationStreamFrameSchema,
  type ConversationStreamFrameData,
} from "@/lib/bridge";

import { useEventStream, type UseEventStreamResult } from "./use-event-stream";

export type ConversationTailFrame = ConversationStreamFrameData;

export function useConversationTail(
  agent: string | null,
  channelType: string | null,
  chatId: string | null,
): UseEventStreamResult<ConversationTailFrame> {
  const url = agent && channelType && chatId ? buildUrl(agent, channelType, chatId) : null;
  return useEventStream<ConversationTailFrame>(url, parseFrame);
}

function buildUrl(agent: string, channelType: string, chatId: string): string {
  return (
    `/api/bridge/conversations/${encodeURIComponent(agent)}/` +
    `${encodeURIComponent(channelType)}/${encodeURIComponent(chatId)}/tail`
  );
}

function parseFrame(raw: unknown): ConversationTailFrame | null {
  const parsed = ConversationStreamFrameSchema.safeParse(raw);
  return parsed.success ? parsed.data.data : null;
}
