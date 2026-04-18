"use client";

import { useTransition } from "react";

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

  const created = new Date(record.createdAt).toLocaleTimeString();

  return (
    <article className="px-4 py-3 rounded-lg border border-border bg-surface-raised shadow-sm">
      <header className="flex items-start justify-between gap-3 mb-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-xs text-ink-subtle">
            <code className="font-mono text-ink-muted">{record.agentName}</code>
            <span>·</span>
            <span className="uppercase tracking-wide font-semibold text-amber-600">
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
          <h3 className="mt-1 font-mono text-sm text-ink">{record.toolName}</h3>
        </div>
        <time className="shrink-0 text-xs text-ink-subtle">{created}</time>
      </header>

      <pre className="my-3 px-3 py-2 rounded bg-surface-muted text-xs text-ink-muted overflow-x-auto whitespace-pre-wrap break-words">
        {record.summary}
      </pre>

      <div className="flex gap-2 justify-end">
        <button
          type="button"
          disabled={isPending}
          onClick={() => handle("deny")}
          className="px-3 py-1.5 rounded-md text-sm font-medium border border-red-300 text-red-700 hover:bg-red-50 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Deny
        </button>
        <button
          type="button"
          disabled={isPending}
          onClick={() => handle("allow")}
          className="px-3 py-1.5 rounded-md text-sm font-medium bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Approve
        </button>
      </div>
    </article>
  );
}
