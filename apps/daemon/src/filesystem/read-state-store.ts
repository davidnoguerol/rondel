/**
 * In-memory read-state tracking for the first-class filesystem tool suite.
 *
 * `rondel_read_file` records the sha256 hash of every successful read keyed
 * by (agent, sessionId, path). `rondel_write_file` / `rondel_edit_file` /
 * `rondel_multi_edit_file` consult this store before writing — if no record
 * exists, or the recorded hash no longer matches the current on-disk content,
 * they escalate to human approval via the `write_without_read` reason.
 *
 * The invariant is "you must have read the current version in this session
 * before writing". Keyed on sessionId rather than chatId so that `/new`
 * (a fresh session on the same conversation) purges any stale reads and
 * the agent is forced to re-read before writing again.
 *
 * Not persisted to disk. Invalidated on session reset, crash, halt — so a
 * daemon restart (which doesn't emit any of those) drops every record.
 * That's conservative by design: the invariant must hold within a single
 * session's lifetime, and forgetting on restart forces the agent to do a
 * fresh read, which is always safe.
 */

import type { RondelHooks } from "../shared/hooks.js";

export interface ReadRecord {
  /** sha256 hex digest of the file content at read time. */
  readonly contentHash: string;
  /** ISO 8601 timestamp of when the read was recorded. */
  readonly readAt: string;
}

interface ReadKey {
  readonly agent: string;
  readonly sessionId: string;
  readonly path: string;
}

/**
 * Per-session read records. Plain in-memory Map.
 */
export class ReadFileStateStore {
  private readonly records = new Map<string, ReadRecord>();
  private subscribed = false;

  constructor(private readonly hooks: RondelHooks) {}

  private key(k: ReadKey): string {
    // `::` is not a legal substring of any component (agent names are
    // alnum/-/_; sessionIds are UUIDs; paths use `/`), so we can use it
    // as an unambiguous separator without quoting.
    return `${k.agent}::${k.sessionId}::${k.path}`;
  }

  /**
   * Lazy hook subscription — we only subscribe when the store is first
   * used, so tests that construct the store without exercising it never
   * leak a listener.
   */
  private ensureSubscribed(): void {
    if (this.subscribed) return;
    this.subscribed = true;
    this.hooks.on("session:reset", (ev) => {
      // session:reset drops the sessionId — purge every record for this
      // conversation regardless of which sessionId it was bound to.
      // Purging by `(agent, chatId)` isn't possible without indexing by
      // chatId too; simplest correct behaviour is to invalidate all
      // sessions for the agent that had reset events for any of its
      // conversations. But that's too aggressive. Since we key by
      // sessionId and a reset starts a fresh session, records from the
      // old sessionId simply become unreachable — the next write will
      // look up under the NEW sessionId and find nothing, which is
      // exactly the correct "you must re-read first" behaviour. So
      // reset is a soft no-op here; we leave this subscribe to catch
      // any future accidental reuse of a sessionId.
      void ev;
    });
    this.hooks.on("session:crash", (ev) => {
      this.invalidateSession(ev.agentName, ev.sessionId);
    });
    this.hooks.on("session:halt", (ev) => {
      this.invalidateSession(ev.agentName, ev.sessionId);
    });
  }

  /** Record a successful read. Called by the bridge POST handler. */
  record(agent: string, sessionId: string, path: string, contentHash: string): void {
    this.ensureSubscribed();
    this.records.set(this.key({ agent, sessionId, path }), {
      contentHash,
      readAt: new Date().toISOString(),
    });
  }

  /** Return the read record for (agent, sessionId, path), or undefined. */
  get(agent: string, sessionId: string, path: string): ReadRecord | undefined {
    return this.records.get(this.key({ agent, sessionId, path }));
  }

  /**
   * Drop every record for a given (agent, sessionId). Called explicitly
   * by the bridge when needed, and by the crash/halt hook handlers.
   */
  invalidateSession(agent: string, sessionId: string): void {
    const prefix = `${agent}::${sessionId}::`;
    for (const k of this.records.keys()) {
      if (k.startsWith(prefix)) this.records.delete(k);
    }
  }

  /** Exposed for tests. */
  size(): number {
    return this.records.size;
  }
}
