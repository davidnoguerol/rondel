"use client";

/**
 * Live agents list for the sidebar — Client Component.
 *
 * Owns ONE SSE connection (via `useAgentStateTail`) and renders the
 * full per-agent navigation list with inline live status dots. Receiving
 * the agents array as initial data from the parent Server Component
 * means the link list is identical to a server-only render until the
 * SSE stream attaches and starts adding dots.
 *
 * ## Why this is a Client Component, not server
 *
 * The dots reflect live state. Putting one Client Component per row
 * would either (a) open one EventSource per agent (wasteful) or
 * (b) require a context provider above all of them. Owning the entire
 * list here gives us one EventSource and zero context plumbing.
 *
 * ## Why this exists in M2
 *
 * It's the second concrete consumer of the SSE primitive after
 * `<LedgerStream>`, and intentionally exercises the snapshot+delta
 * semantics of the agent-state hook. If `useAgentStateTail` were
 * subtly wrong, this component would surface it — so building it
 * alongside the ledger stream catches abstraction issues now, not
 * three streams from now.
 *
 * ## Visual rules for the dot
 *
 * Per agent, derive ONE state from its current conversations:
 *   - any `crashed`/`halted` → red (something needs attention)
 *   - any `busy`             → blue (work in flight)
 *   - any `idle`/`starting`  → green (alive, ready)
 *   - all `stopped` or empty → no dot at all
 *
 * Dots only appear after the SSE snapshot frame arrives — never flash
 * placeholders. Until then, the rows render exactly as the Server
 * Component would have.
 */

import { useMemo } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import type { AgentStateEntry, AgentSummary } from "@/lib/bridge";
import { useAgentStateTail } from "@/lib/streams";
import { cn } from "@/lib/utils";

type Tone = "success" | "info" | "danger" | null;

const TONE_COLOR: Record<Exclude<Tone, null>, string> = {
  success: "bg-success",
  info: "bg-primary",
  danger: "bg-destructive",
};

interface LiveAgentBadgesProps {
  agents: readonly AgentSummary[];
}

export function LiveAgentBadges({ agents }: LiveAgentBadgesProps) {
  const { states, status } = useAgentStateTail();
  const pathname = usePathname();

  const isLive = status === "open" || status === "error";

  const tones = useMemo(() => {
    if (!isLive) return new Map<string, Tone>();
    const result = new Map<string, Tone>();
    for (const agent of agents) {
      result.set(agent.name, deriveTone(states, agent.name));
    }
    return result;
  }, [states, agents, isLive]);

  return (
    <ul className="space-y-0.5">
      {agents.map((agent) => {
        const tone = tones.get(agent.name) ?? null;
        const href = `/agents/${agent.name}` as const;
        const active =
          pathname === href || pathname.startsWith(`${href}/`);
        return (
          <li key={agent.name}>
            <Link
              href={href as `/agents/${string}`}
              className={cn(
                "flex items-center justify-between gap-2 rounded-md px-3 py-1.5 text-sm transition-colors",
                active
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              )}
            >
              <span className="flex min-w-0 items-center gap-2">
                {tone && (
                  <span
                    aria-label={`${agent.name} ${tone}`}
                    className={cn(
                      "inline-block size-1.5 shrink-0 rounded-full",
                      TONE_COLOR[tone],
                      tone === "info" && "animate-pulse"
                    )}
                  />
                )}
                <span className="truncate">{agent.name}</span>
              </span>
              {agent.activeConversations > 0 && (
                <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground">
                  {agent.activeConversations}
                </span>
              )}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

function deriveTone(
  states: ReadonlyMap<string, AgentStateEntry>,
  agentName: string,
): Tone {
  let any = false;
  let busy = false;
  let attention = false;
  for (const entry of states.values()) {
    if (entry.agentName !== agentName) continue;
    any = true;
    if (entry.state === "crashed" || entry.state === "halted") attention = true;
    if (entry.state === "busy") busy = true;
  }
  if (!any) return null;
  if (attention) return "danger";
  if (busy) return "info";
  return "success";
}
