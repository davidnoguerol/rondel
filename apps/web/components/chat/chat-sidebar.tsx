"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ConversationSummary } from "@/lib/bridge";
import { cn } from "@/lib/utils";

type Props = {
  agent: string;
  conversations: readonly ConversationSummary[];
};

/**
 * Secondary sidebar shown only within the agent chat subtree.
 *
 * Lists the agent's web chat (the primary, always-present destination)
 * and any non-web conversations as read-only mirrors. Synthetic
 * `agent-mail` conversations are hidden — they're an internal channel
 * for inter-agent messaging, not something the user interacts with
 * directly.
 */
export function ChatSidebar({ agent, conversations }: Props) {
  const pathname = usePathname();
  const base = `/agents/${agent}/chat`;

  const visible = conversations.filter((c) => c.chatId !== "agent-mail");
  const web = visible.find((c) => c.chatId.startsWith("web-"));
  const mirrors = visible.filter((c) => !c.chatId.startsWith("web-"));

  const webActive = pathname === base;

  return (
    <aside className="hidden h-full w-60 shrink-0 overflow-y-auto border-r border-border bg-muted/30 md:block">
      <div className="space-y-4 p-2">
        <div>
          <SectionLabel>Web</SectionLabel>
          <NavItem
            href={base}
            active={webActive}
            label="Web chat"
            hint={web ? web.state : "new"}
          />
        </div>

        {mirrors.length > 0 && (
          <div>
            <SectionLabel>Mirroring</SectionLabel>
            <ul className="space-y-0.5">
              {mirrors.map((conv) => {
                const ct = inferChannelType(conv.chatId);
                const href = `${base}/${ct}/${encodeURIComponent(conv.chatId)}`;
                const active = pathname === href;
                return (
                  <li key={conv.chatId}>
                    <NavItem
                      href={href}
                      active={active}
                      label={conv.chatId}
                      sub={ct}
                      hint={conv.state}
                    />
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>
    </aside>
  );
}

/**
 * Chat ids don't carry their channelType, so we infer it from the id
 * format. This is the same heuristic used by the old "Also observing"
 * card: numeric ids are Telegram, "web-*" are the web adapter, anything
 * else is an internal/agent-mail style id we wouldn't link to.
 */
function inferChannelType(chatId: string): string {
  if (chatId.startsWith("web-")) return "web";
  if (/^-?\d+$/.test(chatId)) return "telegram";
  return "internal";
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
      {children}
    </h3>
  );
}

function NavItem({
  href,
  active,
  label,
  sub,
  hint,
}: {
  href: string;
  active: boolean;
  label: string;
  sub?: string;
  hint?: string;
}) {
  return (
    <Link
      href={href as `/${string}`}
      className={cn(
        "flex items-center gap-2 rounded-md px-3 py-1.5 text-sm transition-colors",
        active
          ? "bg-card text-foreground shadow-sm"
          : "text-muted-foreground hover:bg-card hover:text-foreground"
      )}
    >
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-mono text-xs">{label}</span>
        {sub && (
          <span className="text-[10px] text-muted-foreground">{sub}</span>
        )}
      </span>
      {hint && (
        <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
          {hint}
        </span>
      )}
    </Link>
  );
}
