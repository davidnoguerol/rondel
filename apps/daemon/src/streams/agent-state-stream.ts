/**
 * Live agent-state stream source.
 *
 * Subscribes once to `ConversationManager.onStateChange` and emits one
 * SSE frame per state transition to all connected clients. On connect,
 * `snapshot()` returns the current state of every active conversation
 * so the client renders a complete picture before live deltas arrive.
 *
 * The wire format uses two distinct event tags:
 *   - `agent_state.snapshot` — sent once per client, carries an array
 *     of `AgentStateEvent` entries (one per active conversation).
 *   - `agent_state.delta` — sent on each subsequent transition, carries
 *     a single `AgentStateEvent`.
 *
 * The web client distinguishes them in its reducer:
 *   - on `snapshot` → replace the entire Map keyed by conversationKey.
 *   - on `delta`    → set one entry in the Map.
 *
 * One instance lives for the daemon's lifetime. The shared upstream
 * subscription (one listener on ConversationManager) fans out to N
 * SSE clients via the `clients` set.
 */

import type { ConversationManager } from "../agents/conversation-manager.js";
import type { AgentStateEvent } from "../shared/types/agents.js";

import type { SseFrame, StreamSource } from "./sse-types.js";

const SNAPSHOT_EVENT = "agent_state.snapshot";
const DELTA_EVENT = "agent_state.delta";

/**
 * Discriminated frame payload. The web client validates this with a
 * Zod schema; the discriminator is `kind` and matches the `event` tag
 * (`snapshot` ↔ `agent_state.snapshot`, `delta` ↔ `agent_state.delta`).
 */
export type AgentStateFrameData =
  | { readonly kind: "snapshot"; readonly entries: readonly AgentStateEvent[] }
  | { readonly kind: "delta"; readonly entry: AgentStateEvent };

export class AgentStateStreamSource implements StreamSource<AgentStateFrameData> {
  private readonly clients = new Set<(frame: SseFrame<AgentStateFrameData>) => void>();
  private readonly unsubscribeFromCM: () => void;

  constructor(private readonly conversationManager: ConversationManager) {
    this.unsubscribeFromCM = conversationManager.onStateChange((entry) => {
      if (this.clients.size === 0) return;
      const frame: SseFrame<AgentStateFrameData> = {
        event: DELTA_EVENT,
        data: { kind: "delta", entry },
      };
      for (const send of [...this.clients]) {
        try {
          send(frame);
        } catch {
          // Per-client failures must not affect other clients —
          // `handleSseRequest` cleans up via req/res listeners.
        }
      }
    });
  }

  subscribe(send: (frame: SseFrame<AgentStateFrameData>) => void): () => void {
    this.clients.add(send);
    return () => {
      this.clients.delete(send);
    };
  }

  /**
   * Sent immediately after `subscribe` by `handleSseRequest`. Returns
   * the snapshot of every active conversation's current state.
   */
  snapshot(): SseFrame<AgentStateFrameData> {
    const entries = this.conversationManager.getAllConversationStates();
    return {
      event: SNAPSHOT_EVENT,
      data: { kind: "snapshot", entries },
    };
  }

  dispose(): void {
    this.unsubscribeFromCM();
    this.clients.clear();
  }

  getClientCount(): number {
    return this.clients.size;
  }
}
