// --- Router ---

import type { AgentMailReplyTo } from "./messaging.js";
import type { ChannelAttachment } from "./attachments.js";

export interface QueuedMessage {
  readonly agentName: string;
  readonly channelType: string;
  readonly accountId: string;
  readonly chatId: string;
  readonly text: string;
  readonly queuedAt: number;
  readonly agentMailReplyTo?: AgentMailReplyTo;
  /**
   * Attachments staged on disk by the inbound adapter. Persisted with
   * the queue so a crash between accept and drain doesn't lose them.
   * The staged files themselves live under
   * `state/attachments/{agent}/{chatId}/` and are subject to the 24 h
   * cleanup TTL — if a queued message lingers across that window the
   * agent will see manifest entries pointing to missing paths, which
   * the model is expected to handle gracefully.
   */
  readonly attachments?: readonly ChannelAttachment[];
}
