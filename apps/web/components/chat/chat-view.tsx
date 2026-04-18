"use client";

/**
 * Client-side chat view.
 *
 * Thin wrapper: owns the SSE subscription for the conversation and fans
 * it out to (a) the Rondel runtime reducer and (b) the header's live
 * status indicator. assistant-ui's <Thread> provides the presentation.
 *
 * Split:
 *   - rondel-runtime.tsx → transport + reducer + external-store runtime
 *   - chat-view.tsx (this file) → SSE subscription + layout shell + Thread mount
 */

import { Thread } from "@/components/assistant-ui/thread";
import { LiveDot } from "@/components/ledger/live-dot";
import { Badge } from "@/components/ui/badge";
import type { ConversationTurn } from "@/lib/bridge";
import { useConversationTail } from "@/lib/streams";
import { cn } from "@/lib/utils";
import { RondelRuntimeProvider } from "./rondel-runtime";

type StreamStatus = "connecting" | "open" | "error" | "closed";

interface ChatViewProps {
  readonly agent: string;
  readonly channelType: string;
  readonly chatId: string;
  readonly initialTurns: readonly ConversationTurn[];
}

export function ChatView({
  agent,
  channelType,
  chatId,
  initialTurns,
}: ChatViewProps) {
  const isWeb = channelType === "web";

  // ONE EventSource per conversation. The events buffer is passed into
  // the runtime; the status is rendered in the header. Previously each
  // consumer opened its own SSE connection, which doubled load on the
  // daemon and could briefly desync status between the two views.
  const { events, status } = useConversationTail(agent, channelType, chatId);

  return (
    <div
      className={cn(
        "flex h-full min-h-0 flex-col overflow-hidden bg-card"
      )}
    >
      <ChatHeader
        channelType={channelType}
        chatId={chatId}
        isWeb={isWeb}
        status={status}
      />
      <div className="min-h-0 flex-1">
        <RondelRuntimeProvider
          agent={agent}
          channelType={channelType}
          chatId={chatId}
          initialTurns={initialTurns}
          events={events}
        >
          <Thread readOnly={!isWeb} />
        </RondelRuntimeProvider>
      </div>
    </div>
  );
}

/**
 * Conversation metadata row above the Thread. Live dot reflects the
 * single SSE connection owned by the parent.
 */
function ChatHeader({
  channelType,
  chatId,
  isWeb,
  status,
}: {
  channelType: string;
  chatId: string;
  isWeb: boolean;
  status: StreamStatus;
}) {
  return (
    <div className="flex items-center justify-between border-b border-border bg-muted/40 px-4 py-2">
      <div className="flex items-center gap-2 text-sm text-foreground">
        <span className="font-medium">
          {isWeb ? "Web chat" : `Mirroring ${channelType}`}
        </span>
        {!isWeb && (
          <Badge variant="warning" className="text-[10px]">
            read-only
          </Badge>
        )}
        <span className="font-mono text-[11px] text-muted-foreground">
          {chatId}
        </span>
      </div>
      <div className="flex items-center gap-1.5">
        <LiveDot status={status} />
        <span className="text-[11px] text-muted-foreground">
          {labelFor(status)}
        </span>
      </div>
    </div>
  );
}

function labelFor(status: StreamStatus): string {
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
