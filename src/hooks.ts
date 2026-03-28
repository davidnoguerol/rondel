import { EventEmitter } from "node:events";
import type { SubagentInfo, CronJob, CronRunResult } from "./types.js";

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

// --- Subagent hooks ---

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

// --- Cron hooks ---

export interface CronCompletedEvent {
  readonly agentName: string;
  readonly job: CronJob;
  readonly result: CronRunResult;
}

export interface CronFailedEvent {
  readonly agentName: string;
  readonly job: CronJob;
  readonly result: CronRunResult;
  readonly consecutiveErrors: number;
}

interface HookEvents {
  "subagent:spawning": [event: SubagentSpawningEvent];
  "subagent:completed": [event: SubagentCompletedEvent];
  "subagent:failed": [event: SubagentFailedEvent];
  "cron:completed": [event: CronCompletedEvent];
  "cron:failed": [event: CronFailedEvent];
}

/**
 * EventEmitter with per-listener error boundaries.
 *
 * Node's default emit() stops on the first listener throw, preventing
 * subsequent listeners from running and propagating the error into the
 * emitter (scheduler, subagent-manager). We override emit() to call
 * each listener in its own try/catch — one failure doesn't crash the
 * system or prevent other listeners from running.
 *
 * Uses console.error (not injected logger) because this is a last-resort
 * safety net — if we're catching here, something is already wrong.
 */
export class FlowclawHooks extends EventEmitter<HookEvents> {
  override emit<K extends keyof HookEvents>(
    eventName: K,
    ...args: HookEvents[K]
  ): boolean {
    const listeners = this.listeners(eventName);
    for (const listener of listeners) {
      try {
        (listener as (...a: unknown[]) => void)(...args);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[FlowclawHooks] Listener for "${String(eventName)}" threw: ${message}`);
      }
    }
    return listeners.length > 0;
  }
}

/** Single shared instance — created once, passed via dependency injection. */
export function createHooks(): FlowclawHooks {
  return new FlowclawHooks();
}
