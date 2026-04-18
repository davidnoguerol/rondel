/**
 * Chat subtree layout. A secondary sidebar lists every conversation for
 * this agent (web chat first, then read-only mirrors) so the user can
 * switch between them without leaving the chat surface. The right-hand
 * pane hosts the active conversation and is sized to fill the remaining
 * height — the message list inside is the only scrollable region.
 */
import { bridge } from "@/lib/bridge/client";
import { ChatSidebar } from "@/components/chat/chat-sidebar";

export const dynamic = "force-dynamic";

export default async function ChatLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ name: string }>;
}) {
  const { name } = await params;
  const conversations = await bridge.agents.conversations(name);

  return (
    <div className="flex h-full overflow-hidden">
      <ChatSidebar agent={name} conversations={conversations} />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
    </div>
  );
}
