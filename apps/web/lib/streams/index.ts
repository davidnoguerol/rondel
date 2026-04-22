/**
 * Public surface of the streams module — the typed React hooks that
 * components import.
 *
 * Two transport primitives live here:
 *   - `useEventStream` owns ITS OWN EventSource. Use it only for
 *     dedicated, per-entity streams like the conversation tail.
 *   - `useStreamTopic` reads from the shared multiplexed stream owned
 *     by `MultiplexedStreamProvider`. Every dashboard-wide topic
 *     (approvals, agents-state, tasks, ledger, schedules) goes through
 *     this path so the whole dashboard shares a single connection.
 *
 * When adding a new topic, wire a hook on top of `useStreamTopic`
 * alongside the existing ones rather than introducing another
 * EventSource — that's what causes per-origin connection-pool
 * saturation and navigation hangs.
 */
export { useEventStream } from "./use-event-stream";
export type {
  StreamStatus,
  UseEventStreamOptions,
  UseEventStreamResult,
} from "./use-event-stream";

export { MultiplexedStreamProvider } from "./multiplex-provider";
export { useStreamTopic } from "./use-stream-topic";

export { useLedgerTail } from "./use-ledger-tail";
export type { UseLedgerTailOptions } from "./use-ledger-tail";

export { useAgentStateTail } from "./use-agent-state-tail";
export type { UseAgentStateTailResult } from "./use-agent-state-tail";

export { useConversationTail } from "./use-conversation-tail";
export type { ConversationTailFrame } from "./use-conversation-tail";

export { useTasksTail } from "./use-tasks-tail";
export type { TaskTailEvent, UseTasksTailOptions } from "./use-tasks-tail";
