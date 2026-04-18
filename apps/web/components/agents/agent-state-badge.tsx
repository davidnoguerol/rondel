import { Badge } from "@/components/ui/badge";
import type { AgentState } from "@/lib/bridge";

type BadgeVariant = "success" | "info" | "warning" | "destructive" | "muted";

const STATE_VARIANT = {
  starting: "info",
  idle: "success",
  busy: "info",
  crashed: "destructive",
  halted: "warning",
  stopped: "muted",
} as const satisfies Record<AgentState, BadgeVariant>;

/**
 * Semantic badge for an agent/conversation state. Centralizes the
 * state → variant mapping so every screen renders state consistently.
 */
export function AgentStateBadge({ state }: { state: AgentState }) {
  return <Badge variant={STATE_VARIANT[state]}>{state}</Badge>;
}
