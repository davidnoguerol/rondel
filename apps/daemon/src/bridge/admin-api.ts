/**
 * Admin API — business logic for administrative bridge endpoints.
 *
 * Extracted from Bridge to keep HTTP routing separate from admin workflows
 * (agent creation, config updates, org management, env mutation, system status).
 *
 * Methods return { status, data } — the Bridge handles HTTP response writing.
 * This keeps AdminApi HTTP-framework-agnostic and testable.
 */

import { readFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile } from "../shared/atomic-file.js";
import { rondelPaths, discoverAll, discoverSingleAgent, discoverSingleOrg } from "../config/index.js";
import { scaffoldAgent, scaffoldOrg } from "../cli/scaffold.js";
import { AddAgentSchema, UpdateAgentSchema, AddOrgSchema, SetEnvSchema, validateBody } from "./schemas.js";
import type { AgentManager } from "../agents/agent-manager.js";
import type { Logger } from "../shared/logger.js";
import type { ScheduleService } from "../scheduling/index.js";
import type { HeartbeatService } from "../heartbeats/index.js";
import type { TaskService } from "../tasks/index.js";

// ---------------------------------------------------------------------------
// Result type — decouples admin logic from HTTP response writing
// ---------------------------------------------------------------------------

export interface AdminResult {
  readonly status: number;
  readonly data: unknown;
}

// ---------------------------------------------------------------------------
// AdminApi
// ---------------------------------------------------------------------------

export class AdminApi {
  private readonly log: Logger;

  constructor(
    private readonly agentManager: AgentManager,
    private readonly rondelHome: string,
    log: Logger,
    private readonly schedules?: ScheduleService,
    private readonly heartbeats?: HeartbeatService,
    private readonly tasks?: TaskService,
  ) {
    this.log = log.child("admin-api");
  }

  /** GET /admin/status */
  systemStatus(): AdminResult {
    return { status: 200, data: this.agentManager.getSystemStatus() };
  }

  /** POST /admin/agents */
  async addAgent(body: unknown): Promise<AdminResult> {
    const parsed = validateBody(AddAgentSchema, body);
    if (!parsed.success) {
      return { status: 400, data: { error: parsed.error } };
    }

    const { agent_name: agentName, bot_token: botToken, model = "sonnet", location = "global/agents", working_directory: workingDirectory } = parsed.data;

    if (this.agentManager.getAgentNames().includes(agentName)) {
      return { status: 409, data: { error: `Agent "${agentName}" already exists.` } };
    }

    const paths = rondelPaths(this.rondelHome);
    const agentDir = join(paths.workspaces, location, agentName);

    // Guard against path traversal (e.g., location: "../../..")
    if (!agentDir.startsWith(paths.workspaces)) {
      return { status: 400, data: { error: "Invalid location — must stay within workspaces directory." } };
    }

    try {
      // Write token to .env and reference by env var name in agent config
      const credentialsEnvVar = `${agentName.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_BOT_TOKEN`;
      await appendFile(paths.env, `${credentialsEnvVar}=${botToken}\n`);
      process.env[credentialsEnvVar] = botToken; // make available immediately for this process
      await scaffoldAgent({ agentDir, agentName, credentialsEnvVar, model, workingDirectory });

      // Determine org from resolved path — check if agentDir falls under a known org's directory
      const orgs = this.agentManager.getOrgs();
      const parentOrg = orgs.find((o) => agentDir.startsWith(o.orgDir + "/"));
      const org = parentOrg ? { orgName: parentOrg.orgName, orgDir: parentOrg.orgDir } : undefined;

      const agent = await discoverSingleAgent(agentDir, org);
      await this.agentManager.registerAgent(agent);
      return { status: 201, data: { ok: true, agent_name: agentName, agent_dir: agentDir, org: org?.orgName } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error(`Add agent failed: ${message}`);
      return { status: 500, data: { error: message } };
    }
  }

  /** PATCH /admin/agents/:name */
  async updateAgent(agentName: string, body: unknown): Promise<AdminResult> {
    const template = this.agentManager.getTemplate(agentName);
    if (!template) {
      return { status: 404, data: { error: `Agent "${agentName}" not found.` } };
    }

    const parsed = validateBody(UpdateAgentSchema, body);
    if (!parsed.success) {
      return { status: 400, data: { error: parsed.error } };
    }

    const patch = parsed.data;
    if (Object.values(patch).every((v) => v === undefined)) {
      return { status: 400, data: { error: "At least one field must be provided." } };
    }

    try {
      // Read existing agent.json, merge patch, write back
      const agentDir = this.agentManager.getAgentDir(agentName);
      const configPath = join(agentDir, "agent.json");
      const existing = JSON.parse(await readFile(configPath, "utf-8")) as Record<string, unknown>;

      // Only merge fields that are present in the validated patch
      const allowedFields = ["model", "enabled", "admin", "workingDirectory"] as const;
      for (const field of allowedFields) {
        if (patch[field] !== undefined) {
          existing[field] = patch[field];
        }
      }

      await atomicWriteFile(configPath, JSON.stringify(existing, null, 2) + "\n");

      // Reload and update the template
      const agent = await discoverSingleAgent(agentDir);
      await this.agentManager.updateAgentConfig(agentName, agent.config);

      return { status: 200, data: { ok: true } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error(`Update agent failed: ${message}`);
      return { status: 500, data: { error: message } };
    }
  }

  /** DELETE /admin/agents/:name */
  async deleteAgent(agentName: string): Promise<AdminResult> {
    if (!this.agentManager.getTemplate(agentName)) {
      return { status: 404, data: { error: `Agent "${agentName}" not found.` } };
    }

    try {
      // Get dir BEFORE unregistering (unregister removes it from the map)
      const agentDir = this.agentManager.getAgentDir(agentName);

      // Purge any runtime schedules owned by this agent BEFORE unregistering
      // — once the template is gone the scheduler can't look up the owner's
      // channel binding to deliver results, and the orphan schedule would
      // sit in state/schedules.json forever.
      if (this.schedules) {
        try {
          const count = await this.schedules.purgeForAgent(agentName);
          if (count > 0) {
            this.log.info(`Purged ${count} runtime schedule(s) owned by ${agentName}`);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.log.warn(`Failed to purge schedules for ${agentName}: ${msg}`);
        }
      }

      // Drop the agent's heartbeat record. Fire-and-forget-on-error — a
      // leftover heartbeat file for a deleted agent is ugly but harmless
      // (the agent name will not resolve on next readAll).
      if (this.heartbeats) {
        try {
          await this.heartbeats.removeForAgent(agentName);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.log.warn(`Failed to remove heartbeat for ${agentName}: ${msg}`);
        }
      }

      // Cancel every non-terminal task assigned to this agent so the
      // board stops pointing at a dead inbox. Completed tasks are left
      // intact for audit purposes.
      if (this.tasks) {
        try {
          await this.tasks.onAgentDeleted(agentName);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.log.warn(`Failed to cancel tasks for ${agentName}: ${msg}`);
        }
      }

      // Unregister: stop polling, kill conversations, remove from registries
      this.agentManager.unregisterAgent(agentName);

      // Delete agent directory from disk
      const { rm } = await import("node:fs/promises");
      await rm(agentDir, { recursive: true, force: true });

      return { status: 200, data: { ok: true, agent_name: agentName } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error(`Delete agent failed: ${message}`);
      return { status: 500, data: { error: message } };
    }
  }

  /** POST /admin/orgs */
  async addOrg(body: unknown): Promise<AdminResult> {
    const parsed = validateBody(AddOrgSchema, body);
    if (!parsed.success) {
      return { status: 400, data: { error: parsed.error } };
    }

    const { org_name: orgName, display_name: displayName } = parsed.data;

    if (this.agentManager.getOrgByName(orgName)) {
      return { status: 409, data: { error: `Organization "${orgName}" already exists.` } };
    }

    const paths = rondelPaths(this.rondelHome);
    const orgDir = join(paths.workspaces, orgName);

    // Guard against path traversal
    if (!orgDir.startsWith(paths.workspaces)) {
      return { status: 400, data: { error: "Invalid org_name — must stay within workspaces directory." } };
    }

    try {
      await scaffoldOrg({ orgDir, orgName, displayName: displayName || undefined });
      const org = await discoverSingleOrg(orgDir);
      this.agentManager.registerOrg(org);
      return { status: 201, data: { ok: true, org_name: orgName, org_dir: orgDir } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error(`Add org failed: ${message}`);
      return { status: 500, data: { error: message } };
    }
  }

  /** POST /admin/reload */
  async reload(): Promise<AdminResult> {
    try {
      const { orgs, agents } = await discoverAll(this.rondelHome);

      // Register new orgs
      const existingOrgNames = new Set(this.agentManager.getOrgs().map((o) => o.orgName));
      const addedOrgs: string[] = [];
      for (const org of orgs) {
        if (!existingOrgNames.has(org.orgName)) {
          this.agentManager.registerOrg(org);
          addedOrgs.push(org.orgName);
        }
      }

      // Register new agents, update existing
      const existingNames = new Set(this.agentManager.getAgentNames());
      const added: string[] = [];
      const updated: string[] = [];

      for (const agent of agents) {
        if (!existingNames.has(agent.agentName)) {
          await this.agentManager.registerAgent(agent);
          added.push(agent.agentName);
        } else {
          await this.agentManager.updateAgentConfig(agent.agentName, agent.config);
          updated.push(agent.agentName);
        }
      }

      return { status: 200, data: { ok: true, orgs_added: addedOrgs, agents_added: added, agents_updated: updated } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error(`Reload failed: ${message}`);
      return { status: 500, data: { error: message } };
    }
  }

  /** PUT /admin/env */
  async setEnv(body: unknown): Promise<AdminResult> {
    const parsed = validateBody(SetEnvSchema, body);
    if (!parsed.success) {
      return { status: 400, data: { error: parsed.error } };
    }

    const { key, value } = parsed.data;

    try {
      const envPath = rondelPaths(this.rondelHome).env;

      // Read existing .env, update or append
      let envContent = "";
      try {
        envContent = await readFile(envPath, "utf-8");
      } catch {
        // .env doesn't exist yet — that's fine
      }

      const newLine = `${key}=${value}`;

      if (envContent.length === 0) {
        // Empty or new file — write single line with trailing newline
        await atomicWriteFile(envPath, `${newLine}\n`);
      } else {
        const lines = envContent.split("\n");
        const pattern = new RegExp(`^${key}=`);
        const lineIndex = lines.findIndex((l) => pattern.test(l));

        if (lineIndex >= 0) {
          lines[lineIndex] = newLine;
        } else {
          // Append — ensure we don't double-newline
          if (lines[lines.length - 1] === "") {
            lines.splice(lines.length - 1, 0, newLine);
          } else {
            lines.push(newLine);
          }
        }

        await atomicWriteFile(envPath, lines.join("\n"));
      }

      // Set in current process for immediate effect
      process.env[key] = value;

      return { status: 200, data: { ok: true } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error(`Set env failed: ${message}`);
      return { status: 500, data: { error: message } };
    }
  }
}
