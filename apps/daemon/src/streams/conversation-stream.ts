/**
 * Per-conversation live stream source.
 *
 * Powers `GET /conversations/{agent}/{channelType}/{chatId}/tail`. Unlike the
 * append-only ledger stream (which is a single, long-lived `StreamSource`
 * shared by all SSE clients), this source is constructed lazily per request:
 * each subscriber gets its own instance scoped to a specific conversation
 * key so the in-process hook subscriptions can be torn down when the last
 * tab for that conversation closes.
 *
 * The source listens to `RondelHooks` for user messages, agent responses,
 * and session lifecycle events, filtered to the target conversation. For
 * web conversations only, it ALSO taps the `WebChannelAdapter`'s per-
 * conversation ring buffer + live frames so the UI sees typing indicators
 * as the agent works.
 *
 * Frame shape is a discriminated union keyed by `kind`. The web client
 * re-validates the wire format with the same schema (derived from the
 * daemon's Zod schema in `bridge/schemas.ts`).
 */

import type { RondelHooks } from "../shared/hooks.js";
import type {
  WebChannelFrame,
  WebChannelAdapter,
} from "../channels/web/index.js";

import type { SseFrame, StreamSource } from "./sse-types.js";

/** Wire-level event tag — kept stable across daemon versions. */
const FRAME_EVENT = "conversation.frame";

// ---------------------------------------------------------------------------
// Frame types
// ---------------------------------------------------------------------------

export type ConversationStreamFrame =
  | {
      readonly kind: "user_message";
      readonly ts: string;
      readonly text: string;
      readonly senderName?: string;
    }
  | {
      readonly kind: "agent_response";
      readonly ts: string;
      readonly text: string;
      /**
       * Optional — present when the daemon is emitting partial-message
       * deltas for this agent. Matches the `blockId` used on any preceding
       * `agent_response_delta` frames. Clients accumulate deltas keyed by
       * this id and reconcile against the complete block as the source of
       * truth ("deltas are hints, blocks are truth").
       */
      readonly blockId?: string;
    }
  | {
      /**
       * One chunk of a streaming assistant response. Append to the
       * in-progress bubble for `blockId`; do not persist or treat as
       * authoritative — the subsequent `agent_response` frame with the
       * same blockId will overwrite whatever partial text you've
       * accumulated. A dropped delta is not a bug; the complete block
       * always arrives.
       */
      readonly kind: "agent_response_delta";
      readonly ts: string;
      readonly blockId: string;
      readonly chunk: string;
    }
  | {
      readonly kind: "typing_start";
      readonly ts: string;
    }
  | {
      readonly kind: "typing_stop";
      readonly ts: string;
    }
  | {
      readonly kind: "session";
      readonly ts: string;
      readonly event: "start" | "resumed" | "reset" | "crash" | "halt";
      readonly sessionId?: string;
    };

// ---------------------------------------------------------------------------
// ConversationStreamSource
// ---------------------------------------------------------------------------

export interface ConversationStreamOptions {
  readonly agentName: string;
  readonly channelType: string;
  readonly chatId: string;
  readonly hooks: RondelHooks;
  /** Optional — required only for channelType === "web" to tap typing frames. */
  readonly webAdapter?: WebChannelAdapter;
}

export class ConversationStreamSource implements StreamSource<ConversationStreamFrame> {
  private readonly clients = new Set<(frame: SseFrame<ConversationStreamFrame>) => void>();
  private readonly unsubscribers: Array<() => void> = [];
  private disposed = false;

  constructor(private readonly opts: ConversationStreamOptions) {
    this.wireHooks();
    this.wireWebAdapter();
  }

  // -------------------------------------------------------------------------
  // StreamSource contract
  // -------------------------------------------------------------------------

  subscribe(send: (frame: SseFrame<ConversationStreamFrame>) => void): () => void {
    if (this.disposed) {
      // Returning a no-op unsubscribe matches the behavior of the other
      // stream sources — a disposed source just doesn't dispatch anything.
      return () => {};
    }
    this.clients.add(send);
    return () => {
      this.clients.delete(send);
    };
  }

  // No `snapshot()` — the stream is event-driven. Historical context for a
  // web conversation comes from the ring buffer via `replayRingBuffer()`,
  // which the bridge handler supplies as a `replay` callback. For non-web
  // channels, initial context comes from the transcript history endpoint.

  dispose(): void {
    this.disposed = true;
    for (const unsub of this.unsubscribers) {
      try {
        unsub();
      } catch {
        // Listeners that throw on unsubscribe are broken; ignore.
      }
    }
    this.unsubscribers.length = 0;
    this.clients.clear();
  }

  getClientCount(): number {
    return this.clients.size;
  }

  // -------------------------------------------------------------------------
  // Replay helper (web channel only)
  // -------------------------------------------------------------------------

  /**
   * Drain the web adapter's ring buffer for this conversation as SSE frames.
   * Called by the bridge handler's `replay` callback so a browser tab that
   * opens mid-stream sees the last few frames before the live flow attaches.
   */
  replayRingBuffer(send: (frame: SseFrame<ConversationStreamFrame>) => void): void {
    if (this.opts.channelType !== "web" || !this.opts.webAdapter) return;
    const frames = this.opts.webAdapter.getRingBuffer(this.opts.agentName, this.opts.chatId);
    for (const frame of frames) {
      const translated = translateWebFrame(frame);
      if (translated) {
        send({ event: FRAME_EVENT, data: translated });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private matches(agentName: string, chatId: string): boolean {
    return agentName === this.opts.agentName && chatId === this.opts.chatId;
  }

  private emit(data: ConversationStreamFrame): void {
    if (this.clients.size === 0) return;
    const frame: SseFrame<ConversationStreamFrame> = { event: FRAME_EVENT, data };
    for (const send of [...this.clients]) {
      try {
        send(frame);
      } catch {
        // Per-client errors must never affect siblings — `handleSseRequest`
        // cleans up dead sockets via req.close / res.error listeners.
      }
    }
  }

  private wireHooks(): void {
    const { hooks } = this.opts;

    const onMessageIn = (event: {
      agentName: string;
      chatId: string;
      text: string;
      senderName?: string;
    }) => {
      if (!this.matches(event.agentName, event.chatId)) return;
      this.emit({
        kind: "user_message",
        ts: new Date().toISOString(),
        text: event.text,
        senderName: event.senderName,
      });
    };

    const onResponse = (event: {
      agentName: string;
      chatId: string;
      text: string;
      blockId?: string;
    }) => {
      if (!this.matches(event.agentName, event.chatId)) return;
      this.emit({
        kind: "agent_response",
        ts: new Date().toISOString(),
        text: event.text,
        blockId: event.blockId,
      });
    };

    // Streaming deltas — passed through to web subscribers. The frame is
    // ephemeral (no ring-buffer persistence, no replay on reconnect) so a
    // dropped delta never breaks state: the corresponding `agent_response`
    // frame with the same blockId is the source of truth and overwrites
    // whatever partial text the client has accumulated.
    const onResponseDelta = (event: {
      agentName: string;
      chatId: string;
      blockId: string;
      chunk: string;
    }) => {
      if (!this.matches(event.agentName, event.chatId)) return;
      this.emit({
        kind: "agent_response_delta",
        ts: new Date().toISOString(),
        blockId: event.blockId,
        chunk: event.chunk,
      });
    };

    const onSession = (eventKind: "start" | "resumed" | "reset" | "crash" | "halt") =>
      (event: { agentName: string; chatId: string; sessionId?: string }) => {
        if (!this.matches(event.agentName, event.chatId)) return;
        this.emit({
          kind: "session",
          ts: new Date().toISOString(),
          event: eventKind,
          sessionId: event.sessionId,
        });
      };

    hooks.on("conversation:message_in", onMessageIn);
    hooks.on("conversation:response", onResponse);
    hooks.on("conversation:response_delta", onResponseDelta);
    const onStart = onSession("start");
    const onResumed = onSession("resumed");
    const onReset = onSession("reset");
    const onCrash = onSession("crash");
    const onHalt = onSession("halt");
    hooks.on("session:start", onStart);
    hooks.on("session:resumed", onResumed);
    hooks.on("session:reset", onReset);
    hooks.on("session:crash", onCrash);
    hooks.on("session:halt", onHalt);

    this.unsubscribers.push(
      () => hooks.off("conversation:message_in", onMessageIn),
      () => hooks.off("conversation:response", onResponse),
      () => hooks.off("conversation:response_delta", onResponseDelta),
      () => hooks.off("session:start", onStart),
      () => hooks.off("session:resumed", onResumed),
      () => hooks.off("session:reset", onReset),
      () => hooks.off("session:crash", onCrash),
      () => hooks.off("session:halt", onHalt),
    );
  }

  private wireWebAdapter(): void {
    const { channelType, webAdapter, agentName, chatId } = this.opts;
    if (channelType !== "web" || !webAdapter) return;

    // Typing indicators on the web channel ride through the adapter's
    // per-conversation fan-out. We double-subscribe intentionally: hooks
    // give us `conversation:response` (the text-block stream used by every
    // channel), and the adapter gives us the web-specific typing frames.
    //
    // The adapter's `agent_response` fan-out would be redundant with the
    // hook subscription above, so we filter it out in `translateWebFrame`.
    const unsub = webAdapter.subscribeConversation(agentName, chatId, (frame) => {
      const translated = translateWebFrame(frame);
      if (translated) this.emit(translated);
    });
    this.unsubscribers.push(unsub);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Translate a web-adapter frame to a conversation stream frame.
 *
 * Returns `null` for `agent_response` frames — those are already emitted via
 * the `conversation:response` hook subscription, and double-emitting would
 * duplicate them in the browser's merged timeline.
 */
function translateWebFrame(frame: WebChannelFrame): ConversationStreamFrame | null {
  switch (frame.kind) {
    case "agent_response":
      return null;
    case "typing_start":
      return { kind: "typing_start", ts: frame.ts };
    case "typing_stop":
      return { kind: "typing_stop", ts: frame.ts };
  }
}
