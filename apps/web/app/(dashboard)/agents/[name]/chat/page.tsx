/**
 * /agents/[name]/chat — the primary web chat for an agent.
 *
 * Option B: a single canonical `web-main` conversation per agent, shared
 * across all browser tabs. Keeps the process count flat regardless of how
 * many tabs the user has open.
 *
 * This page is a Server Component — it pre-fetches the transcript on the
 * request path and passes it to `<ChatView>`, which handles live streaming.
 */
import { bridge } from "@/lib/bridge/client";
import { WEB_MAIN_CHAT_ID } from "@/lib/bridge";
import { ChatView } from "@/components/chat/ChatView";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import Link from "next/link";

export default async function AgentChatPage({
  params,
}: {
  params: Promise<{ name: string }>;
}) {
  const { name } = await params;

  // History fetch — returns `{ turns: [], sessionId: null }` for a brand new
  // conversation, so this never 404s on first visit.
  const history = await bridge.conversations.history(name, "web", WEB_MAIN_CHAT_ID);

  // Also list non-web conversations so the user can jump to a read-only
  // mirror view of e.g. their Telegram chat.
  const conversations = await bridge.agents.conversations(name);
  const mirrorCandidates = conversations.filter(
    (c) => !c.chatId.startsWith("web-") && c.chatId !== "agent-mail",
  );

  return (
    <div className="p-8 space-y-6">
      <ChatView
        agent={name}
        channelType="web"
        chatId={WEB_MAIN_CHAT_ID}
        initialTurns={history.turns}
      />

      {mirrorCandidates.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Also observing</CardTitle>
          </CardHeader>
          <CardBody>
            <p className="text-xs text-ink-subtle mb-3">
              Read-only mirrors of this agent&apos;s other conversations. Your
              web chat is independent — these are just live views.
            </p>
            <ul className="space-y-1">
              {mirrorCandidates.map((c) => {
                // We don't have channelType on the conversation summary, so
                // infer it from the chatId convention: numeric = telegram,
                // otherwise fall back to "internal". This works today because
                // the only non-web, non-agent-mail channel is Telegram.
                const channelType = /^-?\d+$/.test(c.chatId) ? "telegram" : "internal";
                return (
                  <li key={c.chatId}>
                    <Link
                      href={`/agents/${name}/chat/${channelType}/${encodeURIComponent(c.chatId)}`}
                      className="flex items-center justify-between rounded-md px-3 py-2 hover:bg-surface-muted transition"
                    >
                      <span className="font-mono text-sm text-ink">
                        {channelType} · {c.chatId}
                      </span>
                      <span className="text-[11px] text-ink-muted">{c.state}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </CardBody>
        </Card>
      )}
    </div>
  );
}
