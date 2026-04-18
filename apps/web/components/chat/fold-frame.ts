/**
 * Pure frame reducer for the Rondel chat runtime.
 *
 * Extracted from rondel-runtime.tsx so the reducer and its companion
 * helpers can be unit-tested without mounting React / assistant-ui.
 * The runtime re-imports these — one source of truth.
 *
 * Protocol contract:
 *   - `user_message`          → FIFO reconcile a matching optimistic
 *                               bubble (same role + text), else append.
 *   - `agent_response`        → if `blockId` matches a streaming bubble,
 *                               replace its text/ts and clear
 *                               `streaming`. Otherwise append a fresh
 *                               assistant bubble.
 *   - `agent_response_delta`  → fold into the bubble with the same
 *                               `blockId`; if none exists, create a new
 *                               streaming bubble seeded with `chunk`.
 *   - `typing_start` / `typing_stop` / `session` → no-ops here
 *                               (handled by the runtime's local state).
 */

import type { ConversationTailFrame } from "@/lib/streams";

export type RondelRuntimeRole = "user" | "assistant";

/**
 * Internal message shape owned by the runtime. `streaming` tracks an
 * assistant message whose text is still being composed from
 * `agent_response_delta` frames; `optimistic` tracks a user message
 * drawn locally before the daemon echoed it back.
 */
export interface DisplayMessage {
  readonly id: string;
  readonly role: RondelRuntimeRole;
  readonly text: string;
  readonly ts?: string;
  readonly blockId?: string;
  readonly streaming?: boolean;
  readonly optimistic?: boolean;
}

export function foldFrame(
  prev: DisplayMessage[],
  frame: ConversationTailFrame
): DisplayMessage[] {
  switch (frame.kind) {
    case "user_message": {
      const idx = prev.findIndex(
        (m) =>
          m.optimistic === true && m.role === "user" && m.text === frame.text
      );
      if (idx >= 0) {
        // Preserve the message id across the optimistic → server reconcile.
        // assistant-ui treats messages as unique by id, so changing the id
        // here would register the echoed message as a NEW branch of the
        // same parent (producing the "2 / 2" BranchPicker UI). Keeping
        // the same id makes it a content update on the same message.
        const next = prev.slice();
        next[idx] = {
          id: prev[idx].id,
          role: "user",
          text: frame.text,
          ts: frame.ts,
        };
        return next;
      }
      return [
        ...prev,
        {
          id: `srv-${frame.ts}-${prev.length}`,
          role: "user",
          text: frame.text,
          ts: frame.ts,
        },
      ];
    }
    case "agent_response": {
      if (frame.blockId) {
        const idx = prev.findIndex(
          (m) => m.blockId === frame.blockId && m.role === "assistant"
        );
        if (idx >= 0) {
          // Preserve the message id (same reason as in user_message):
          // changing it would make assistant-ui think this is a branch
          // alternative to the streamed bubble, not the final version
          // of it.
          const next = prev.slice();
          next[idx] = {
            ...next[idx],
            text: frame.text,
            ts: frame.ts,
            streaming: false,
          };
          return next;
        }
      }
      return [
        ...prev,
        {
          id: `srv-${frame.ts}-${prev.length}`,
          role: "assistant",
          text: frame.text,
          ts: frame.ts,
          blockId: frame.blockId,
        },
      ];
    }
    case "agent_response_delta": {
      const idx = prev.findIndex(
        (m) => m.blockId === frame.blockId && m.role === "assistant"
      );
      if (idx >= 0) {
        const next = prev.slice();
        next[idx] = {
          ...next[idx],
          text: next[idx].text + frame.chunk,
        };
        return next;
      }
      return [
        ...prev,
        {
          id: `stream-${frame.blockId}`,
          role: "assistant",
          text: frame.chunk,
          blockId: frame.blockId,
          streaming: true,
        },
      ];
    }
    case "typing_start":
    case "typing_stop":
    case "session":
      return prev;
  }
}
