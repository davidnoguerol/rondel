/**
 * Generic HTTP handler for SSE (Server-Sent Events) endpoints.
 *
 * This is the only place in the daemon that knows the SSE wire format —
 * stream sources stay protocol-agnostic. All bridge SSE routes (ledger
 * tail, agent-state tail, future streams) call this function with their
 * source instance plus optional per-request filter/replay closures.
 *
 * ## Responsibilities, in order
 *
 * 1.  Write SSE response headers and the initial `retry:` directive.
 * 2.  Build a wrapped `send` function that applies the per-client filter
 *     before writing the frame to the response.
 * 3.  Subscribe to the source FIRST, with the wrapped send routed into a
 *     temporary buffer. This is the canonical fix for the subscribe/replay
 *     race: any deltas that arrive while we're replaying or snapshotting
 *     are queued, not lost.
 * 4.  Run `replay` (if provided) and `source.snapshot()` (if implemented).
 *     Their frames are written immediately, ahead of any buffered deltas.
 * 5.  Flush the buffer in arrival order and switch `send` to direct write
 *     for all subsequent live deltas.
 * 6.  Start a 25-second heartbeat interval — well under the typical 60s
 *     nginx and 100s Cloudflare idle defaults, low enough to keep
 *     long-lived connections alive through any future intermediary,
 *     high enough to avoid wasted wakeups on a quiet system.
 * 7.  Wire THREE cleanup signals: `req.on("close")`, `res.on("close")`,
 *     and `res.on("error")`. Either close event alone is insufficient —
 *     `EPIPE` on a write to a dead socket races the normal close and
 *     only fires through `res.on("error")`. `res.on("close")` is the
 *     belt-and-suspenders companion to `req.on("close")` for the rare
 *     transport edge case where the response stream ends without the
 *     request stream's close firing. The `cleanedUp` guard makes the
 *     triple wiring idempotent.
 *
 * ## Backpressure (deferred)
 *
 * Node `res.write()` returns `false` when the kernel send buffer is full.
 * For the v1 single-user local dashboard we don't gate on it. If we ever
 * need to handle slow clients (multi-user, remote), we add a bounded
 * queue per client and drop or slow events when it fills.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import type { SseFrame, StreamSource } from "./sse-types.js";

/** Heartbeat cadence — see file header for rationale. */
const HEARTBEAT_INTERVAL_MS = 25_000;

/** EventSource client retry directive — sent once at connection open. */
const RETRY_DIRECTIVE_MS = 3_000;

export interface HandleSseRequestOptions<T> {
  /**
   * Per-client filter applied before each frame is written.
   * Returning `false` drops the frame for this client only.
   */
  readonly filter?: (data: T) => boolean;

  /**
   * Optional pre-subscribe replay step. Called once per client between
   * subscribe and live-flow. Frames passed to its `send` callback are
   * written immediately, ahead of any deltas that arrived during replay.
   *
   * Used by the ledger stream to satisfy `?since=<ts>` requests via the
   * existing `queryLedger()` reader, without coupling the source to
   * persistence layout.
   */
  readonly replay?: (
    send: (frame: SseFrame<T>) => void,
  ) => Promise<void>;
}

/**
 * Stream a `StreamSource<T>` over an HTTP response as SSE.
 * Returns immediately after wiring; the connection lives until the
 * client disconnects or the daemon is shut down.
 */
export function handleSseRequest<T>(
  req: IncomingMessage,
  res: ServerResponse,
  source: StreamSource<T>,
  opts: HandleSseRequestOptions<T> = {},
): void {
  // If the client aborted between route dispatch and this handler
  // (rare but observed under reload bursts), writing headers will
  // throw `ERR_STREAM_WRITE_AFTER_END`. Bail out cleanly before any
  // subscription is created.
  if (res.writableEnded || res.destroyed) return;

  // 1. Response headers.
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    // Disable any caching layer between client and us.
    "Cache-Control": "no-cache, no-transform",
    // Long-lived connection.
    "Connection": "keep-alive",
    // Defeat nginx-style proxy buffering if we ever sit behind one.
    "X-Accel-Buffering": "no",
  });

  // Initial retry directive — overrides EventSource's 5s default.
  res.write(`retry: ${RETRY_DIRECTIVE_MS}\n\n`);

  // 2. Build the writer closures.
  // `writeFrame` does the actual SSE serialization and is shared by the
  // buffered and live phases.
  //
  // CRITICAL — DO NOT add an `event:` line here. EventSource dispatches
  // frames with an `event:` line as NAMED events (e.g. "ledger.appended"),
  // which `eventSource.onmessage` does NOT catch. Generic consumers would
  // have to register `addEventListener` for each event name they expect,
  // defeating the abstraction.
  //
  // Instead, the type discriminator lives INSIDE the JSON payload as
  // `{ event: "...", data: {...} }`. We serialize the whole frame on the
  // `data:` line and the browser dispatches it as the default `message`
  // event. Consumers parse `msg.data`, look at the `.event` field, and
  // discriminate in JS — same behavior, generic hook stays simple.
  //
  // The Zod schemas in apps/web/lib/bridge/schemas.ts validate exactly
  // this shape, so the wire format and the schemas are aligned.
  const writeFrame = (frame: SseFrame<T>): void => {
    if (res.writableEnded || res.destroyed) return;
    if (opts.filter && !opts.filter(frame.data)) return;
    if (frame.id) res.write(`id: ${frame.id}\n`);
    res.write(`data: ${JSON.stringify(frame)}\n\n`);
  };

  // During the replay/snapshot phase, deltas that arrive on the live
  // subscription are queued here so we can flush them in arrival order
  // after the initial prefix (snapshot + replay) is sent.
  let buffer: SseFrame<T>[] | null = [];
  let liveSend: (frame: SseFrame<T>) => void = (frame) => {
    // Default to buffering until we explicitly switch to direct write.
    buffer!.push(frame);
  };

  // 3. Subscribe FIRST — guarantees no deltas are lost during the
  //    prefix phase. The closure indirection (`liveSend`) lets us swap
  //    behavior without unsubscribing.
  const unsubscribe = source.subscribe((frame) => liveSend(frame));

  // Cleanup state — initialized here so the close/error handlers below
  // can clear the heartbeat regardless of how far through setup we got.
  let heartbeat: NodeJS.Timeout | null = null;
  let cleanedUp = false;
  const cleanup = (): void => {
    if (cleanedUp) return;
    cleanedUp = true;
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
    try {
      unsubscribe();
    } catch {
      // Source dispose semantics aren't ours to enforce here.
    }
    // Best-effort end of the response. If the socket is already gone,
    // res.end is a no-op.
    if (!res.writableEnded) {
      try {
        res.end();
      } catch {
        // Ignore — we're tearing down.
      }
    }
  };

  // Wire BOTH cleanup signals — see file header for the rationale.
  req.on("close", cleanup);
  res.on("error", cleanup);
  res.on("close", cleanup);

  // 4 + 5. Run the prefix phase asynchronously, then flush the buffer
  // and switch to direct-write live mode. Any error during the prefix
  // tears down the connection cleanly — the client's EventSource will
  // reconnect on its own with the `retry: 3000` directive.
  void (async () => {
    try {
      // Snapshot, if the source has one (agent state, system status).
      const snap = source.snapshot?.();
      if (snap) writeFrame(snap);

      // Replay, if the bridge handler supplied one (ledger ?since=).
      if (opts.replay) {
        await opts.replay(writeFrame);
      }

      // Flush deltas that arrived during the prefix phase, in order.
      const queued = buffer ?? [];
      buffer = null;
      for (const frame of queued) writeFrame(frame);

      // Switch live deltas to direct write — no more queuing.
      liveSend = writeFrame;

      // Start heartbeats only AFTER the prefix has been sent. There's no
      // value in sending a heartbeat before the client has its initial
      // state, and starting it after avoids racing the writeFrame calls
      // above for the response stream.
      heartbeat = setInterval(() => {
        if (res.writableEnded || res.destroyed) {
          // Full teardown — not just clearInterval. If neither
          // close/error listener fired (rare transport edge case),
          // this path is our last chance to unsubscribe the client
          // and release the source subscription slot.
          cleanup();
          return;
        }
        // SSE comment line — ignored by EventSource, but keeps the
        // connection alive through any intermediary's idle timeout.
        try {
          res.write(": heartbeat\n\n");
        } catch {
          // EPIPE will fire `res.on("error")` which calls cleanup.
        }
      }, HEARTBEAT_INTERVAL_MS);
    } catch {
      // Any failure in the prefix phase tears the connection down.
      // EventSource will reconnect with `retry: 3000`.
      cleanup();
    }
  })();
}
