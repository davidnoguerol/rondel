import { Badge } from "@/components/ui/Badge";
import type { AgentState } from "@/lib/bridge";

const STATE_TONE = {
  starting: "info",
  idle: "success",
  busy: "info",
  crashed: "danger",
  halted: "warning",
  stopped: "muted",
} as const satisfies Record<AgentState, "info" | "success" | "danger" | "warning" | "muted">;

/**
 * Semantic badge for an agent/conversation state. Centralizes the
 * state → tone mapping so every screen renders state consistently.
 */
export function AgentStateBadge({ state }: { state: AgentState }) {
  return <Badge tone={STATE_TONE[state]}>{state}</Badge>;
}
