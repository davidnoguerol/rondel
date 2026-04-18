/**
 * Pure factories for common test data shapes.
 *
 * Each factory returns a valid instance of the type and accepts an
 * overrides object for fields the test cares about. Use these to keep
 * tests focused on behavior instead of boilerplate construction.
 */

import type { AgentConfig } from "../../src/shared/types/config.js";
import type { SessionEntry } from "../../src/shared/types/sessions.js";
import type { InterAgentMessage } from "../../src/shared/types/messaging.js";

export function makeInterAgentMessage(
  overrides: Partial<InterAgentMessage> = {},
): InterAgentMessage {
  return {
    id: "msg_test_1",
    from: "alice",
    to: "bob",
    replyToChatId: "chat_1",
    content: "hello bob",
    sentAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

export function makeSessionEntry(
  overrides: Partial<SessionEntry> = {},
): SessionEntry {
  return {
    sessionId: "00000000-0000-0000-0000-000000000001",
    agentName: "alice",
    channelType: "telegram",
    chatId: "123",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

export function makeAgentConfig(
  overrides: Partial<AgentConfig> = {},
): AgentConfig {
  return {
    agentName: "alice",
    enabled: true,
    model: "claude-opus-4-6",
    workingDirectory: null,
    channels: [],
    tools: { allowed: [], disallowed: [] },
    ...overrides,
  };
}

/** Body matching the `SendMessageSchema` shape, for schema tests. */
export function makeSendMessageBody(
  overrides: Partial<{
    from: string;
    to: string;
    content: string;
    reply_to_chat_id: string;
  }> = {},
): Record<string, unknown> {
  return {
    from: "alice",
    to: "bob",
    content: "hello",
    reply_to_chat_id: "123",
    ...overrides,
  };
}
