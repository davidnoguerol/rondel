/**
 * Types for the daemon-side SSE (Server-Sent Events) streaming primitive.
 *
 * The shape here is deliberately minimal so future stream sources stay cheap
 * to add. A `StreamSource<T>` knows how to fan out events to N in-process
 * subscribers. The `handleSseRequest` helper (in sse-handler.ts) is the only
 * place that knows about the SSE wire format — sources stay protocol-agnostic
 * so the same source could later be reused for WebSocket or tests.
 *
 * Conventions:
 *   - One `StreamSource` instance per stream type per daemon. Constructed at
 *     startup, disposed on shutdown. Multiple HTTP clients fan out from the
 *     same source instance via `subscribe()`.
 *   - Filtering happens in the handler, not the source. The handler wraps
 *     `send` with a per-client predicate before passing it down.
 *   - Replay (e.g. ledger `?since=<ts>`) is supplied to the handler as a
 *     separate optional callback, NOT modeled on the source. This keeps
 *     append-only and snapshot-style sources from sharing an awkward base.
 */

/**
 * One SSE event frame.
 *
 *   `event` → maps to the SSE `event:` line — a stable string tag the
 *             client uses to discriminate frame kinds (e.g.
 *             "ledger.appended", "agent_state.snapshot").
 *   `data`  → the payload, JSON-serialized into the `data:` line.
 *   `id`    → optional cursor written to the `id:` line. Reserved for
 *             a future cursor / Last-Event-ID resume mechanism; not
 *             used in M2 because ledger events have no monotonic seq id.
 */
export interface SseFrame<T> {
  readonly event: string;
  readonly data: T;
  readonly id?: string;
}

/**
 * Source of a stream's events.
 *
 * One implementation per stream type (ledger, agent-state, …). Constructed
 * once at daemon startup, disposed on shutdown. Subscribers come and go
 * over the daemon's lifetime.
 */
export interface StreamSource<T> {
  /**
   * Register a client. The returned function unsubscribes that client.
   * Sources MUST hold weak references via the returned closure — never
   * leak the `send` callback past the unsubscribe call (it is bound to
   * an HTTP response that may have already closed).
   */
  subscribe(send: (frame: SseFrame<T>) => void): () => void;

  /**
   * Optional: a current-state snapshot for streams whose semantics are
   * "show me the world right now" (agent state, system status). Called
   * by `handleSseRequest` after `subscribe()` and before the live flow,
   * so the client receives an initial picture without missing any deltas.
   *
   * Append-only sources (ledger) do not implement this — their initial
   * state comes from the existing request-response GET endpoints
   * (rendered server-side by RSC pages) plus an optional `?since=<ts>`
   * replay handled by the bridge handler outside this interface.
   */
  snapshot?(): SseFrame<T> | undefined;

  /**
   * Cleanup on daemon shutdown — release the upstream subscription and
   * drop any outstanding clients. Called from the orchestrator's
   * shutdown sequence after the bridge stops accepting new connections.
   */
  dispose(): void;

  /**
   * Current number of connected subscribers. Part of the public surface
   * so bridge diagnostics (`/version`, future `/stats`) and tests can
   * assert subscription lifecycle without reaching into private state.
   * Cheap — implementations should back it with a `Set.size` read.
   */
  getClientCount(): number;
}
