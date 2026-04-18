"use client";

/**
 * Client Component that hydrates the approvals list from SSE.
 *
 * The server-rendered `/approvals` page fetches the initial pending +
 * resolved list from the bridge and passes it here. This component
 * opens an EventSource on `/api/bridge/approvals/tail` and folds each
 * incoming frame into state — see `use-approval-stream` for the
 * reducer logic.
 *
 * The server action `onResolve` is passed as a plain function prop
 * (Next's "use server" action boundary is satisfied by the RSC page
 * that imports it). Tapping Approve/Deny invokes the action which
 * POSTs /approvals/:id/resolve on the daemon; the subsequent
 * `approval.resolved` SSE frame re-flows the list without a refetch.
 */

import { useEffect, useState } from "react";

import type { ApprovalDecision, ApprovalRecord } from "@/lib/bridge";

import { useApprovalStream } from "@/lib/streams/use-approval-stream";

import { ApprovalCard } from "./approval-card";

export interface ApprovalsLiveViewProps {
  readonly initialPending: readonly ApprovalRecord[];
  readonly initialResolved: readonly ApprovalRecord[];
  readonly onResolve: (requestId: string, decision: ApprovalDecision) => Promise<void>;
}

export function ApprovalsLiveView(props: ApprovalsLiveViewProps) {
  const { initialPending, initialResolved, onResolve } = props;
  const { pending, resolved, status } = useApprovalStream({
    initialPending,
    initialResolved,
  });

  return (
    <>
      <section className="mb-10">
        <SectionHeading count={pending.length} status={status}>
          Pending
        </SectionHeading>
        {pending.length === 0 ? (
          <EmptyState>No pending approvals — agents are running freely.</EmptyState>
        ) : (
          <ul className="space-y-3">
            {pending.map((record) => (
              <li key={record.requestId}>
                <ApprovalCard record={record} onResolve={onResolve} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <SectionHeading count={resolved.length}>Recently resolved</SectionHeading>
        {resolved.length === 0 ? (
          <EmptyState>No resolved approvals yet.</EmptyState>
        ) : (
          <ul className="space-y-2">
            {resolved.slice(0, 20).map((record) => (
              <li key={record.requestId}>
                <ResolvedRow record={record} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function SectionHeading({
  count,
  status,
  children,
}: {
  readonly count: number;
  readonly status?: "connecting" | "open" | "error" | "closed";
  readonly children: React.ReactNode;
}) {
  return (
    <h2 className="mb-3 flex items-baseline gap-2">
      <span className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
        {children}
      </span>
      <span className="text-xs text-muted-foreground">({count})</span>
      {status && (
        <span
          className={
            status === "open"
              ? "text-xs text-success"
              : status === "error"
                ? "text-xs text-destructive"
                : "text-xs text-muted-foreground"
          }
        >
          · {status === "open" ? "live" : status}
        </span>
      )}
    </h2>
  );
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-dashed border-border px-4 py-6 text-sm italic text-muted-foreground">
      {children}
    </div>
  );
}

function ResolvedRow({ record }: { record: ApprovalRecord }) {
  const decisionClass =
    record.decision === "allow"
      ? "text-success"
      : record.decision === "deny"
        ? "text-destructive"
        : "text-muted-foreground";
  const decisionLabel = record.decision ? record.decision.toUpperCase() : "UNKNOWN";

  return (
    <div className="flex items-center gap-3 rounded-md border border-border bg-muted px-4 py-2 text-sm">
      <span className={`font-mono text-xs font-semibold ${decisionClass}`}>
        {decisionLabel}
      </span>
      <code className="font-mono text-xs text-muted-foreground">
        {record.agentName}
      </code>
      <span className="text-muted-foreground">·</span>
      <code className="font-mono text-xs">{record.toolName}</code>
      <span className="flex-1 truncate text-muted-foreground">
        {record.summary}
      </span>
      <ClientTime ts={record.resolvedAt} />
      <span className="text-xs text-muted-foreground">
        ({record.resolvedBy ?? "unknown"})
      </span>
    </div>
  );
}

/**
 * Locale/timezone-dependent timestamps are rendered client-only so SSR
 * and the first client render emit identical HTML. Server outputs an
 * empty placeholder; the effect fills in the user's local time on the
 * tick after hydration.
 */
function ClientTime({ ts }: { readonly ts: string | undefined | null }) {
  const [label, setLabel] = useState<string>("");
  useEffect(() => {
    if (!ts) {
      setLabel("—");
      return;
    }
    try {
      setLabel(new Date(ts).toLocaleTimeString());
    } catch {
      setLabel("");
    }
  }, [ts]);
  return (
    <time
      dateTime={ts ?? undefined}
      className="text-xs tabular-nums text-muted-foreground"
      title={ts ?? undefined}
      suppressHydrationWarning
    >
      {label}
    </time>
  );
}
