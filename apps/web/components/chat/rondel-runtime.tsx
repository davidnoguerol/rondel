"use client";

/**
 * Rondel chat runtime for assistant-ui.
 *
 * Bridges Rondel's web-channel transport (POST /web/messages/send + SSE
 * /conversations/:agent/:channelType/:chatId/tail) to assistant-ui's
 * ExternalStoreRuntime. Owns the same frame reducer the previous
 * handwritten ChatView used — block-id folding for streaming deltas,
 * optimistic user messages, read-only mirror mode — and exposes it
 * through the runtime interface.
 */

import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type AppendMessage,
} from "@assistant-ui/react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import type { ConversationTurn } from "@/lib/bridge";
import type { ConversationTailFrame } from "@/lib/streams";

import { foldFrame, type DisplayMessage, type RondelRuntimeRole } from "./fold-frame";
import { convertMessage, extractText } from "./message-helpers";

export type { DisplayMessage, RondelRuntimeRole } from "./fold-frame";
export { convertMessage, extractText } from "./message-helpers";
export { foldFrame } from "./fold-frame";

interface RondelRuntimeProps {
  readonly agent: string;
  readonly channelType: string;
  readonly chatId: string;
  readonly initialTurns: readonly ConversationTurn[];
  /**
   * Frame stream for this conversation. Hoisted into the parent so the
   * parent can fan a single SSE subscription out to sibling consumers
   * (e.g. a header that wants the connection status) instead of each
   * consumer opening its own EventSource.
   */
  readonly events: readonly ConversationTailFrame[];
  readonly children: ReactNode;
}

export function RondelRuntimeProvider({
  agent,
  channelType,
  chatId,
  initialTurns,
  events,
  children,
}: RondelRuntimeProps) {
  const isWeb = channelType === "web";

  // Seed only when the conversation tuple changes — otherwise a parent
  // re-render with a fresh `initialTurns` array reference would wipe live
  // messages. This matches the invariant from the previous ChatView.
  const seeded = useMemo<DisplayMessage[]>(
    () =>
      initialTurns.map((turn, idx) => ({
        id: `hist-${idx}`,
        role: turn.role as RondelRuntimeRole,
        text: turn.text,
        ts: turn.ts,
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [agent, channelType, chatId]
  );

  const [messages, setMessages] = useState<DisplayMessage[]>(seeded);
  const [typing, setTyping] = useState(false);

  useEffect(() => {
    setMessages(seeded);
    setTyping(false);
  }, [agent, channelType, chatId, seeded]);

  // Cursor-based frame consumption. The upstream buffer is append-only
  // until the URL changes (which we handle by resetting the cursor
  // alongside `messages`).
  const cursorRef = useRef(0);
  useEffect(() => {
    if (events.length <= cursorRef.current) {
      cursorRef.current = events.length;
      return;
    }
    const newFrames = events.slice(cursorRef.current);
    cursorRef.current = events.length;
    if (newFrames.length === 0) return;

    setMessages((prev) => {
      let next = prev;
      for (const frame of newFrames) next = foldFrame(next, frame);
      return next;
    });
    for (const frame of newFrames) {
      if (frame.kind === "typing_start") setTyping(true);
      else if (frame.kind === "typing_stop") setTyping(false);
    }
  }, [events]);

  const onNew = useCallback(
    async (message: AppendMessage): Promise<void> => {
      if (!isWeb) {
        throw new Error("This is a read-only mirror. Use the web chat to reply.");
      }
      const text = extractText(message);
      if (!text) return;

      const optimisticId = `opt-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
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
          const body = (await res.json().catch(() => null)) as
            | { error?: string }
            | null;
          throw new Error(body?.error ?? `HTTP ${res.status}`);
        }
      } catch (err) {
        // Roll back the optimistic message and rethrow so the runtime
        // surfaces the failure via MessagePrimitive.Error.
        setMessages((prev) => prev.filter((m) => m.id !== optimisticId));
        throw err;
      }
    },
    [agent, chatId, isWeb]
  );

  // Running = either a typing-indicator is active OR an assistant block
  // is still accumulating deltas. Composer shows "cancel" while true.
  const isRunning = useMemo(
    () => typing || messages.some((m) => m.role === "assistant" && m.streaming),
    [typing, messages]
  );

  const runtime = useExternalStoreRuntime<DisplayMessage>({
    messages,
    isRunning,
    isDisabled: !isWeb,
    onNew,
    convertMessage,
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      {children}
    </AssistantRuntimeProvider>
  );
}


