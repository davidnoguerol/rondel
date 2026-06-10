// KbIndexer — main-thread controller for the rebuildable FTS index.
//
// Strategy (design §4.1, review-hardened): NO incremental delta tracking.
// A dirty flag per scope (agent / org) + trailing-edge debounce + full
// rebuild in a worker thread. This deletes OpenClaw's whole delta-gate /
// one-shot-bypass / mtime-reconciliation bug class at a corpus size where a
// rebuild takes seconds. Documented upgrade trigger: when a rebuild exceeds
// ~30s, switch to per-session incremental updates.
//
// Hosts: WorkerIndexerHost (production — Worker(new URL("./kb-worker.js")))
// resolves only against dist/, so it falls back to InlineIndexerHost with a
// loud log when Worker construction fails (vitest runs TS sources).

import { Worker } from "node:worker_threads";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { RondelHooks } from "../shared/hooks.js";
import type { Logger } from "../shared/logger.js";
import type { KbIndexStatus } from "../shared/types/knowledge.js";
import { agentDbPath, orgDbPath } from "./kb-store.js";
import { runRebuild, type RebuildJob, type RebuildStats } from "./kb-rebuild.js";
import type { KbWorkerInMsg, KbWorkerOutMsg } from "./kb-worker.js";

export interface KbIndexerHost {
  runRebuild(job: RebuildJob): Promise<RebuildStats>;
  dispose(): Promise<void>;
}

/** Runs rebuilds in-process. Used by tests and as the worker fallback. */
export class InlineIndexerHost implements KbIndexerHost {
  runRebuild(job: RebuildJob): Promise<RebuildStats> {
    return runRebuild(job);
  }
  async dispose(): Promise<void> {
    /* nothing to release */
  }
}

const WORKER_MAX_CRASHES = 3;

/** Runs rebuilds in a dedicated worker thread (production). */
export class WorkerIndexerHost implements KbIndexerHost {
  private worker: Worker | null = null;
  private crashes = 0;
  private nextJobId = 1;
  private readonly pending = new Map<number, { resolve: (s: RebuildStats) => void; reject: (e: Error) => void }>();
  private fallback: InlineIndexerHost | null = null;

  constructor(private readonly log: Logger) {}

  private ensureWorker(): Worker | null {
    if (this.fallback) return null;
    if (this.worker) return this.worker;
    if (this.crashes >= WORKER_MAX_CRASHES) {
      this.log.warn("KB worker crashed repeatedly — falling back to inline rebuilds");
      this.fallback = new InlineIndexerHost();
      return null;
    }
    try {
      const worker = new Worker(new URL("./kb-worker.js", import.meta.url));
      worker.unref();
      worker.on("message", (msg: KbWorkerOutMsg) => {
        const entry = this.pending.get(msg.jobId);
        if (!entry) return;
        this.pending.delete(msg.jobId);
        if (msg.type === "rebuilt") entry.resolve(msg.stats);
        else entry.reject(new Error(msg.error));
      });
      worker.on("error", (err) => {
        this.log.warn(`KB worker error: ${err.message}`);
        this.failAllPending(err);
        this.worker = null;
        this.crashes++;
      });
      worker.on("exit", (code) => {
        if (code !== 0) {
          this.failAllPending(new Error(`KB worker exited with code ${code}`));
          this.worker = null;
          this.crashes++;
        }
      });
      this.worker = worker;
      return worker;
    } catch (err) {
      // vitest / unbundled-TS path: dist/kb-worker.js doesn't exist.
      this.log.warn(`KB worker unavailable (${err instanceof Error ? err.message : String(err)}) — using inline rebuilds`);
      this.fallback = new InlineIndexerHost();
      return null;
    }
  }

  private failAllPending(err: Error): void {
    for (const [, entry] of this.pending) entry.reject(err);
    this.pending.clear();
  }

  runRebuild(job: RebuildJob): Promise<RebuildStats> {
    const worker = this.ensureWorker();
    if (!worker) return (this.fallback ?? new InlineIndexerHost()).runRebuild(job);
    const jobId = this.nextJobId++;
    return new Promise<RebuildStats>((resolve, reject) => {
      this.pending.set(jobId, { resolve, reject });
      worker.postMessage({ type: "rebuild", jobId, job } satisfies KbWorkerInMsg);
    });
  }

  async dispose(): Promise<void> {
    this.failAllPending(new Error("indexer disposed"));
    const worker = this.worker;
    this.worker = null;
    if (worker) await worker.terminate().catch(() => {});
  }
}

type Scope = { readonly agent: string } | { readonly org: string };

interface ScopeState {
  status: KbIndexStatus["state"];
  generation: number;
  lastBuildMs?: number;
  error?: string;
  timer: ReturnType<typeof setTimeout> | null;
  inFlight: boolean;
  dirtyAgain: boolean;
}

export interface KbIndexerDeps {
  readonly knowledgeDir: string;
  /** state/transcripts */
  readonly transcriptsDir: string;
  /** state/sessions.json — legacy agent-mail detection. */
  readonly sessionsJsonPath: string;
  readonly hooks: RondelHooks;
  readonly resolveAgentDir: (agent: string) => string | undefined;
  readonly listAgents: () => readonly string[];
  readonly listOrgs: () => ReadonlyArray<{ orgName: string; orgDir: string }>;
  readonly log: Logger;
  /** Default WorkerIndexerHost; tests inject InlineIndexerHost. */
  readonly host?: KbIndexerHost;
  /** Trailing-edge debounce per scope. Default 5s; tests pass ~20ms. */
  readonly debounceMs?: number;
}

export class KbIndexer {
  private readonly host: KbIndexerHost;
  private readonly debounceMs: number;
  private readonly scopes = new Map<string, ScopeState>();
  private readonly log: Logger;
  private disposed = false;

  constructor(private readonly deps: KbIndexerDeps) {
    this.host = deps.host ?? new WorkerIndexerHost(deps.log.child("kb-worker"));
    this.debounceMs = deps.debounceMs ?? 5_000;
    this.log = deps.log.child("kb-indexer");
  }

  /** mkdir, subscribe hooks, schedule the initial rebuild for every scope.
   *  Does NOT await the rebuilds — the daemon starts serving immediately. */
  async init(): Promise<void> {
    await mkdir(this.deps.knowledgeDir, { recursive: true });

    // Dirty signals. Filter early; RondelHooks isolates listener throws.
    this.deps.hooks.on("transcript:appended", (e) => this.markDirty({ agent: e.agentName }));
    this.deps.hooks.on("transcript:pruned", (e) => this.markDirty({ agent: e.agentName }));
    this.deps.hooks.on("memory:saved", (e) => this.markDirty({ agent: e.agentName }));
    this.deps.hooks.on("session:start", (e) => this.markDirty({ agent: e.agentName }));

    // Rebuild-on-start: indexes are derived caches; this is the recovery story.
    for (const agent of this.deps.listAgents()) this.markDirty({ agent });
    for (const org of this.deps.listOrgs()) this.markDirty({ org: org.orgName });
  }

  markDirty(scope: Scope): void {
    if (this.disposed) return;
    const key = "agent" in scope ? `agent:${scope.agent}` : `org:${scope.org}`;
    const state = this.scopes.get(key) ?? {
      status: "missing" as const,
      generation: 0,
      timer: null,
      inFlight: false,
      dirtyAgain: false,
    };
    this.scopes.set(key, state);

    if (state.inFlight) {
      state.dirtyAgain = true; // coalesce: exactly one follow-up rebuild
      return;
    }
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      state.timer = null;
      void this.rebuildScope(key, scope, state);
    }, this.debounceMs);
    state.timer.unref?.();
  }

  private async rebuildScope(key: string, scope: Scope, state: ScopeState): Promise<void> {
    if (this.disposed) return;
    const job = this.buildJob(scope);
    if (!job) return;
    state.inFlight = true;
    state.status = "building";
    try {
      const stats = await this.host.runRebuild(job);
      state.status = "ready";
      state.generation++;
      state.lastBuildMs = stats.durationMs;
      state.error = undefined;
      this.log.info(`KB rebuilt ${key}: ${stats.rows} rows / ${stats.sources} sources in ${stats.durationMs}ms`);
    } catch (err) {
      state.status = "error";
      state.error = err instanceof Error ? err.message : String(err);
      this.log.warn(`KB rebuild failed for ${key}: ${state.error}`);
    } finally {
      state.inFlight = false;
      if (state.dirtyAgain) {
        state.dirtyAgain = false;
        this.markDirty(scope);
      }
    }
  }

  private buildJob(scope: Scope): RebuildJob | undefined {
    if ("agent" in scope) {
      const agentDir = this.deps.resolveAgentDir(scope.agent);
      if (!agentDir) return undefined;
      return {
        kind: "agent",
        agent: scope.agent,
        dbPath: agentDbPath(this.deps.knowledgeDir, scope.agent),
        transcriptsAgentDir: join(this.deps.transcriptsDir, scope.agent),
        agentDir,
        sessionsJsonPath: this.deps.sessionsJsonPath,
      };
    }
    const org = this.deps.listOrgs().find((o) => o.orgName === scope.org);
    if (!org) return undefined;
    return {
      kind: "org",
      org: scope.org,
      dbPath: orgDbPath(this.deps.knowledgeDir, scope.org),
      sharedKnowledgeDir: join(org.orgDir, "shared", "knowledge"),
    };
  }

  statusFor(scope: Scope): KbIndexStatus {
    const key = "agent" in scope ? `agent:${scope.agent}` : `org:${scope.org}`;
    const state = this.scopes.get(key);
    if (!state) return { state: "missing", generation: 0 };
    return { state: state.status, generation: state.generation, lastBuildMs: state.lastBuildMs, error: state.error };
  }

  /** Test helper: resolves when no timers are armed and no job is in flight. */
  async whenIdle(): Promise<void> {
    for (;;) {
      const busy = [...this.scopes.values()].some((s) => s.timer !== null || s.inFlight || s.dirtyAgain);
      if (!busy) return;
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const state of this.scopes.values()) {
      if (state.timer) clearTimeout(state.timer);
      state.timer = null;
    }
    await this.host.dispose();
  }
}
