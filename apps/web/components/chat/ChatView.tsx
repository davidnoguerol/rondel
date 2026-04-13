"use client";

/**
 * Client-side chat view — history + live tail + (optional) composer.
 *
 * Architecture:
 * - Server Component parent fetches history via `bridge.conversations.history`
 *   and passes it in as `initialTurns`.
 * - We subscribe to the per-conversation SSE tail and fold each frame into
 *   local message state. User messages appear optimistically on submit and
 *   are reconciled when the `user_message` frame echoes back.
 * - Typing indicator is a simple boolean toggled by typing_start/stop frames.
 * - Read-only mode (channelType !== "web") hides the composer and shows a
 *   "mirror" banner. All other behavior — history, live tail, auto-scroll —
 *   is identical, which makes the mirror view a natural byproduct.
 */

import { useEffect, useMemo, useRef, useState } from "react";

import type { ConversationTurn } from "@/lib/bridge";
import { useConversationTail, type ConversationTailFrame } from "@/lib/streams";

import { ChatComposer } from "./ChatComposer";
import { Message, type MessageRole } from "./Message";
import { LiveDot } from "@/components/ledger/LiveDot";

/**
 * One row in the chat view.
 *
 * Streaming contract:
 *   - `blockId` is set for assistant messages whose text is being
 *     progressively composed from `agent_response_delta` frames.
 *   - `streaming: true` means the message is still incomplete; the text
 *     shown so far is an accumulated partial. When the corresponding
 *     `agent_response` frame arrives, `streaming` clears and `text` is
 *     replaced with the canonical complete block — "deltas are hints,
 *     blocks are truth".
 *   - `optimistic: true` marks a user message we drew locally before the
 *     server echoed it back. Reconciled on the matching `user_message`
 *     frame.
 */
interface DisplayMessage {
  readonly id: string;
  readonly role: MessageRole;
  readonly text: string;
  readonly ts?: string;
  readonly blockId?: string;
  readonly streaming?: boolean;
  readonly optimistic?: boolean;
}

interface ChatViewProps {
  readonly agent: string;
  readonly channelType: string;
  readonly chatId: string;
  readonly initialTurns: readonly ConversationTurn[];
}

export function ChatView({ agent, channelType, chatId, initialTurns }: ChatViewProps) {
  const isWeb = channelType === "web";

  // Seed message state from the server-fetched transcript. Every turn gets
  // a stable id so React can key the list; the id is just the index + role
  // since transcripts are ordered and immutable.
  //
  // The seeded list MUST NOT reset mid-conversation. Parent RSC renders pass
  // fresh array references for `initialTurns` on every render, so keying the
  // reset on array identity would wipe all live messages any time the parent
  // re-rendered. Key on the conversation tuple instead — that matches the
  // actual semantics: "re-seed only when the user navigates to a different
  // conversation".
  const seeded = useMemo(
    () =>
      initialTurns.map((turn, idx) => ({
        id: `hist-${idx}`,
        role: turn.role as MessageRole,
        text: turn.text,
        ts: turn.ts,
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [agent, channelType, chatId],
  );

  const [messages, setMessages] = useState<DisplayMessage[]>(seeded);
  const [typing, setTyping] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  // Reset when navigating to a different conversation (keyed on the stable
  // conversation tuple, not the `seeded` array identity).
  useEffect(() => {
    setMessages(seeded);
    setTyping(false);
    setSendError(null);
  }, [agent, channelType, chatId, seeded]);

  const { events, status } = useConversationTail(agent, channelType, chatId);

  // Track how many stream events we've already processed so the reducer
  // can fold only new frames on each render. The `useEventStream` buffer
  // is append-only (modulo bounded trimming), so a cursor is sufficient.
  const cursorRef = useRef(0);
  useEffect(() => {
    if (events.length <= cursorRef.current) {
      // Buffer was reset (URL change). Align and skip — `events` is already
      // empty here and the `useEffect` on `seeded` has reset `messages`.
      cursorRef.current = events.length;
      return;
    }
    const newFrames = events.slice(cursorRef.current);
    cursorRef.current = events.length;
    if (newFrames.length === 0) return;

    setMessages((prev) => {
      let next = prev;
      for (const frame of newFrames) {
        next = foldFrame(next, frame);
      }
      return next;
    });
    for (const frame of newFrames) {
      if (frame.kind === "typing_start") setTyping(true);
      else if (frame.kind === "typing_stop") setTyping(false);
    }
  }, [events]);

  // Auto-scroll to bottom on new messages unless the user is scrolled up.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, typing]);

  const handleScroll = (): void => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distanceFromBottom < 100;
  };

  const handleSend = async (text: string): Promise<void> => {
    setSendError(null);
    // Optimistic user message — reconciled when the frame echoes back.
    const optimisticId = `opt-${Date.now()}`;
    setMessages((prev) => [
      ...prev,
      {
        id: optimisticId,
        role: "user",
        text,
        ts: new Date().toISOString(),
        optimistic: true,
      },
    ]);
    stickToBottomRef.current = true;

    try {
      const res = await fetch("/api/bridge/web/messages/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agent_name: agent,
          chat_id: chatId,
          text,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
    } catch (err) {
      // Remove the optimistic message and surface the error.
      setMessages((prev) => prev.filter((m) => m.id !== optimisticId));
      setSendError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="flex flex-col h-[calc(100vh-12rem)] rounded-lg border border-border bg-surface shadow-sm overflow-hidden">
      <div className="flex items-center justify-between border-b border-border bg-surface-raised px-4 py-2">
        <div className="flex items-center gap-2 text-sm text-ink">
          <span className="font-medium">
            {isWeb ? "Web chat" : `Mirroring ${channelType}`}
          </span>
          {!isWeb && (
            <span className="rounded bg-warning/20 px-2 py-0.5 text-[11px] font-medium text-warning">
              read-only
            </span>
          )}
          <span className="text-ink-subtle text-[11px] font-mono">
            {chatId}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <LiveDot status={status} />
          <span className="text-[11px] text-ink-muted">{labelFor(status)}</span>
        </div>
      </div>

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto p-4 space-y-3"
      >
        {messages.length === 0 ? (
          <div className="text-center text-sm text-ink-muted pt-8">
            {isWeb
              ? "Say hi — this is your web chat with the agent."
              : "No messages in this conversation yet."}
          </div>
        ) : (
          messages.map((m) => (
            <Message key={m.id} role={m.role} text={m.text} ts={m.ts} />
          ))
        )}
        {typing && (
          <div className="text-[11px] text-ink-subtle italic">agent is typing…</div>
        )}
      </div>

      {sendError && (
        <div className="border-t border-border bg-danger/10 px-4 py-2 text-xs text-danger">
          Send failed: {sendError}
        </div>
      )}

      {isWeb ? (
        <ChatComposer onSend={handleSend} />
      ) : (
        <div className="border-t border-border bg-surface-muted px-4 py-3 text-xs text-ink-muted">
          This is a read-only mirror. To reply, use the {channelType} channel or your{" "}
          <a href={`/agents/${agent}/chat`} className="text-accent underline">
            web chat
          </a>
          .
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Reducer — fold one frame into the current message list.
// ---------------------------------------------------------------------------

function foldFrame(prev: DisplayMessage[], frame: ConversationTailFrame): DisplayMessage[] {
  switch (frame.kind) {
    case "user_message": {
      // Reconcile against the FIRST pending optimistic user message with
      // matching text. Daemon frames arrive in send order, so FIFO pairing
      // keeps "ok" + "ok" from collapsing onto a single slot when the user
      // sends two identical messages in quick succession. Text-matching is
      // a heuristic — we don't have a client-assigned messageId — but
      // first-match is strictly better than last-match.
      const idx = prev.findIndex(
        (m) => m.optimistic === true && m.role === "user" && m.text === frame.text,
      );
      if (idx >= 0) {
        const next = prev.slice();
        next[idx] = {
          id: `srv-${frame.ts}-${idx}`,
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
      // Reconcile with an in-progress streamed message when the block id
      // matches — the complete block is the source of truth and replaces
      // whatever chunks we accumulated. No match → append as a new row,
      // which also handles the no-delta path (non-streaming channels).
      if (frame.blockId) {
        const idx = prev.findIndex(
          (m) => m.blockId === frame.blockId && m.role === "assistant",
        );
        if (idx >= 0) {
          const next = prev.slice();
          next[idx] = {
            ...next[idx],
            id: `srv-${frame.ts}-${idx}`,
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
      // Append the chunk to the in-progress bubble for this blockId,
      // creating one if this is the first chunk for the block. The
      // `streaming: true` flag is a hint for future UX (e.g. a cursor
      // affordance); it does not affect layout today.
      const idx = prev.findIndex(
        (m) => m.blockId === frame.blockId && m.role === "assistant",
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

function labelFor(status: "connecting" | "open" | "error" | "closed"): string {
  switch (status) {
    case "open":
      return "live";
    case "connecting":
      return "connecting…";
    case "error":
      return "reconnecting…";
    case "closed":
      return "offline";
  }
}

