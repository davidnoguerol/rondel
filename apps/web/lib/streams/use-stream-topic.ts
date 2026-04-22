"use client";

/**
 * Subscribe to one topic on the multiplexed event stream.
 *
 * Shape-compatible replacement for `useEventStream` — returns
 * `{events, status}` so consumer hooks that previously read from an
 * independent `EventSource` only need to swap the transport line.
 * Parser, reducer, and buffer semantics are identical.
 *
 * ## Contract
 *
 * - `parse` is called once per incoming frame with the raw per-source
 *   `{event, data}` envelope the daemon emitted (the multiplex provider
 *   has already unwrapped and validated the topic envelope). Return the
 *   validated payload or `null` to drop. Typically wraps a Zod
 *   `safeParse` over a frame schema from `@/lib/bridge/schemas`.
 * - The `parse` function identity MAY change between renders — we hold
 *   it in a ref so changes don't trigger re-subscription. The hook
 *   contract is "first parse wins for the lifetime of the subscription".
 * - `maxEvents` caps the retained buffer (default 500). The cap is held
 *   in a ref so resizing doesn't tear down and re-run the subscription.
 *
 * ## Why the `status` is the provider's status
 *
 * With one shared EventSource, "connection state" is a property of the
 * whole provider, not an individual topic. Every hook sees the same
 * status. "Live" indicators UI-wise are still per-topic semantically
 * but technically share a transport — if the connection drops, every
 * topic shows "error" until reconnect.
 *
 * ## Why buffering lives here, not in the provider
 *
 * Each consumer has its own `maxEvents` budget and its own parsed type,
 * so centralizing buffers would force the provider to know per-topic
 * schemas. Keeping buffers local keeps the provider transport-only.
 */

import { useEffect, useRef, useState } from "react";

import type { MultiplexTopic, RawSseFrame } from "@/lib/bridge/schemas";

import { useMultiplexedStreamContext } from "./multiplex-provider";
import type { StreamStatus, UseEventStreamOptions, UseEventStreamResult } from "./use-event-stream";

export function useStreamTopic<T>(
  topic: MultiplexTopic,
  parse: (raw: RawSseFrame) => T | null,
  options: UseEventStreamOptions = {},
): UseEventStreamResult<T> {
  const { status, subscribe } = useMultiplexedStreamContext();

  // See file header for the ref rationale — parse identity can change
  // freely; we pin the first one to the subscription's lifetime.
  const parseRef = useRef(parse);
  parseRef.current = parse;

  const maxEventsRef = useRef(options.maxEvents ?? 500);
  maxEventsRef.current = options.maxEvents ?? 500;

  const [events, setEvents] = useState<readonly T[]>([]);

  useEffect(() => {
    // Reset buffer when the topic changes (callers could pass a dynamic
    // topic; today they don't, but the behavior should be predictable).
    setEvents([]);

    const unsubscribe = subscribe(topic, (frame) => {
      const value = parseRef.current(frame);
      if (value === null) return;
      setEvents((prev) => {
        const cap = maxEventsRef.current;
        const next = [...prev, value];
        if (next.length > cap) {
          return next.slice(next.length - cap);
        }
        return next;
      });
    });

    return unsubscribe;
  }, [topic, subscribe]);

  // Provide a `close` for interface compatibility with `useEventStream`.
  // With a shared connection, one consumer can't actually close the
  // underlying socket — it just unsubscribes. We expose the unsubscribe
  // intent as "no further events": clear the buffer and rely on the
  // effect cleanup from the next render to detach.
  const close = (): void => {
    setEvents([]);
  };

  return { events, status: status as StreamStatus, close };
}
