/**
 * Disk-backed store linking a task whose completion is awaiting human
 * approval to the approval record in `approvals/`.
 *
 * File per org: `state/tasks/{org}/.pending-approvals.json`.
 * Versioned envelope `{version: 1, entries: PendingApprovalEntry[]}` —
 * same shape pattern as `schedules.json`.
 *
 * Why disk-backed (not in-memory): the window between "agent requested
 * completion with externalAction" and "human taps Approve/Deny" can
 * cross daemon restarts. Without persistence, a restart would leave the
 * task stuck in `in_progress` and the agent would re-request on its
 * next heartbeat — workable, but extra noise. Persisting lets
 * `TaskService.init()` reconcile any resolved-while-dead approvals and
 * apply the outcome exactly once.
 *
 * Concurrency: the daemon holds a single `PendingApprovalStore`
 * instance. Every mutation is in-memory-then-atomic-persist, same as
 * `ScheduleStore`. Two concurrent `add`/`remove` calls in-flight at
 * once will both see a consistent in-memory array before either
 * awaits, so the final persisted state converges correctly.
 */

import { readFile } from "node:fs/promises";
import { atomicWriteFile } from "../shared/atomic-file.js";
import type { Logger } from "../shared/logger.js";
import type { PendingApprovalEntry } from "../shared/types/tasks.js";
import { pendingApprovalsPath, ensureOrgDirs, listOrgs, type TaskPaths } from "./task-store.js";

const CURRENT_VERSION = 1;

interface FileV1 {
  readonly version: 1;
  readonly entries: readonly PendingApprovalEntry[];
}

export class PendingApprovalStore {
  /** org → ordered list of pending entries. */
  private readonly byOrg = new Map<string, PendingApprovalEntry[]>();
  private loaded = false;

  constructor(
    private readonly paths: TaskPaths,
    private readonly log: Logger,
  ) {}

  /**
   * Load every org's pending-approvals file into memory. Must be
   * called once at startup before `list` / `add` / `remove`. Missing
   * files are treated as empty.
   */
  async init(): Promise<void> {
    const orgs = await listOrgs(this.paths);
    for (const org of orgs) {
      const entries = await this.readFile(org);
      if (entries.length > 0) this.byOrg.set(org, [...entries]);
    }
    this.loaded = true;
  }

  list(org: string): readonly PendingApprovalEntry[] {
    this.assertLoaded();
    return this.byOrg.get(org) ?? [];
  }

  listAll(): readonly PendingApprovalEntry[] {
    this.assertLoaded();
    const all: PendingApprovalEntry[] = [];
    for (const entries of this.byOrg.values()) all.push(...entries);
    return all;
  }

  /**
   * Find the entry (if any) pointing at a given approvalRequestId.
   * Scans across orgs — the approval module doesn't know the entry's
   * owning org at resolution time.
   */
  findByApprovalId(approvalRequestId: string): PendingApprovalEntry | undefined {
    this.assertLoaded();
    for (const entries of this.byOrg.values()) {
      for (const e of entries) {
        if (e.approvalRequestId === approvalRequestId) return e;
      }
    }
    return undefined;
  }

  findByTaskId(org: string, taskId: string): PendingApprovalEntry | undefined {
    this.assertLoaded();
    const entries = this.byOrg.get(org);
    if (!entries) return undefined;
    return entries.find((e) => e.taskId === taskId);
  }

  /**
   * Append an entry for an org. If the same (org, taskId) already has
   * an entry, the new one replaces it — the earlier one is stale
   * (either the approval was already resolved and we missed it, or
   * the task is being re-completed after a denial).
   */
  async add(org: string, entry: PendingApprovalEntry): Promise<void> {
    this.assertLoaded();
    const current = this.byOrg.get(org) ?? [];
    const filtered = current.filter((e) => e.taskId !== entry.taskId);
    filtered.push(entry);
    this.byOrg.set(org, filtered);
    await this.persist(org);
  }

  async remove(org: string, taskId: string): Promise<void> {
    this.assertLoaded();
    const current = this.byOrg.get(org);
    if (!current || current.length === 0) return;
    const filtered = current.filter((e) => e.taskId !== taskId);
    if (filtered.length === current.length) return; // no-op
    if (filtered.length === 0) {
      this.byOrg.delete(org);
    } else {
      this.byOrg.set(org, filtered);
    }
    await this.persist(org);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private assertLoaded(): void {
    if (!this.loaded) {
      throw new Error("PendingApprovalStore.init() must be called before use");
    }
  }

  private async readFile(org: string): Promise<readonly PendingApprovalEntry[]> {
    const path = pendingApprovalsPath(this.paths, org);
    let raw: string;
    try {
      raw = await readFile(path, "utf-8");
    } catch {
      return [];
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.log.warn(
        `[tasks] pending-approvals file at ${path} is corrupt JSON — starting empty`,
      );
      return [];
    }
    if (!parsed || typeof parsed !== "object") return [];
    const file = parsed as { version?: number; entries?: unknown };
    if (file.version !== CURRENT_VERSION) {
      this.log.warn(
        `[tasks] pending-approvals file at ${path} has version ${String(file.version)} (expected ${CURRENT_VERSION}) — starting empty`,
      );
      return [];
    }
    if (!Array.isArray(file.entries)) return [];
    // Trust the shape — bridge/schemas.ts validates at the HTTP
    // boundary; the store only ever writes validated entries via add().
    return file.entries as PendingApprovalEntry[];
  }

  private async persist(org: string): Promise<void> {
    const path = pendingApprovalsPath(this.paths, org);
    const entries = this.byOrg.get(org) ?? [];
    if (entries.length === 0) {
      // Keep the file around — writing {version:1, entries:[]} is
      // clearer than a ghost presence when debugging. ensureOrgDirs
      // created the parent already.
      await ensureOrgDirs(this.paths, org);
      const file: FileV1 = { version: CURRENT_VERSION, entries: [] };
      await atomicWriteFile(path, JSON.stringify(file, null, 2) + "\n");
      return;
    }
    await ensureOrgDirs(this.paths, org);
    const file: FileV1 = { version: CURRENT_VERSION, entries };
    await atomicWriteFile(path, JSON.stringify(file, null, 2) + "\n");
  }
}
