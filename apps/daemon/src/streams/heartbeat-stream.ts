/**
 * Live heartbeat stream source.
 *
 * Snapshot + delta (same wire shape as `AgentStateStreamSource`):
 *   - `heartbeat.snapshot` — sent once per client at connect, carries an
 *     array of every known record with `health`/`ageMs` computed at send
 *     time.
 *   - `heartbeat.delta`    — sent on each `heartbeat:updated` hook, one
 *     record per frame.
 *
 * Clients re-classify health locally as the clock advances (a healthy
 * record doesn't push a new delta when it silently becomes stale — the
 * age computation is cheap enough to do in the reducer on an interval).
 *
 * One instance lives for the daemon's lifetime. Disposing removes every
 * hook listener and drops every client.
 */

import type { RondelHooks } from "../shared/hooks.js";
import type { HeartbeatRecord } from "../shared/types/heartbeats.js";
import type { HeartbeatRecordWithHealth } from "../bridge/schemas.js";
import { withHealth, type HeartbeatService } from "../heartbeats/index.js";

import type { SseFrame, StreamSource } from "./sse-types.js";

const SNAPSHOT_EVENT = "heartbeat.snapshot";
const DELTA_EVENT = "heartbeat.delta";

export type HeartbeatFrameData =
  | { readonly kind: "snapshot"; readonly entries: readonly HeartbeatRecordWithHealth[] }
  | { readonly kind: "delta"; readonly entry: HeartbeatRecordWithHealth };

export class HeartbeatStreamSource implements StreamSource<HeartbeatFrameData> {
  private readonly clients = new Set<(frame: SseFrame<HeartbeatFrameData>) => void>();
  private readonly unsubscribeFromHook: () => void;

  constructor(hooks: RondelHooks, private readonly service: HeartbeatService) {
    const onUpdated = ({ record }: { record: HeartbeatRecord }): void => {
      if (this.clients.size === 0) return;
      const entry = withHealth(record, Date.now());
      const frame: SseFrame<HeartbeatFrameData> = {
        event: DELTA_EVENT,
        data: { kind: "delta", entry },
      };
      // Snapshot the client set before iterating — an unsubscribe during
      // fan-out (e.g. EPIPE on a dead socket) must not invalidate the
      // iterator. Same shape as LedgerStreamSource.
      for (const send of [...this.clients]) {
        try {
          send(frame);
        } catch {
          // Per-client failures must not affect other clients.
          // `handleSseRequest` cleans up via its req/res listeners.
        }
      }
    };

    hooks.on("heartbeat:updated", onUpdated);
    this.unsubscribeFromHook = () => hooks.off("heartbeat:updated", onUpdated);
  }

  subscribe(send: (frame: SseFrame<HeartbeatFrameData>) => void): () => void {
    this.clients.add(send);
    return () => {
      this.clients.delete(send);
    };
  }

  /**
   * Returns the current fleet state. The handler sends this once per
   * client before the live flow attaches. Org filtering (if any) happens
   * in the handler via its per-client filter closure — the source stays
   * scope-agnostic.
   *
   * Note: `snapshot()` is declared synchronous on the StreamSource
   * interface but heartbeat reads are async. We work around that by
   * returning `undefined` from `snapshot()` and instead exposing an
   * `asyncSnapshot()` that the bridge handler calls itself in its
   * `replay` callback. Keeps the source disk-agnostic without breaking
   * the interface contract.
   */
  snapshot(): undefined {
    return undefined;
  }

  /**
   * Async fleet snapshot — called by the bridge handler's `replay`
   * callback. Separate from `subscribe()` so deltas that arrive during
   * the read are queued by `handleSseRequest` and flushed after this
   * frame lands.
   */
  async asyncSnapshot(): Promise<SseFrame<HeartbeatFrameData>> {
    const entries = await this.service.readAllUnscoped();
    return {
      event: SNAPSHOT_EVENT,
      data: { kind: "snapshot", entries },
    };
  }

  dispose(): void {
    try {
      this.unsubscribeFromHook();
    } catch {
      // Hook off() semantics aren't ours to enforce here.
    }
    this.clients.clear();
  }

  getClientCount(): number {
    return this.clients.size;
  }
}
