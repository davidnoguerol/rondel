/**
 * Public surface of the streams module.
 *
 * External consumers (the bridge handler routes, the orchestrator
 * lifecycle) import from here, never from the concrete files. This
 * keeps the SSE wire format an internal detail of the streams folder.
 */
export { handleSseRequest } from "./sse-handler.js";
export type { HandleSseRequestOptions } from "./sse-handler.js";
export type { SseFrame, StreamSource } from "./sse-types.js";

export { LedgerStreamSource } from "./ledger-stream.js";
export { AgentStateStreamSource } from "./agent-state-stream.js";
export { ApprovalStreamSource } from "./approval-stream.js";
export { ConversationStreamSource } from "./conversation-stream.js";
export type { ConversationStreamFrame, ConversationStreamOptions } from "./conversation-stream.js";
export { ScheduleStreamSource } from "./schedule-stream.js";
export type {
  ScheduleFramePayload,
  ScheduleDeletedFramePayload,
  ScheduleSnapshotLookup,
} from "./schedule-stream.js";
export { HeartbeatStreamSource } from "./heartbeat-stream.js";
export type { HeartbeatFrameData } from "./heartbeat-stream.js";
export { TaskStreamSource } from "./task-stream.js";
export type { TaskFrameData } from "./task-stream.js";
