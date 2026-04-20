"use client";

/**
 * Per-agent tab nav. Client Component so it can read the active path via
 * `usePathname()` — otherwise every server render would need to pass the
 * current segment down as a prop.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";

interface AgentTabsProps {
  agentName: string;
}

export function AgentTabs({ agentName }: AgentTabsProps) {
  const pathname = usePathname();
  const base = `/agents/${agentName}`;

  // `prefix: true` makes the tab active for any child route under its `match`
  // path — used by the Chat tab so `/agents/x/chat/telegram/123` still
  // highlights it while viewing a read-only mirror of a non-web chat.
  const tabs: ReadonlyArray<{ href: string; label: string; match: string; prefix?: boolean }> = [
    { href: base, label: "Overview", match: base },
    { href: `${base}/chat`, label: "Chat", match: `${base}/chat`, prefix: true },
    { href: `${base}/ledger`, label: "Ledger", match: `${base}/ledger` },
    { href: `${base}/schedules`, label: "Schedules", match: `${base}/schedules` },
    { href: `${base}/memory`, label: "Memory", match: `${base}/memory` },
    { href: `${base}/context`, label: "Context", match: `${base}/context` },
  ];

  return (
    <nav className="border-b border-border bg-card px-8">
      <ul className="flex gap-6 -mb-px">
        {tabs.map((tab) => {
          const active = tab.prefix
            ? pathname === tab.match || pathname.startsWith(`${tab.match}/`)
            : pathname === tab.match;
          return (
            <li key={tab.href}>
              <Link
                href={tab.href as `/agents/${string}`}
                className={`inline-flex items-center h-10 text-sm font-medium border-b-2 transition-colors ${
                  active
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground hover:border-border"
                }`}
              >
                {tab.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
