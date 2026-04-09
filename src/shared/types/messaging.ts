// --- Inter-agent messaging (Layer 2) ---
//
// Types for inter-agent communication. Agents send async messages
// to each other via MCP tools. Messages are delivered to a synthetic
// "agent-mail" conversation per recipient. Responses are automatically
// routed back to the sender's original conversation.

/**
 * Synthetic chatId for inter-agent messaging. Each agent gets at most one
 * agent-mail conversation — a separate Claude CLI process that handles
 * messages from other agents, isolated from user conversations.
 */
export const AGENT_MAIL_CHAT_ID = "agent-mail";

/** Synthetic channel type for internal messaging (agent-mail, cron). Not a real channel adapter. */
export const INTERNAL_CHANNEL_TYPE = "internal";

/** Envelope for inter-agent messages. */
export interface InterAgentMessage {
  readonly id: string;
  readonly from: string;           // sender agentName
  readonly to: string;             // recipient agentName
  readonly replyToChatId: string;  // sender's chatId for routing replies back
  readonly threadId?: string;      // for ping-pong conversations (future)
  readonly turnNumber?: number;    // current turn in thread (future)
  readonly maxTurns?: number;      // thread turn limit (future)
  readonly content: string;
  readonly sentAt: string;         // ISO 8601
  readonly orgName?: string;       // org scope for isolation
}

/** Tracking info for routing agent-mail responses back to the sender. */
export interface AgentMailReplyTo {
  readonly senderAgent: string;
  readonly senderChatId: string;
  readonly messageId: string;
}

/** Emitted when an agent sends a message to another agent. */
export interface MessageSentEvent {
  readonly message: InterAgentMessage;
}

/** Emitted when a message is delivered to recipient's inbox. */
export interface MessageDeliveredEvent {
  readonly message: InterAgentMessage;
}

/** Emitted when an agent-mail response is routed back to the sender. */
export interface MessageReplyEvent {
  readonly inReplyTo: string;     // original message ID
  readonly from: string;          // replying agent
  readonly to: string;            // original sender (receiving the reply)
  readonly content: string;       // reply text
  readonly repliedAt: string;     // ISO 8601
}

/** Emitted when a ping-pong thread completes (max turns or early exit). */
export interface ThreadCompletedEvent {
  readonly threadId: string;
  readonly participants: readonly [string, string];
  readonly turnCount: number;
  readonly reason: "max_turns" | "early_exit";
}
