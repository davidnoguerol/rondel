/**
 * Rondel domain types mirrored for the web package.
 *
 * Everything under apps/web/ that needs a daemon domain type imports from
 * THIS file. Never import directly from @rondel/daemon/* elsewhere — ESLint
 * enforces this (see apps/web/.eslintrc.cjs, added alongside lint setup).
 *
 * ## Why we mirror instead of re-export
 *
 * The ideal shape is `export type { LedgerEvent } from "@rondel/daemon/..."`
 * but that requires the daemon to declare a stable subpath `exports` map in
 * its package.json, and pulls in the daemon's compiled .d.ts tree. It also
 * risks accidental runtime bleed: several daemon type modules (e.g.
 * ledger-types.ts) contain `import { z } from "zod"` at file scope. With
 * `verbatimModuleSyntax: true` TypeScript erases these at compile time, but
 * a single future contributor writing `import { LedgerEventKind } from ...`
 * (no `type`) would pull zod into the client bundle.
 *
 * Mirroring keeps the daemon shippable without the web package and the web
 * package build-clean without the daemon source. The web's Zod response
 * schemas (apps/web/lib/bridge/schemas.ts) catch any drift at runtime: if
 * the daemon changes a field shape, the schema fails parse and the user
 * sees a clear "BridgeError" instead of undefined rendering.
 *
 * When a type is added or removed in the daemon, update this file and the
 * matching schema in `bridge/schemas.ts`. The fixture test at
 * `bridge/__tests__/schemas.test.ts` guards against silent drift.
 *
 * Source files in the daemon this mirrors:
 *   - apps/daemon/src/shared/types/agents.ts
 *   - apps/daemon/src/shared/types/sessions.ts
 *   - apps/daemon/src/ledger/ledger-types.ts
 */

// -----------------------------------------------------------------------------
// Agents
// -----------------------------------------------------------------------------

export type AgentState =
  | "starting"
  | "idle"
  | "busy"
  | "crashed"
  | "halted"
  | "stopped";

// -----------------------------------------------------------------------------
// Conversations (from the daemon's /agents and /conversations/:name responses)
// -----------------------------------------------------------------------------

export interface ConversationSummary {
  readonly chatId: string;
  readonly state: AgentState;
  readonly sessionId: string | null;
}

export interface AgentSummary {
  readonly name: string;
  readonly org?: string;
  readonly activeConversations: number;
  readonly conversations: readonly ConversationSummary[];
}

// -----------------------------------------------------------------------------
// Ledger
// -----------------------------------------------------------------------------

export type LedgerEventKind =
  | "user_message"
  | "agent_response"
  | "inter_agent_sent"
  | "inter_agent_received"
  | "subagent_spawned"
  | "subagent_result"
  | "cron_completed"
  | "cron_failed"
  | "session_start"
  | "session_resumed"
  | "session_reset"
  | "crash"
  | "halt";

export interface LedgerEvent {
  readonly ts: string; // ISO 8601
  readonly agent: string;
  readonly kind: LedgerEventKind;
  readonly chatId?: string;
  readonly summary: string;
  readonly detail?: unknown;
}

// -----------------------------------------------------------------------------
// Version handshake
// -----------------------------------------------------------------------------

export interface BridgeVersion {
  readonly apiVersion: number;
  readonly rondelVersion: string;
}
