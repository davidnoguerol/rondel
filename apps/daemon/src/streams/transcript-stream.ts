/**
 * Live transcript stream source (observability — design §7.3).
 *
 * Notification-only frames: `transcript.appended` tells the dashboard
 * something landed in a mirror (the browser refetches the paginated
 * entries endpoint — multi-MB tool payloads never ride the dashboard-wide
 * stream, and read-time redaction stays in exactly one place: the GET
 * endpoint). `transcript.turn` additionally carries the per-turn usage
 * rollup so live cost widgets don't refetch.
 *
 * No snapshot — transcripts are append-only; initial state comes from the
 * GET endpoints (same posture as LedgerStreamSource). Per-agent filtering
 * is client-side per the multiplex policy.
 */

import type { RondelHooks, TranscriptAppendedEvent, TurnCompleteEvent } from "../shared/hooks.js";
import type { SseFrame, StreamSource } from "./sse-types.js";

const APPENDED_EVENT = "transcript.appended";
const TURN_EVENT = "transcript.turn";

export type TranscriptFrameData =
  | {
      readonly kind: "appended";
      readonly agent: string;
      readonly sessionId: string;
      readonly mode: string;
      readonly entryKind: string;
      readonly ts: string;
    }
  | {
      readonly kind: "turn";
      readonly agent: string;
      readonly sessionId: string;
      readonly mode: string;
      readonly channelType?: string;
      readonly chatId?: string;
      readonly usage: {
        readonly inputTokens: number;
        readonly outputTokens: number;
        readonly cacheReadTokens: number;
        readonly cacheCreationTokens: number;
      };
      readonly stopReason: string;
      readonly isError: boolean;
      /** Price-table estimate — never billing truth (design §7.3). */
      readonly costUsd?: number;
      readonly toolNames: readonly string[];
      readonly ts: string;
    };

export class TranscriptStreamSource implements StreamSource<TranscriptFrameData> {
  private readonly clients = new Set<(frame: SseFrame<TranscriptFrameData>) => void>();
  private readonly unsubscribeFromHooks: Array<() => void> = [];

  constructor(hooks: RondelHooks) {
    const onAppended = (e: TranscriptAppendedEvent): void => {
      if (this.clients.size === 0) return;
      this.fanOut({
        event: APPENDED_EVENT,
        data: { kind: "appended", agent: e.agentName, sessionId: e.sessionId, mode: e.mode, entryKind: e.kind, ts: new Date().toISOString() },
      });
    };
    const onTurn = (e: TurnCompleteEvent): void => {
      if (this.clients.size === 0) return;
      this.fanOut({
        event: TURN_EVENT,
        data: {
          kind: "turn",
          agent: e.agentName,
          sessionId: e.sessionId,
          mode: e.mode,
          channelType: e.channelType,
          chatId: e.chatId,
          usage: e.usage,
          stopReason: e.stopReason,
          isError: e.isError,
          costUsd: e.costUsd,
          toolNames: e.toolNames,
          ts: new Date().toISOString(),
        },
      });
    };

    hooks.on("transcript:appended", onAppended);
    hooks.on("turn:complete", onTurn);
    this.unsubscribeFromHooks.push(
      () => hooks.off("transcript:appended", onAppended),
      () => hooks.off("turn:complete", onTurn),
    );
  }

  private fanOut(frame: SseFrame<TranscriptFrameData>): void {
    // Snapshot the client set before iterating — an unsubscribe during
    // fan-out must not invalidate the iterator (HeartbeatStreamSource shape).
    for (const send of [...this.clients]) {
      try {
        send(frame);
      } catch {
        // Per-client failures must not affect other clients.
      }
    }
  }

  subscribe(send: (frame: SseFrame<TranscriptFrameData>) => void): () => void {
    this.clients.add(send);
    return () => {
      this.clients.delete(send);
    };
  }

  /** Append-only source — no snapshot; initial state via GET endpoints. */
  snapshot(): undefined {
    return undefined;
  }

  dispose(): void {
    for (const unsub of this.unsubscribeFromHooks) {
      try {
        unsub();
      } catch {
        /* */
      }
    }
    this.clients.clear();
  }

  getClientCount(): number {
    return this.clients.size;
  }
}
