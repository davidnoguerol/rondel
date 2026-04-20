/**
 * HeartbeatService — central owner of per-agent liveness state.
 *
 * Called from:
 *   - `rondel_heartbeat_update` (self-write from the rondel-heartbeat skill)
 *   - `rondel_heartbeat_read_all` (admin + web fleet grid)
 *   - `AdminApi.deleteAgent` (cleanup on agent removal)
 *
 * Mirrors the store / service / hooks split used by `ApprovalService` and
 * `ScheduleService`. All disk I/O goes through `heartbeat-store.ts`; org
 * isolation is enforced via `shared/org-isolation.ts`; write completion
 * emits `heartbeat:updated` for the ledger + SSE stream to consume.
 *
 * Pure helpers — `classifyHealth`, `classifyHealthFromAge`, `withHealth` —
 * are exported so the stream source and tests can share exactly one
 * classifier implementation.
 */

import { mkdir } from "node:fs/promises";
import type { RondelHooks } from "../shared/hooks.js";
import type { Logger } from "../shared/logger.js";
import { checkOrgIsolation, type OrgLookup } from "../shared/org-isolation.js";
import type { HealthStatus, HeartbeatRecord } from "../shared/types/heartbeats.js";
import type { HeartbeatRecordWithHealth } from "../bridge/schemas.js";
import {
  listHeartbeats,
  readHeartbeat,
  removeHeartbeat,
  writeHeartbeat,
  type HeartbeatPaths,
} from "./heartbeat-store.js";

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

/**
 * Age thresholds for health classification. Tuned to a 4h default cron:
 * one missed fire (≈ 5h since last beat) → stale, 24h → down.
 *
 * Single source of truth. Anything that needs to know "is this record
 * stale?" MUST call `classifyHealth` / `classifyHealthFromAge`; never
 * compare timestamps directly.
 */
export const HEALTHY_THRESHOLD_MS = 5 * 60 * 60 * 1000; // 5h
export const DOWN_THRESHOLD_MS = 24 * 60 * 60 * 1000;   // 24h

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function classifyHealthFromAge(ageMs: number): HealthStatus {
  // Negative age (clock skew: record says the future) → still healthy.
  // Anything weirder than that shows up as "very stale" via Date.parse,
  // which we treat as 0 age below.
  if (ageMs < 0) return "healthy";
  if (ageMs <= HEALTHY_THRESHOLD_MS) return "healthy";
  if (ageMs <= DOWN_THRESHOLD_MS) return "stale";
  return "down";
}

export function classifyHealth(record: HeartbeatRecord, nowMs: number): HealthStatus {
  return classifyHealthFromAge(ageMsOf(record, nowMs));
}

export function withHealth(record: HeartbeatRecord, nowMs: number): HeartbeatRecordWithHealth {
  const ageMs = ageMsOf(record, nowMs);
  return {
    ...record,
    ageMs,
    health: classifyHealthFromAge(ageMs),
  };
}

export function findStale(records: readonly HeartbeatRecord[], nowMs: number): HeartbeatRecord[] {
  return records.filter((r) => classifyHealth(r, nowMs) !== "healthy");
}

function ageMsOf(record: HeartbeatRecord, nowMs: number): number {
  const t = Date.parse(record.updatedAt);
  if (Number.isNaN(t)) return Number.MAX_SAFE_INTEGER; // unparseable → very stale
  return Math.max(0, nowMs - t);
}

// ---------------------------------------------------------------------------
// Caller context
// ---------------------------------------------------------------------------

/**
 * Identity of the agent calling a heartbeat tool. Populated at the bridge
 * boundary from MCP env vars — same forgeable-identity caveat as the
 * schedule endpoints (see `schedule-service.ts` and `bridge.ts` for the
 * full TODO(security) note).
 */
export interface HeartbeatCaller {
  readonly agentName: string;
  readonly isAdmin: boolean;
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

/**
 * Returns the cron interval (ms) that should be recorded on a write.
 *
 * In production this reads the agent's `heartbeat` cron entry from its
 * `agent.json`. If no heartbeat cron is configured, returns a reasonable
 * default (the documented 4h). Exported as a dependency so tests can
 * stub it without loading a real agent config.
 */
export type ResolveAgentIntervalMs = (agent: string) => number;

export interface HeartbeatServiceDeps {
  readonly paths: HeartbeatPaths;
  readonly hooks: RondelHooks;
  readonly orgLookup: OrgLookup;
  /** Agent existence check; rejects writes for unknown callers. */
  readonly isKnownAgent: (agent: string) => boolean;
  /** List every currently-registered agent name. Used to compute "missing." */
  readonly listAllAgents: () => readonly string[];
  /** Resolves the cron interval for the record's `intervalMs` field. */
  readonly resolveIntervalMs: ResolveAgentIntervalMs;
  readonly log: Logger;
}

// ---------------------------------------------------------------------------
// Public errors
// ---------------------------------------------------------------------------

export type HeartbeatErrorCode =
  | "validation"
  | "unknown_agent"
  | "forbidden"
  | "cross_org";

export class HeartbeatError extends Error {
  constructor(public readonly code: HeartbeatErrorCode, message: string) {
    super(message);
    this.name = "HeartbeatError";
  }
}

// ---------------------------------------------------------------------------
// Update input
// ---------------------------------------------------------------------------

export interface HeartbeatUpdateFields {
  readonly status: string;
  readonly currentTask?: string;
  readonly notes?: string;
}

// ---------------------------------------------------------------------------
// Read-all response
// ---------------------------------------------------------------------------

export interface HeartbeatReadAllResult {
  readonly records: readonly HeartbeatRecordWithHealth[];
  readonly missing: readonly string[];
  readonly summary: {
    readonly healthy: number;
    readonly stale: number;
    readonly down: number;
    readonly missing: number;
  };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

const GLOBAL_ORG_LABEL = "global";

export class HeartbeatService {
  private readonly log: Logger;

  constructor(private readonly deps: HeartbeatServiceDeps) {
    this.log = deps.log.child("heartbeats");
  }

  /** Ensure the state directory exists. Call once at startup. */
  async init(): Promise<void> {
    await mkdir(this.deps.paths.dir, { recursive: true });
  }

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  /**
   * Record the caller's current heartbeat. Self-write only — the service
   * never writes a record for a different agent than `caller.agentName`.
   * Emits `heartbeat:updated` on success.
   */
  async update(caller: HeartbeatCaller, fields: HeartbeatUpdateFields): Promise<HeartbeatRecord> {
    this.assertAgentExists(caller.agentName);

    const record: HeartbeatRecord = {
      agent: caller.agentName,
      org: this.orgLabelFor(caller.agentName),
      status: fields.status,
      currentTask: fields.currentTask,
      notes: fields.notes,
      updatedAt: new Date().toISOString(),
      intervalMs: this.deps.resolveIntervalMs(caller.agentName),
    };

    await writeHeartbeat(this.deps.paths, record);
    this.deps.hooks.emit("heartbeat:updated", { record });
    this.log.info(`Heartbeat updated: ${caller.agentName} — ${shortStatus(fields.status)}`);
    return record;
  }

  /**
   * Remove an agent's heartbeat record. Called from the admin delete-agent
   * flow; idempotent. Does NOT emit an event — the record is being
   * retired alongside the agent itself.
   */
  async removeForAgent(agent: string): Promise<void> {
    await removeHeartbeat(this.deps.paths, agent);
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  /**
   * Read a single agent's current heartbeat. Returns `undefined` when the
   * agent has never written a beat. Org-gated: non-admin cross-org reads
   * are rejected.
   *
   * Validates BOTH caller and target exist — a forged `callerAgent` with
   * `isAdmin=false` must not be silently accepted (it would hit the
   * cross-org check with `orgLabelFor` falling back to "global" and could
   * leak heartbeats for global agents).
   */
  async readOne(caller: HeartbeatCaller, agent: string): Promise<HeartbeatRecordWithHealth | undefined> {
    this.assertAgentExists(caller.agentName);
    this.assertAgentExists(agent);
    this.assertCrossOrgAllowed(caller, agent);

    const record = await readHeartbeat(this.deps.paths, agent, this.log);
    if (!record) return undefined;
    return withHealth(record, Date.now());
  }

  /**
   * Read every heartbeat in scope. Admin-only today — per design §4/§14 Q5.
   * Non-admin callers are rejected; when orchestrator role ships the gate
   * widens to `isAdmin || role === "orchestrator"` (one-line change).
   *
   * `org` is the target scope label ("global" for unaffiliated agents).
   * If omitted it defaults to the caller's own org. The caller must exist
   * in the registry — a forged `callerAgent` with `isAdmin=true` is
   * rejected here rather than silently granting fleet access.
   */
  async readAll(caller: HeartbeatCaller, opts: { org?: string } = {}): Promise<HeartbeatReadAllResult> {
    this.assertAgentExists(caller.agentName);
    if (!caller.isAdmin) {
      throw new HeartbeatError(
        "forbidden",
        "Fleet heartbeat reads are admin-only",
      );
    }

    const targetOrg = opts.org ?? this.orgLabelFor(caller.agentName);

    // Gather the agent names in scope.
    const allAgents = this.deps.listAllAgents();
    const inScope = allAgents.filter((name) => this.orgLabelFor(name) === targetOrg);

    // Read every record in scope in parallel. Classify at emit time.
    const now = Date.now();
    const reads = await Promise.all(
      inScope.map(async (name) => {
        const record = await readHeartbeat(this.deps.paths, name, this.log);
        return { name, record };
      }),
    );

    const records: HeartbeatRecordWithHealth[] = [];
    const missing: string[] = [];
    for (const { name, record } of reads) {
      if (record) records.push(withHealth(record, now));
      else missing.push(name);
    }

    // Summary counts.
    let healthy = 0;
    let stale = 0;
    let down = 0;
    for (const r of records) {
      if (r.health === "healthy") healthy++;
      else if (r.health === "stale") stale++;
      else down++;
    }

    return {
      records,
      missing,
      summary: { healthy, stale, down, missing: missing.length },
    };
  }

  /**
   * Read every record on disk (ignores org scope). Used by the stream
   * source's `snapshot()` to paint the initial fleet view for an SSE
   * client — the handler applies any org filter itself.
   */
  async readAllUnscoped(): Promise<readonly HeartbeatRecordWithHealth[]> {
    const records = await listHeartbeats(this.deps.paths, this.log);
    const now = Date.now();
    return records.map((r) => withHealth(r, now));
  }

  // -------------------------------------------------------------------------
  // Pure re-exports for callers who already have a record in hand
  // -------------------------------------------------------------------------

  /** Exposes the pure filter for callers that want to check staleness without re-reading. */
  findStale(records: readonly HeartbeatRecord[], nowMs: number): HeartbeatRecord[] {
    return findStale(records, nowMs);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private assertAgentExists(agent: string): void {
    if (!this.deps.isKnownAgent(agent)) {
      throw new HeartbeatError("unknown_agent", `Unknown agent: ${agent}`);
    }
  }

  /**
   * Cross-org isolation — admins may cross, non-admins may not. Mirrors
   * `ScheduleService.assertOrgAllowed` and the inter-agent messaging
   * check.
   *
   * Precondition: both caller and target agent exist. Callers must
   * validate via `assertAgentExists` first; this method does not
   * re-check (the `checkOrgIsolation` "Unknown agent" branch is thus
   * provably unreachable here).
   */
  private assertCrossOrgAllowed(caller: HeartbeatCaller, targetAgent: string): void {
    if (caller.agentName === targetAgent) return;
    if (caller.isAdmin) return; // admins cross freely
    const err = checkOrgIsolation(this.deps.orgLookup, caller.agentName, targetAgent);
    if (err === null) return;
    throw new HeartbeatError(
      "cross_org",
      err.replace(/^Cross-org messaging blocked/, "Cross-org heartbeat read blocked"),
    );
  }

  private orgLabelFor(agent: string): string {
    const res = this.deps.orgLookup(agent);
    if (res.status === "org") return res.orgName;
    // Unknown agents shouldn't reach this path — they're rejected earlier.
    return GLOBAL_ORG_LABEL;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function shortStatus(s: string): string {
  return s.length > 60 ? s.slice(0, 60) + "..." : s;
}
