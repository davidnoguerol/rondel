import { EventEmitter } from "node:events";
import type { SubagentInfo } from "./types.js";

/**
 * FlowClaw lifecycle hooks.
 *
 * A typed EventEmitter for cross-cutting concerns. Modules emit events
 * when significant things happen; other modules subscribe to react.
 * This keeps concerns decoupled — the emitter doesn't know or care
 * what the listeners do.
 *
 * Pattern: AgentManager emits "subagent:spawning", Router listens
 * and sends a Telegram notification. AgentManager never imports Router.
 */

export interface SubagentSpawningEvent {
  readonly id: string;
  readonly parentAgentName: string;
  readonly parentChatId: string;
  readonly task: string;
  readonly template?: string;
}

export interface SubagentCompletedEvent {
  readonly info: SubagentInfo;
}

export interface SubagentFailedEvent {
  readonly info: SubagentInfo;
}

interface HookEvents {
  "subagent:spawning": [event: SubagentSpawningEvent];
  "subagent:completed": [event: SubagentCompletedEvent];
  "subagent:failed": [event: SubagentFailedEvent];
}

export class FlowclawHooks extends EventEmitter<HookEvents> {}

/** Single shared instance — created once, passed via dependency injection. */
export function createHooks(): FlowclawHooks {
  return new FlowclawHooks();
}
