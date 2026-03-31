// --- Router ---

export interface QueuedMessage {
  readonly agentName: string;
  readonly accountId: string;
  readonly chatId: string;
  readonly text: string;
  readonly queuedAt: number;
}
