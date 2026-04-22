"use client";

/**
 * Multiplexed event-stream provider.
 *
 * Owns ONE `EventSource` to `/api/bridge/events/tail` and fans parsed
 * frames out to many React hooks by topic. Replaces the previous model
 * where every `use-X-tail` hook opened its own `EventSource` — that
 * approach saturated the browser's HTTP/1.1 per-origin cap (6 on
 * Chromium) whenever the dashboard had enough live surfaces mounted,
 * which then blocked client-side `<Link>` navigation on free sockets.
 *
 * ## Placement
 *
 * Mount at the dashboard layout root (`app/(dashboard)/layout.tsx`),
 * above every component that consumes live state. The provider's single
 * subscription lives for the entire dashboard session and is closed
 * only when the tree unmounts (tab close, full-page navigation away).
 *
 * ## Consuming this provider
 *
 * Components should NOT use this context directly — use `useStreamTopic`
 * instead. The context is a transport detail; the hook is the API
 * surface callers should know about.
 *
 * =============================================================================
 * STRICT-MODE SAFETY (the one rule you can't break here)
 * =============================================================================
 *
 * The EventSource lives in a `useRef`, not `useState`. React strict mode
 * dev double-mounts every effect: mount → cleanup → mount. With a ref,
 * the cleanup function closes the exact instance the effect created; a
 * stale onmessage from the retired socket can't write into post-cleanup
 * state because the ref has already been nulled.
 *
 * This mirrors the pattern in `use-event-stream.ts` — see that file's
 * header for the longer explanation. If that pattern changes there, it
 * must change here too.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  MultiplexedEnvelopeSchema,
  type MultiplexTopic,
  type RawSseFrame,
} from "@/lib/bridge/schemas";

import type { StreamStatus } from "./use-event-stream";

// -----------------------------------------------------------------------------
// Context shape
// -----------------------------------------------------------------------------

/**
 * What `useStreamTopic` (and any future reader) needs from the provider.
 * Kept minimal: connection status for "Live" badges, and a topic-scoped
 * subscribe. No buffered history, no replay — each consumer maintains
 * its own buffer from the point it subscribed.
 */
interface MultiplexedStreamContextValue {
  readonly status: StreamStatus;
  /**
   * Subscribe to one topic. The listener receives the raw per-source
   * `{event, data}` frame — caller is responsible for parsing/validation
   * via its own Zod schema (see `useStreamTopic`).
   *
   * Returns an unsubscribe function. Idempotent — calling twice is safe.
   */
  readonly subscribe: (
    topic: MultiplexTopic,
    listener: (frame: RawSseFrame) => void,
  ) => () => void;
}

const MultiplexedStreamContext =
  createContext<MultiplexedStreamContextValue | null>(null);

// -----------------------------------------------------------------------------
// Provider
// -----------------------------------------------------------------------------

export interface MultiplexedStreamProviderProps {
  readonly children: ReactNode;
  /**
   * Override the stream URL. Production default is the same-origin
   * bridge proxy. Exposed to make testing / storybook harnesses easy
   * — pass `null` to disable the connection entirely (the provider
   * then reports `status: "closed"` and delivers no frames).
   */
  readonly url?: string | null;
}

const DEFAULT_URL = "/api/bridge/events/tail?callerAgent=web&isAdmin=true";

export function MultiplexedStreamProvider({
  children,
  url = DEFAULT_URL,
}: MultiplexedStreamProviderProps) {
  // EventSource + subscriber registry live in refs — see the strict-mode
  // note in the file header. The registry is a Map<topic, Set<listener>>
  // so unsubscribe is an O(1) `Set.delete` and a topic without listeners
  // short-circuits dispatch.
  const sourceRef = useRef<EventSource | null>(null);
  const listenersRef = useRef<
    Map<MultiplexTopic, Set<(frame: RawSseFrame) => void>>
  >(new Map());

  const [status, setStatus] = useState<StreamStatus>(
    url ? "connecting" : "closed",
  );

  // -- Connection lifecycle -------------------------------------------------

  useEffect(() => {
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
      let raw: unknown;
      try {
        raw = JSON.parse(msg.data);
      } catch {
        // Non-JSON `data:` shouldn't happen; drop the frame rather than
        // crash all consumers. Same policy as `use-event-stream`.
        return;
      }
      const parsed = MultiplexedEnvelopeSchema.safeParse(raw);
      if (!parsed.success) return;

      const { topic, frame } = parsed.data.data;
      const subs = listenersRef.current.get(topic);
      if (!subs || subs.size === 0) return;

      // Snapshot before iterating — a listener that unsubscribes
      // during dispatch must not invalidate the iterator.
      for (const listener of [...subs]) {
        try {
          listener(frame);
        } catch {
          // Per-listener errors do not break the stream. The consumer
          // hook is responsible for its own error boundary semantics
          // (parse failures return null, reducer exceptions surface
          // normally via React).
        }
      }
    };

    es.onerror = () => {
      // EventSource auto-reconnects honoring the daemon's `retry: 3000`
      // directive. We don't tear down here — the browser will move from
      // `error` back to `open` on its own when reconnect succeeds.
      setStatus("error");
    };

    return () => {
      // Close the EXACT instance this effect created. Setting the ref to
      // null first means a late onmessage from the retired socket can't
      // write into post-cleanup listener state.
      sourceRef.current = null;
      es.close();
    };
  }, [url]);

  // -- Subscribe API --------------------------------------------------------

  const subscribe = useCallback(
    (topic: MultiplexTopic, listener: (frame: RawSseFrame) => void) => {
      let subs = listenersRef.current.get(topic);
      if (!subs) {
        subs = new Set();
        listenersRef.current.set(topic, subs);
      }
      subs.add(listener);

      return () => {
        const set = listenersRef.current.get(topic);
        if (!set) return;
        set.delete(listener);
        if (set.size === 0) {
          listenersRef.current.delete(topic);
        }
      };
    },
    [],
  );

  const value = useMemo<MultiplexedStreamContextValue>(
    () => ({ status, subscribe }),
    [status, subscribe],
  );

  return (
    <MultiplexedStreamContext.Provider value={value}>
      {children}
    </MultiplexedStreamContext.Provider>
  );
}

// -----------------------------------------------------------------------------
// Internal consumer — used by `useStreamTopic`. Components must not call
// this directly; they should use the topic hook, which provides the
// typed parse + bounded buffer semantics they expect.
// -----------------------------------------------------------------------------

export function useMultiplexedStreamContext(): MultiplexedStreamContextValue {
  const ctx = useContext(MultiplexedStreamContext);
  if (!ctx) {
    throw new Error(
      "MultiplexedStreamProvider is not mounted — wrap the subtree that " +
        "uses live-stream hooks with <MultiplexedStreamProvider>.",
    );
  }
  return ctx;
}
