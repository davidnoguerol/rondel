/**
 * Tiny status indicator dot used by live-updating panels (LedgerStream,
 * LiveAgentBadges). Pure presentation — color and pulse derived from
 * the SSE connection state.
 */
import type { StreamStatus } from "@/lib/streams";

const COLOR: Record<StreamStatus, string> = {
  open: "bg-success",
  connecting: "bg-warning",
  error: "bg-warning",
  closed: "bg-ink-subtle",
};

export function LiveDot({ status }: { status: StreamStatus }) {
  const pulse = status === "open" ? "animate-pulse" : "";
  return (
    <span
      aria-label={`stream ${status}`}
      className={`inline-block h-1.5 w-1.5 rounded-full ${COLOR[status]} ${pulse}`}
    />
  );
}
