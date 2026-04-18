"use client";

import { useEffect, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import type { ApprovalDecision, ToolUseApprovalRecord } from "@/lib/bridge";

/**
 * Interactive approval card for a tool-use approval record.
 *
 * Server-rendered content (agent, tool, summary) with client-side buttons
 * that call the Server Action passed in as a prop. The Server Action is
 * defined in the page component so it can call `revalidateTag` after
 * resolving.
 *
 * Uses `useTransition` so the button states don't flicker between click
 * and revalidation — React marks the action as pending and the UI shows a
 * disabled state until the parent refetches.
 */
export function ApprovalCard({
  record,
  onResolve,
}: {
  record: ToolUseApprovalRecord;
  onResolve: (requestId: string, decision: ApprovalDecision) => Promise<void>;
}) {
  const [isPending, startTransition] = useTransition();

  const handle = (decision: ApprovalDecision) => {
    startTransition(async () => {
      try {
        await onResolve(record.requestId, decision);
      } catch (err) {
        // The error boundary at the page root will catch actual HTTP
        // errors. For now, surface the failure in the console — the
        // next auto-refresh will re-render from the daemon state of
        // record, which is authoritative.
        console.error("Approval resolve failed:", err);
      }
    });
  };

  return (
    <article className="rounded-lg border border-border bg-card px-4 py-3 shadow-sm">
      <header className="mb-2 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <code className="font-mono text-foreground/80">
              {record.agentName}
            </code>
            <span>·</span>
            <span className="font-semibold uppercase tracking-wide text-warning">
              {record.reason.replace(/_/g, " ")}
            </span>
            {record.channelType && record.chatId && (
              <>
                <span>·</span>
                <span className="font-mono">
                  {record.channelType}:{record.chatId}
                </span>
              </>
            )}
          </div>
          <h3 className="mt-1 font-mono text-sm text-foreground">
            {record.toolName}
          </h3>
        </div>
        <ClientTime
          ts={record.createdAt}
          className="shrink-0 text-xs text-muted-foreground"
        />
      </header>

      <pre className="my-3 overflow-x-auto whitespace-pre-wrap break-words rounded bg-muted px-3 py-2 text-xs text-muted-foreground">
        {record.summary}
      </pre>

      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={isPending}
          onClick={() => handle("deny")}
        >
          Deny
        </Button>
        <Button
          type="button"
          variant="default"
          size="sm"
          disabled={isPending}
          onClick={() => handle("allow")}
        >
          Approve
        </Button>
      </div>
    </article>
  );
}

/**
 * SSR-safe timestamp. Server emits an empty <time>; the effect fills in
 * the user's local time after hydration. Avoids a locale/timezone
 * mismatch between server and client.
 */
function ClientTime({
  ts,
  className,
}: {
  readonly ts: string;
  readonly className?: string;
}) {
  const [label, setLabel] = useState<string>("");
  useEffect(() => {
    try {
      setLabel(new Date(ts).toLocaleTimeString());
    } catch {
      setLabel("");
    }
  }, [ts]);
  return (
    <time
      dateTime={ts}
      className={className}
      title={ts}
      suppressHydrationWarning
    >
      {label}
    </time>
  );
}
