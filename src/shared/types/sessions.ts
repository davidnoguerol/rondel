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
