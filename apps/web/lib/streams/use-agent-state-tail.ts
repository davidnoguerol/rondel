"use client";

/**
 * Typed wrapper over `useStreamTopic` for the live agent-state feed.
 *
 * Returns a Map keyed by `${agentName}:${chatId}:${channelType}` (the same
 * shape the daemon uses internally as a `ConversationKey`). Consumers
 * iterate the Map to render per-conversation state, filter by agent,
 * count active conversations, etc.
 *
 * The hook is the only place in the web app that knows about the
 * snapshot/delta wire shape — every consumer just sees the resolved Map.
 *
 * ## Why this wrapper exists separately from `useLedgerTail`
 *
 * The agent-state topic emits TWO event tags:
 *   - `agent_state.snapshot` (full state, sent once per connect)
 *   - `agent_state.delta`    (one transition, sent live)
 *
 * `useLedgerTail` exposes a flat append-only list — perfect for the
 * ledger but wrong for state, where we want "current value per key."
 * This wrapper applies a reducer over the raw frames to produce the
 * Map, and exposes both the Map and the connection status.
 *
 * If a future stream type also wants reducer semantics (system stats,
 * cron schedules), it gets its own typed wrapper here. The
 * `useStreamTopic` primitive stays minimal.
 */

import { useMemo } from "react";

import {
  AgentStateFrameSchema,
  type AgentStateEntry,
  type AgentStateFrame,
  type RawSseFrame,
} from "@/lib/bridge";

import { useStreamTopic } from "./use-stream-topic";
import type { StreamStatus } from "./use-event-stream";

export interface UseAgentStateTailResult {
  /**
   * Current state per conversation, keyed by
   * `${agentName}:${chatId}:${channelType}`.
   *
   * Empty until the first snapshot frame arrives.
   */
  readonly states: ReadonlyMap<string, AgentStateEntry>;
  /** Connection state — drives the "Live" indicator UI. */
  readonly status: StreamStatus;
}

export function useAgentStateTail(): UseAgentStateTailResult {
  const { events, status } = useStreamTopic<AgentStateFrame>(
    "agents-state",
    parseAgentStateFrame,
  );

  // Reduce the frame stream into a Map. We rebuild on every render — fine
  // for v1 (10s of conversations max). If this ever shows up in profiles,
  // switch to a useReducer with structural sharing.
  const states = useMemo(() => {
    const map = new Map<string, AgentStateEntry>();
    for (const frame of events) {
      if (frame.event === "agent_state.snapshot") {
        // Snapshot replaces the entire map.
        map.clear();
        for (const entry of frame.data.entries) {
          map.set(keyFor(entry), entry);
        }
      } else {
        // Delta mutates one entry.
        map.set(keyFor(frame.data.entry), frame.data.entry);
      }
    }
    return map;
  }, [events]);

  return { states, status };
}

function keyFor(entry: AgentStateEntry): string {
  return `${entry.agentName}:${entry.chatId}:${entry.channelType}`;
}

function parseAgentStateFrame(raw: RawSseFrame): AgentStateFrame | null {
  const parsed = AgentStateFrameSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
