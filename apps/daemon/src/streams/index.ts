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
