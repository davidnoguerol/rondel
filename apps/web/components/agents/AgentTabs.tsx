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

  const tabs = [
    { href: base, label: "Overview", match: base },
    { href: `${base}/ledger`, label: "Ledger", match: `${base}/ledger` },
    { href: `${base}/memory`, label: "Memory", match: `${base}/memory` },
  ];

  return (
    <nav className="border-b border-border bg-surface-raised px-8">
      <ul className="flex gap-6 -mb-px">
        {tabs.map((tab) => {
          const active = pathname === tab.match;
          return (
            <li key={tab.href}>
              <Link
                href={tab.href as `/agents/${string}`}
                className={`inline-flex items-center h-10 text-sm font-medium border-b-2 transition-colors ${
                  active
                    ? "border-accent text-ink"
                    : "border-transparent text-ink-muted hover:text-ink hover:border-border"
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
