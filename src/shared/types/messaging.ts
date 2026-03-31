// --- Inter-agent messaging (Layer 2 seam) ---
//
// These types define the contract for inter-agent communication.
// They're pre-defined here as seams — the implementation comes in
// the inter-agent messaging phase. Hook events are wired but have
// no listeners yet.

/** Envelope for inter-agent messages. */
export interface InterAgentMessage {
  readonly id: string;
  readonly from: string;        // sender agentName
  readonly to: string;          // recipient agentName
  readonly threadId?: string;   // for ping-pong conversations
  readonly turnNumber?: number; // current turn in thread
  readonly maxTurns?: number;   // thread turn limit
  readonly content: string;
  readonly sentAt: string;      // ISO 8601
  readonly orgName?: string;    // org scope for isolation
}

/** Emitted when an agent sends a message to another agent. */
export interface MessageSentEvent {
  readonly message: InterAgentMessage;
}

/** Emitted when a message is delivered to recipient's inbox. */
export interface MessageDeliveredEvent {
  readonly message: InterAgentMessage;
}

/** Emitted when a ping-pong thread completes (max turns or early exit). */
export interface ThreadCompletedEvent {
  readonly threadId: string;
  readonly participants: readonly [string, string];
  readonly turnCount: number;
  readonly reason: "max_turns" | "early_exit";
}
