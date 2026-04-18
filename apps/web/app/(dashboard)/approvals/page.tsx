/**
 * /approvals — HITL approval console.
 *
 * Operators see the Tier 1 safety-net escalations: pending tool-use
 * approvals they can Approve/Deny via a server action that POSTs
 * /approvals/:id/resolve, and a tail of recently resolved decisions
 * for audit.
 *
 * Live updates: the initial list is rendered server-side (this file).
 * A client sub-component subscribes to `/api/bridge/approvals/tail`
 * over SSE and folds new frames into the list — no `router.refresh()`
 * polling, no `revalidateTag` dance. The server action just POSTs
 * the decision; the daemon's `approval.resolved` hook fires the SSE
 * frame that re-flows the UI.
 */
import { bridge } from "@/lib/bridge/client";
import type { ApprovalDecision } from "@/lib/bridge";

import { ApprovalsLiveView } from "@/components/approvals/approvals-live-view";

export const dynamic = "force-dynamic";

// -----------------------------------------------------------------------------
// Server Action — operator decision
// -----------------------------------------------------------------------------

async function resolveAction(requestId: string, decision: ApprovalDecision): Promise<void> {
  "use server";
  await bridge.approvals.resolve(requestId, decision, "web");
  // No revalidateTag — the SSE tail delivers the updated record to
  // every connected tab within milliseconds.
}

// -----------------------------------------------------------------------------
// Page
// -----------------------------------------------------------------------------

export default async function ApprovalsPage() {
  const { pending, resolved } = await bridge.approvals.list();

  return (
    <div className="p-8 max-w-5xl mx-auto">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold text-ink">Approvals</h1>
        <p className="mt-1 text-sm text-ink-subtle">
          Tool-use escalations from the first-class rondel_* tools — Approve or
          Deny here or from Telegram.
        </p>
      </header>

      <ApprovalsLiveView
        initialPending={pending}
        initialResolved={resolved}
        onResolve={resolveAction}
      />
    </div>
  );
}
