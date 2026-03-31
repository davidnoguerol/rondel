// --- Conversation key ---

/** Branded type for conversation keys ({agentName}:{chatId}). */
export type ConversationKey = string & { readonly __brand: "ConversationKey" };

/** Build the canonical conversation key used for routing and process lookup. */
export function conversationKey(agentName: string, chatId: string): ConversationKey {
  return `${agentName}:${chatId}` as ConversationKey;
}

/** Decompose a conversation key back into its parts. */
export function parseConversationKey(key: ConversationKey): [string, string] {
  const idx = key.indexOf(":");
  return [key.slice(0, idx), key.slice(idx + 1)];
}

// --- Session persistence ---

export interface SessionEntry {
  readonly sessionId: string;          // Claude CLI session UUID
  readonly agentName: string;
  readonly chatId: string;
  readonly createdAt: number;          // epoch ms
  updatedAt: number;                   // epoch ms — updated on each turn
}

/** Maps conversation keys ({agentName}:{chatId}) to session entries. */
export type SessionIndex = Record<string, SessionEntry>;
