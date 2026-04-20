/**
 * Keyed serial execution primitive.
 *
 * Serializes concurrent async operations that share a key. Each key has its
 * own chain — distinct keys don't block each other. Used anywhere we need
 * "one writer at a time" for a given resource: per-file inbox appends,
 * per-conversation message dispatch, per-path session-index persistence.
 *
 * Implementation: a Map<key, Promise<unknown>> where each entry points at
 * the tail of the chain for that key. `withLock` appends a new step and
 * updates the tail. Two invariants hold:
 *
 * 1. **A rejected prior step must not deadlock later work.** We chain with
 *    `.then(fn, fn)` so `fn` runs on resolve OR reject of the predecessor.
 * 2. **Errors don't propagate past their own call.** We store a
 *    rejection-swallowed view of the chain tail (`next.catch(() => undefined)`)
 *    so the *next* caller only sees its own failure, never the previous one's.
 *
 * The Map grows with unique keys seen in a process's lifetime but entries
 * hold only a settled Promise reference — no held data. For the current
 * use cases (per-agent inboxes, per-conversation queues) the key space is
 * bounded by the running config, so no eviction is needed.
 *
 * This module is the one serialization primitive for the daemon. Do not
 * invent ad-hoc promise chains elsewhere; import from here.
 */
export class AsyncLock {
  private readonly chains = new Map<string, Promise<unknown>>();

  async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    // .then(fn, fn) runs `fn` whether the previous operation resolved OR
    // rejected — a prior failure must not deadlock later writes.
    const next = prev.then(fn, fn);
    // Store a rejection-swallowed view so the chain never propagates errors
    // to subsequent callers (they only see their own fn's errors).
    this.chains.set(key, next.catch(() => undefined));
    return next;
  }
}
