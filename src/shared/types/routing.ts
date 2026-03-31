// --- Router ---

import type { AgentMailReplyTo } from "./messaging.js";

export interface QueuedMessage {
  readonly agentName: string;
  readonly accountId: string;
  readonly chatId: string;
  readonly text: string;
  readonly queuedAt: number;
  readonly agentMailReplyTo?: AgentMailReplyTo;
}
