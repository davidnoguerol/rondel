import { EventEmitter } from "node:events";
import type { SubagentInfo, CronJob, CronRunResult, MessageSentEvent, MessageDeliveredEvent, MessageReplyEvent, ThreadCompletedEvent } from "./types/index.js";

/**
 * Rondel lifecycle hooks.
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

// --- Conversation hooks ---

export interface ConversationMessageInEvent {
  readonly agentName: string;
  readonly chatId: string;
  readonly text: string;
  readonly senderId?: string;
  readonly senderName?: string;
}

export interface ConversationResponseEvent {
  readonly agentName: string;
  readonly chatId: string;
  readonly text: string;
}

// --- Session lifecycle hooks ---

export interface SessionStartEvent {
  readonly agentName: string;
  readonly chatId: string;
  readonly sessionId: string;
}

export interface SessionResumedEvent {
  readonly agentName: string;
  readonly chatId: string;
  readonly sessionId: string;
}

export interface SessionResetEvent {
  readonly agentName: string;
  readonly chatId: string;
}

export interface SessionCrashEvent {
  readonly agentName: string;
  readonly chatId: string;
  readonly sessionId: string;
}

export interface SessionHaltEvent {
  readonly agentName: string;
  readonly chatId: string;
  readonly sessionId: string;
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
  // Conversation events (Layer 1 — Ledger)
  "conversation:message_in": [event: ConversationMessageInEvent];
  "conversation:response": [event: ConversationResponseEvent];
  // Session lifecycle (Layer 1 — Ledger)
  "session:start": [event: SessionStartEvent];
  "session:resumed": [event: SessionResumedEvent];
  "session:reset": [event: SessionResetEvent];
  "session:crash": [event: SessionCrashEvent];
  "session:halt": [event: SessionHaltEvent];
  // Subagent lifecycle
  "subagent:spawning": [event: SubagentSpawningEvent];
  "subagent:completed": [event: SubagentCompletedEvent];
  "subagent:failed": [event: SubagentFailedEvent];
  // Cron lifecycle
  "cron:completed": [event: CronCompletedEvent];
  "cron:failed": [event: CronFailedEvent];
  // Inter-agent messaging (Layer 2)
  "message:sent": [event: MessageSentEvent];
  "message:delivered": [event: MessageDeliveredEvent];
  "message:reply": [event: MessageReplyEvent];
  "thread:completed": [event: ThreadCompletedEvent];
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
export class RondelHooks extends EventEmitter<HookEvents> {
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
        console.error(`[RondelHooks] Listener for "${String(eventName)}" threw: ${message}`);
      }
    }
    return listeners.length > 0;
  }
}

/** Single shared instance — created once, passed via dependency injection. */
export function createHooks(): RondelHooks {
  return new RondelHooks();
}
