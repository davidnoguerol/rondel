// --- Conversation key ---

/**
 * Branded type for conversation keys ({agentName}:{channelType}:{chatId}).
 *
 * The channelType segment prevents collision when the same agent is reachable
 * on multiple channels (e.g., Telegram chat "123" vs Slack channel "123").
 */
export type ConversationKey = string & { readonly __brand: "ConversationKey" };

/** Build the canonical conversation key used for routing and process lookup. */
export function conversationKey(agentName: string, channelType: string, chatId: string): ConversationKey {
  return `${agentName}:${channelType}:${chatId}` as ConversationKey;
}

/**
 * Decompose a conversation key back into its parts.
 *
 * Throws on malformed keys (fewer than two colons) so callers don't
 * silently dispatch on garbage parts. The branded type makes a bad
 * input unreachable in normal code paths, but we harden the exported
 * surface since callers can cast via `as ConversationKey`.
 */
export function parseConversationKey(key: ConversationKey): [agentName: string, channelType: string, chatId: string] {
  const first = key.indexOf(":");
  if (first < 0) {
    throw new Error(`Malformed ConversationKey (no colons): ${JSON.stringify(key)}`);
  }
  const second = key.indexOf(":", first + 1);
  if (second < 0) {
    throw new Error(`Malformed ConversationKey (only one colon): ${JSON.stringify(key)}`);
  }
  return [key.slice(0, first), key.slice(first + 1, second), key.slice(second + 1)];
}

// --- Session persistence ---

export interface SessionEntry {
  readonly sessionId: string;          // Claude CLI session UUID
  readonly agentName: string;
  readonly channelType: string;
  readonly chatId: string;
  readonly createdAt: number;          // epoch ms
  updatedAt: number;                   // epoch ms — updated on each turn
}

/** Maps conversation keys ({agentName}:{channelType}:{chatId}) to session entries. */
export type SessionIndex = Record<string, SessionEntry>;
