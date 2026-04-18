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
      <span className="text-sm font-semibold uppercase tracking-wider text-ink-muted">
        {children}
      </span>
      <span className="text-xs text-ink-subtle">({count})</span>
      {status && (
        <span
          className={
            status === "open"
              ? "text-xs text-emerald-600"
              : status === "error"
                ? "text-xs text-red-600"
                : "text-xs text-ink-subtle"
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
    <div className="px-4 py-6 rounded-md border border-dashed border-border text-sm text-ink-subtle italic">
      {children}
    </div>
  );
}

function ResolvedRow({ record }: { record: ApprovalRecord }) {
  const decisionClass =
    record.decision === "allow"
      ? "text-emerald-600"
      : record.decision === "deny"
        ? "text-red-600"
        : "text-ink-subtle";
  const decisionLabel = record.decision ? record.decision.toUpperCase() : "UNKNOWN";
  const when = record.resolvedAt ? new Date(record.resolvedAt).toLocaleTimeString() : "—";

  return (
    <div className="flex items-center gap-3 px-4 py-2 rounded-md border border-border bg-surface-muted text-sm">
      <span className={`font-mono text-xs font-semibold ${decisionClass}`}>
        {decisionLabel}
      </span>
      <code className="font-mono text-xs text-ink-muted">{record.agentName}</code>
      <span className="text-ink-subtle">·</span>
      <code className="font-mono text-xs">{record.toolName}</code>
      <span className="text-ink-subtle flex-1 truncate">{record.summary}</span>
      <span className="text-xs text-ink-subtle">{when}</span>
      <span className="text-xs text-ink-subtle">
        ({record.resolvedBy ?? "unknown"})
      </span>
    </div>
  );
}
