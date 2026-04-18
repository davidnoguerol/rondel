/**
 * /agents/[name]/chat — the primary web chat for an agent.
 *
 * Single canonical `web-main` conversation per agent, shared across all
 * browser tabs. Keeps the process count flat regardless of how many
 * tabs the user has open.
 *
 * Server Component: pre-fetches the transcript on the request path and
 * passes it to <ChatView>. Mirror conversations are listed by the
 * parent chat layout's ChatSidebar — not here.
 */
import { bridge } from "@/lib/bridge/client";
import { WEB_MAIN_CHAT_ID } from "@/lib/bridge";
import { ChatView } from "@/components/chat/chat-view";

export default async function AgentChatPage({
  params,
}: {
  params: Promise<{ name: string }>;
}) {
  const { name } = await params;

  // Returns `{ turns: [], sessionId: null }` for a brand-new conversation,
  // so this never 404s on first visit.
  const history = await bridge.conversations.history(
    name,
    "web",
    WEB_MAIN_CHAT_ID
  );

  return (
    <ChatView
      agent={name}
      channelType="web"
      chatId={WEB_MAIN_CHAT_ID}
      initialTurns={history.turns}
    />
  );
}
