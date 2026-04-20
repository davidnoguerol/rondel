/**
 * Tasks module barrel.
 *
 * Per-org, file-backed task board. See `docs/phase-1/02-task-board-design.md`
 * for the full design.
 *
 * External consumers import from this directory; internal files import
 * each other directly. No imports from sibling domains (`approvals/`,
 * `heartbeats/`, `ledger/`, etc.) land here — keep the barrel clean.
 */

export {
  BLOCKED_STALE_MS,
  IN_PROGRESS_STALE_MS,
  PENDING_STALE_MS,
  classifyStaleness,
  detectCycle,
  openBlockers,
  orderTasks,
  type DagPeer,
  type StalenessPeer,
  type StatusPeer,
  type VirtualDagTask,
} from "./task-dag.js";
