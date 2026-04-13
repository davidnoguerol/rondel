/**
 * Barrel for the bridge client.
 *
 * Public surface the rest of the web package imports from:
 *   import { bridge } from "@/lib/bridge";
 *   import { BridgeError, RondelNotRunningError } from "@/lib/bridge";
 *
 * Nothing under `@/lib/bridge/*` is a public import site — always go
 * through this barrel so internal refactors (splitting fetcher, moving
 * schemas) don't ripple through every page.
 */
export { bridge } from "./client";
export {
  BridgeError,
  BridgeSchemaError,
  BridgeVersionMismatchError,
  RondelNotRunningError,
} from "./errors";
export type {
  AgentSummary,
  ConversationsResponse,
  LedgerEvent,
  LedgerQueryResponse,
  ListAgentsResponse,
  MemoryResponse,
  VersionResponse,
} from "./schemas";
