/**
 * Public surface of the streams module — the typed React hooks that
 * components import. The generic `useEventStream` is exported too, but
 * it should rarely be used directly — write a typed wrapper alongside
 * the existing ones whenever a new stream type appears.
 */
export { useEventStream } from "./use-event-stream";
export type {
  StreamStatus,
  UseEventStreamOptions,
  UseEventStreamResult,
} from "./use-event-stream";

export { useLedgerTail } from "./use-ledger-tail";
export type { UseLedgerTailOptions } from "./use-ledger-tail";

export { useAgentStateTail } from "./use-agent-state-tail";
export type { UseAgentStateTailResult } from "./use-agent-state-tail";

export { useConversationTail } from "./use-conversation-tail";
export type { ConversationTailFrame } from "./use-conversation-tail";
