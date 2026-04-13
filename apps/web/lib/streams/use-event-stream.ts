"use client";

/**
 * Generic React hook over the browser's native `EventSource`.
 *
 * Wraps an SSE connection with three things the raw API doesn't give us:
 *   - typed, validated events via a caller-supplied parser
 *   - bounded buffer (so a stream that runs for hours doesn't eat the heap)
 *   - status state for "connecting / open / error / closed" UI affordances
 *
 * Browser auto-reconnect (with the `retry: 3000` directive from the daemon)
 * is left to EventSource itself — we don't reimplement it.
 *
 * =============================================================================
 * STRICT-MODE SAFETY (the one rule you can't break here)
 * =============================================================================
 *
 * The EventSource lives in a `useRef`, NEVER `useState`. React strict mode
 * dev double-mounts every effect: mount → cleanup → mount. If we held the
 * connection in state, every dev render would leak a connection per mount.
 * Refs survive mount/unmount cycles, so the cleanup function in the effect
 * can close the EXACT instance the effect created.
 *
 * Additionally, the EventSource is constructed INSIDE the effect, never at
 * render time and never with `typeof window` gates. Effects don't run during
 * SSR; this is the right phase. Touching `EventSource` during render would
 * crash the server build.
 */

import { useEffect, useRef, useState } from "react";

export type StreamStatus = "connecting" | "open" | "error" | "closed";

export interface UseEventStreamResult<T> {
  /** Most recent events, newest-last (push order). Bounded by `maxEvents`. */
  readonly events: readonly T[];
  /** Connection state — drives any "Live" indicator UI. */
  readonly status: StreamStatus;
  /**
   * Manually close the connection. Rarely needed — unmount handles it.
   * Useful when an in-page toggle wants to suspend the stream.
   */
  readonly close: () => void;
}

export interface UseEventStreamOptions {
  /** Max events to retain in `events`. Older events are dropped. Default 500. */
  readonly maxEvents?: number;
}

/**
 * Open an EventSource at `url` and surface its parsed events as React state.
 *
 * @param url      The URL to subscribe to. Pass `null` to disable the
 *                 connection (e.g. while waiting for a parameter to resolve
 *                 or behind a feature flag).
 * @param parse    Caller-supplied parser. Called for each `MessageEvent`
 *                 received — including the wrapping JSON envelope — and
 *                 should return the validated payload or `null` to drop.
 *                 Typically wraps a Zod `safeParse` over the daemon's
 *                 wire-format frame schema.
 * @param options  Optional bounded-buffer configuration.
 */
export function useEventStream<T>(
  url: string | null,
  parse: (raw: unknown) => T | null,
  options: UseEventStreamOptions = {},
): UseEventStreamResult<T> {
  // EventSource lives in a ref — see strict-mode rule in the file header.
  const sourceRef = useRef<EventSource | null>(null);

  // The parse function is captured in a ref so identity changes between
  // renders don't trigger a reconnect. The hook contract is "first parse
  // wins for the lifetime of the connection" — if you really want to swap
  // parsers, change the URL.
  const parseRef = useRef(parse);
  parseRef.current = parse;

  // `maxEvents` is an output-shaping concern, not a transport concern —
  // keep it in a ref so resizing the buffer mid-session doesn't tear down
  // and re-establish the connection (which would replay snapshots and
  // re-run any `?since=` backfill). The effect below reads the current
  // value through the ref on each frame.
  const maxEventsRef = useRef(options.maxEvents ?? 500);
  maxEventsRef.current = options.maxEvents ?? 500;

  const [events, setEvents] = useState<readonly T[]>([]);
  const [status, setStatus] = useState<StreamStatus>(
    url ? "connecting" : "closed",
  );

  useEffect(() => {
    // Reset on URL change (or null → set up nothing).
    setEvents([]);
    if (!url) {
      setStatus("closed");
      return;
    }
    setStatus("connecting");

    const es = new EventSource(url);
    sourceRef.current = es;

    es.onopen = () => {
      setStatus("open");
    };

    es.onmessage = (msg) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(msg.data);
      } catch {
        // A non-JSON `data:` line shouldn't happen, but if it does we drop
        // the frame rather than crash the consumer.
        return;
      }
      const value = parseRef.current(parsed);
      if (value === null) return;
      setEvents((prev) => {
        const cap = maxEventsRef.current;
        const next = [...prev, value];
        if (next.length > cap) {
          return next.slice(next.length - cap);
        }
        return next;
      });
    };

    es.onerror = () => {
      // EventSource auto-reconnects with the `retry` directive from the
      // server (3s in our daemon). We don't tear down here — the browser
      // will move from `error` back to `open` when reconnect succeeds.
      setStatus("error");
    };

    return () => {
      // CRITICAL: close the EXACT instance this effect created. Strict-mode
      // mount → cleanup → mount must NOT leave the previous connection
      // alive. Setting the ref to null first means a late onmessage from
      // the old socket can't write into post-cleanup state.
      sourceRef.current = null;
      es.close();
    };
  }, [url]);

  const close = () => {
    sourceRef.current?.close();
    sourceRef.current = null;
    setStatus("closed");
  };

  return { events, status, close };
}
