/**
 * Multiplexed stream source — fans multiple `StreamSource<T>` instances
 * into one physical SSE connection.
 *
 * ## Why this exists
 *
 * The web dashboard opens one `EventSource` per live topic (approvals,
 * agent state, tasks, ledger, schedules, heartbeats). Every browser caps
 * concurrent HTTP/1.1 connections per origin at 6; an active dashboard
 * with a couple of tabs hits that cap trivially, and client-side `<Link>`
 * navigations then block waiting for a free slot.
 *
 * This source composes the existing per-topic sources and exposes them as
 * a single `StreamSource<MultiplexedFrameData>` that the bridge serves at
 * `GET /events/tail`. The inner frame schemas are unchanged — the
 * multiplex just wraps each emitted frame with a `topic` tag.
 *
 * ## What it does NOT do
 *
 * - No server-side topic filtering. The web is single-user on localhost;
 *   bandwidth is free and simpler is better. If a topic ever becomes
 *   noisy, filtering can be added as an additive query param without
 *   touching the wire envelope.
 * - No interaction with per-request filters (e.g. ledger per-agent,
 *   heartbeat per-org). Those were implemented at the bridge handler
 *   level against single-topic endpoints and would split per-client
 *   state across the multiplex. Client-side filtering replaces them;
 *   volume on localhost doesn't justify the server bookkeeping.
 * - No ownership of the underlying sources. Sources are constructed and
 *   disposed by the orchestrator. The multiplex holds references plus
 *   its own unsubscribe handles; disposing the multiplex tears down its
 *   fan-out wiring only.
 *
 * ## Snapshot semantics
 *
 * Two component sources (`AgentStateStreamSource`, `HeartbeatStreamSource`
 * via `asyncSnapshot`) deliver a snapshot frame at connect. Because the
 * `StreamSource` contract only allows a single sync `snapshot()`, the
 * multiplex piggybacks on the handler's `replay` hook instead: callers
 * pass `source.buildReplay(context)` as the replay option to
 * `handleSseRequest`. `buildReplay` iterates the subset of component
 * sources that have snapshots and writes each one wrapped in the topic
 * envelope, preserving the pre-live-flow ordering guarantees of
 * `handleSseRequest`.
 */

import type { SseFrame, StreamSource } from "./sse-types.js";
import type { AgentStateFrameData, AgentStateStreamSource } from "./agent-state-stream.js";
import type { ApprovalStreamSource } from "./approval-stream.js";
import type { HeartbeatFrameData, HeartbeatStreamSource } from "./heartbeat-stream.js";
import type { LedgerStreamSource } from "./ledger-stream.js";
import type {
  ScheduleFramePayload,
  ScheduleStreamSource,
} from "./schedule-stream.js";
import type { TaskFrameData, TaskStreamSource } from "./task-stream.js";
import type { ApprovalRecord } from "../shared/types/approvals.js";
import type { LedgerEvent } from "../ledger/ledger-types.js";

/** Topic discriminator on the multiplex wire envelope. */
export type MultiplexTopic =
  | "approvals"
  | "agents-state"
  | "tasks"
  | "ledger"
  | "schedules"
  | "heartbeats";

/** Full set of topics — exported so consumers can assert exhaustiveness. */
export const MULTIPLEX_TOPICS: readonly MultiplexTopic[] = [
  "approvals",
  "agents-state",
  "tasks",
  "ledger",
  "schedules",
  "heartbeats",
] as const;

/** SSE `event` tag for every multiplexed frame (the discriminator lives
 *  inside `data.topic`, not on the SSE event line — matches the rest of
 *  the codebase: see the comment in `sse-handler.ts` on why). */
export const MULTIPLEX_EVENT = "multiplex";

/**
 * Wire shape inside the SSE `data:` payload. The inner `frame` is the
 * exact `SseFrame<T>` the underlying source emitted — we do not alter
 * per-topic payload schemas.
 */
export interface MultiplexedFrameData {
  readonly topic: MultiplexTopic;
  readonly frame: SseFrame<unknown>;
}

/**
 * Caller context used to scope snapshots that need it (tasks). Matches
 * the per-handler `caller` shape already used elsewhere in the bridge.
 */
export interface MultiplexCaller {
  readonly agentName: string;
  readonly isAdmin: boolean;
}

/**
 * The set of component sources the multiplex fans out. All fields are
 * required: constructing a multiplex means you intend to serve all of
 * them through one endpoint. Missing sources should be surfaced at the
 * orchestrator layer (a daemon start-up assertion), not silently
 * skipped here.
 */
export interface MultiplexStreamSources {
  readonly approvals: ApprovalStreamSource;
  readonly agentsState: AgentStateStreamSource;
  readonly tasks: TaskStreamSource;
  readonly ledger: LedgerStreamSource;
  readonly schedules: ScheduleStreamSource;
  readonly heartbeats: HeartbeatStreamSource;
}

export class MultiplexStreamSource implements StreamSource<MultiplexedFrameData> {
  private readonly clients = new Set<
    (frame: SseFrame<MultiplexedFrameData>) => void
  >();
  private readonly unsubscribeFromSources: (() => void)[] = [];
  private readonly sources: MultiplexStreamSources;

  constructor(sources: MultiplexStreamSources) {
    this.sources = sources;

    // Wire each component source. `wrapAndFanOut` produces a listener that
    // tags incoming frames with the topic and dispatches to connected
    // multiplex clients. Each call returns an unsubscribe closure which we
    // store for dispose().
    this.unsubscribeFromSources.push(
      sources.approvals.subscribe(this.wrapAndFanOut<ApprovalRecord>("approvals")),
    );
    this.unsubscribeFromSources.push(
      sources.agentsState.subscribe(this.wrapAndFanOut<AgentStateFrameData>("agents-state")),
    );
    this.unsubscribeFromSources.push(
      sources.tasks.subscribe(this.wrapAndFanOut<TaskFrameData>("tasks")),
    );
    this.unsubscribeFromSources.push(
      sources.ledger.subscribe(this.wrapAndFanOut<LedgerEvent>("ledger")),
    );
    this.unsubscribeFromSources.push(
      sources.schedules.subscribe(this.wrapAndFanOut<ScheduleFramePayload>("schedules")),
    );
    this.unsubscribeFromSources.push(
      sources.heartbeats.subscribe(this.wrapAndFanOut<HeartbeatFrameData>("heartbeats")),
    );
  }

  subscribe(send: (frame: SseFrame<MultiplexedFrameData>) => void): () => void {
    this.clients.add(send);
    return () => {
      this.clients.delete(send);
    };
  }

  // No synchronous `snapshot()` — multiple component snapshots need to be
  // delivered, and some of them are async. `buildReplay(caller)` returns
  // the async callback that `handleSseRequest` will run between
  // `subscribe` and live-flow. See file header for the rationale.
  snapshot(): undefined {
    return undefined;
  }

  /**
   * Build the `replay` callback for `handleSseRequest`. Iterates the
   * component sources that provide a snapshot, wraps each emitted frame
   * with its topic, and writes it via the handler's `send` function.
   *
   * Sources without snapshots (`ApprovalStreamSource`, `LedgerStreamSource`,
   * `ScheduleStreamSource`) are deliberately skipped — their initial state
   * is fetched by the web pages via the existing request-response endpoints.
   *
   * ## Best-effort delivery
   *
   * Each snapshot is wrapped in a try/catch so one failing topic cannot
   * tear down the entire stream. Failure modes worth tolerating:
   *
   *   - `tasks.asyncSnapshot` rejects with `unknown_agent` when the
   *     caller name isn't a registered agent (the web's loopback
   *     pseudo-caller "web" hits this by design).
   *   - `heartbeats.asyncSnapshot` rejects on disk-read errors.
   *
   * Without this guard, an exception here propagates into
   * `handleSseRequest`'s prefix-phase try/catch, which calls
   * `cleanup()` and ends the response. The browser's EventSource then
   * reconnects after 3 s (per the daemon's `retry:` directive), only
   * to hit the same error and disconnect again — a connecting / open /
   * error oscillation that surfaces in the UI as a stuck "connecting"
   * indicator.
   *
   * Snapshot failure is also non-critical because every page's initial
   * state is fetched server-side via the request-response bridge
   * endpoints; the SSE snapshot is a freshness courtesy, not the
   * authoritative source.
   */
  buildReplay(caller: MultiplexCaller): (
    send: (frame: SseFrame<MultiplexedFrameData>) => void,
  ) => Promise<void> {
    return async (send) => {
      // Agent-state: sync snapshot. Safe to call first since it never
      // touches disk and the set of conversations is in-memory.
      this.safeSnapshot("agents-state", send, () =>
        this.sources.agentsState.snapshot(),
      );

      // Heartbeats: async snapshot (reads per-agent JSON files). No
      // caller scoping — the web UI is admin-loopback.
      await this.safeSnapshotAsync("heartbeats", send, () =>
        this.sources.heartbeats.asyncSnapshot(),
      );

      // Tasks: async snapshot, needs the caller for the visibility check
      // inside `TaskService.list`. The web's pseudo-caller "web" is
      // not a registered agent, so this routinely throws `unknown_agent`
      // — the safe wrapper swallows it and lets the live stream proceed.
      await this.safeSnapshotAsync("tasks", send, () =>
        this.sources.tasks.asyncSnapshot(caller),
      );
    };
  }

  /**
   * Run a sync snapshot, wrap the frame, and write it. Errors are
   * swallowed (logged via `console.warn` only — no daemon Logger here
   * to keep this file decoupled). See buildReplay's header for why.
   */
  private safeSnapshot<T>(
    topic: MultiplexTopic,
    send: (frame: SseFrame<MultiplexedFrameData>) => void,
    produce: () => SseFrame<T>,
  ): void {
    try {
      const frame = produce();
      send({
        event: MULTIPLEX_EVENT,
        data: { topic, frame: frame as SseFrame<unknown> },
      });
    } catch (err) {
      console.warn(
        `[multiplex] snapshot for "${topic}" failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Async variant of `safeSnapshot` — same semantics. */
  private async safeSnapshotAsync<T>(
    topic: MultiplexTopic,
    send: (frame: SseFrame<MultiplexedFrameData>) => void,
    produce: () => Promise<SseFrame<T>>,
  ): Promise<void> {
    try {
      const frame = await produce();
      send({
        event: MULTIPLEX_EVENT,
        data: { topic, frame: frame as SseFrame<unknown> },
      });
    } catch (err) {
      console.warn(
        `[multiplex] snapshot for "${topic}" failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  dispose(): void {
    for (const undo of this.unsubscribeFromSources) {
      try {
        undo();
      } catch {
        // Source unsubscribe semantics aren't ours to enforce here —
        // swallow so one bad source can't prevent the rest from
        // unwinding.
      }
    }
    this.unsubscribeFromSources.length = 0;
    this.clients.clear();
  }

  getClientCount(): number {
    return this.clients.size;
  }

  /**
   * Produce a listener for a component source that wraps each incoming
   * frame with its topic tag and fans out to all connected multiplex
   * clients. Shape mirrors the per-source fan-out: snapshot the client
   * set before iterating (so an unsubscribe during fan-out doesn't
   * invalidate the iterator) and swallow per-client errors so one dead
   * socket can't break the others.
   */
  private wrapAndFanOut<T>(topic: MultiplexTopic): (frame: SseFrame<T>) => void {
    return (frame) => {
      if (this.clients.size === 0) return;
      const wrapped: SseFrame<MultiplexedFrameData> = {
        event: MULTIPLEX_EVENT,
        data: { topic, frame: frame as SseFrame<unknown> },
      };
      for (const send of [...this.clients]) {
        try {
          send(wrapped);
        } catch {
          // Per-client failure — handleSseRequest cleans up via its
          // req/res close/error listeners.
        }
      }
    };
  }
}
