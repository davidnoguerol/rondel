/**
 * /agents/[name]/chat/[channelType]/[chatId] — read-only mirror of a
 * non-web conversation (typically a Telegram chat the user wants to observe
 * from the dashboard while still having their independent `web-main` chat).
 *
 * Reuses the same `ChatView` as the primary chat page — passing a non-"web"
 * channelType flips it into read-only mode automatically.
 */
import { notFound } from "next/navigation";

import { bridge } from "@/lib/bridge/client";
import { ChatView } from "@/components/chat/chat-view";

export default async function AgentChatMirrorPage({
  params,
}: {
  params: Promise<{ name: string; channelType: string; chatId: string }>;
}) {
  const { name, channelType, chatId } = await params;

  // Guardrail — this route should never be used for web chats (that's what
  // /agents/[name]/chat without params is for). If we see one, 404 rather
  // than rendering a duplicate composer-free web chat.
  if (channelType === "web") {
    notFound();
  }

  const history = await bridge.conversations.history(name, channelType, chatId);

  return (
    <ChatView
      agent={name}
      channelType={channelType}
      chatId={chatId}
      initialTurns={history.turns}
    />
  );
}
