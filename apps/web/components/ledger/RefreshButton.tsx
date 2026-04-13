"use client";

/**
 * Client-side refresh for the ledger.
 *
 * Calls `router.refresh()` which triggers Next to re-run the server
 * component tree — the page's `bridge.ledger.query()` fires again and
 * the RSC payload is streamed in-place.
 *
 * We don't hit `/api/bridge` from here because RSC refresh is the
 * idiomatic pattern: it keeps the server as the single source of truth
 * and avoids hydrating the whole list into client state just to refetch.
 *
 * The proxy exists for future cases where a component genuinely needs
 * client-side data (e.g. a chart that polls every second without a
 * full route transition).
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

export function RefreshButton() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);

  const onClick = () => {
    startTransition(() => {
      router.refresh();
      setLastRefreshed(new Date());
    });
  };

  return (
    <div className="flex items-center gap-3">
      {lastRefreshed && (
        <span className="text-xs text-ink-subtle tabular-nums">
          refreshed{" "}
          {lastRefreshed.toLocaleTimeString(undefined, {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          })}
        </span>
      )}
      <button
        type="button"
        onClick={onClick}
        disabled={isPending}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-surface-raised border border-border rounded-md text-xs font-medium text-ink hover:bg-surface-muted transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
      >
        {isPending ? "Refreshing…" : "Refresh"}
      </button>
    </div>
  );
}
