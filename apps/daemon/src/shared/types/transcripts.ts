// --- Transcript entries (user-constructed; stream-json events are written raw) ---

export interface TranscriptSessionHeader {
  readonly type: "session_start";
  readonly sessionId: string;
  readonly agentName: string;
  readonly chatId: string;
  readonly model: string;
  readonly timestamp: string;          // ISO 8601
}

export interface TranscriptUserEntry {
  readonly type: "user";
  readonly text: string;
  readonly senderId?: string;
  readonly senderName?: string;
  readonly timestamp: string;          // ISO 8601
}
