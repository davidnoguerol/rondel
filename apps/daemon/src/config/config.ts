import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { RondelConfig, AgentConfig, OrgConfig, DiscoveredAgent, DiscoveredOrg, DiscoveryResult } from "../shared/types/index.js";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Resolve the Rondel home directory. Override with RONDEL_HOME env var. */
export function resolveRondelHome(): string {
  return process.env.RONDEL_HOME ?? join(homedir(), ".rondel");
}

/** Standard subdirectories under RONDEL_HOME. */
export function rondelPaths(rondelHome: string) {
  return {
    config: join(rondelHome, "config.json"),
    env: join(rondelHome, ".env"),
    workspaces: join(rondelHome, "workspaces"),
    templates: join(rondelHome, "templates"),
    state: join(rondelHome, "state"),
    sessions: join(rondelHome, "state", "sessions.json"),
    cronState: join(rondelHome, "state", "cron-state.json"),
    // Runtime-created schedules (see apps/daemon/src/scheduling/schedule-store.ts).
    schedulesFile: join(rondelHome, "state", "schedules.json"),
    lock: join(rondelHome, "state", "rondel.lock"),
    log: join(rondelHome, "state", "rondel.log"),
    transcripts: join(rondelHome, "state", "transcripts"),
    // HITL approval store (see apps/daemon/src/approvals).
    approvals: join(rondelHome, "state", "approvals"),
    approvalsPending: join(rondelHome, "state", "approvals", "pending"),
    approvalsResolved: join(rondelHome, "state", "approvals", "resolved"),
  } as const;
}

// ---------------------------------------------------------------------------
// Env var substitution
// ---------------------------------------------------------------------------

/**
 * Replace ${ENV_VAR} patterns with values from process.env.
 * Throws if a referenced variable is not set.
 */
function substituteEnvVars(text: string): string {
  return text.replace(/\$\{(\w+)}/g, (_match, varName: string) => {
    const value = process.env[varName];
    if (value === undefined) {
      throw new Error(`Environment variable ${varName} is not set (referenced in config)`);
    }
    return value;
  });
}

function parseJsonWithEnv(raw: string): unknown {
  const substituted = substituteEnvVars(raw);
  return JSON.parse(substituted);
}

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

export async function loadRondelConfig(rondelHome: string): Promise<RondelConfig> {
  const configPath = rondelPaths(rondelHome).config;
  const raw = await readFile(configPath, "utf-8");
  const config = parseJsonWithEnv(raw) as RondelConfig;

  if (!config.allowedUsers || config.allowedUsers.length === 0) {
    throw new Error("config.json: missing or empty allowedUsers array");
  }

  return config;
}

export async function loadAgentConfig(agentDir: string): Promise<AgentConfig> {
  const configPath = join(agentDir, "agent.json");
  const raw = await readFile(configPath, "utf-8");
  const config = parseJsonWithEnv(raw) as AgentConfig;

  if (!config.agentName) throw new Error(`agent.json in ${agentDir}: missing agentName`);
  const agentName = config.agentName;

  // Validate channels
  if (!Array.isArray(config.channels) || config.channels.length === 0) {
    throw new Error(`agent.json for ${agentName}: missing or empty "channels" array`);
  }
  for (const binding of config.channels) {
    if (!binding.channelType) throw new Error(`agent.json for ${agentName}: channel binding missing channelType`);
    if (!binding.accountId) throw new Error(`agent.json for ${agentName}: channel binding missing accountId`);
    if (!binding.credentialEnvVar) throw new Error(`agent.json for ${agentName}: channel binding missing credentialEnvVar`);
    if (binding.extraEnvVars !== undefined) {
      if (typeof binding.extraEnvVars !== "object" || binding.extraEnvVars === null || Array.isArray(binding.extraEnvVars)) {
        throw new Error(`agent.json for ${agentName}: channel binding "${binding.accountId}" extraEnvVars must be an object mapping string keys to env var names`);
      }
      for (const [key, envVarName] of Object.entries(binding.extraEnvVars)) {
        if (typeof envVarName !== "string" || envVarName.length === 0) {
          throw new Error(`agent.json for ${agentName}: channel binding "${binding.accountId}" extraEnvVars["${key}"] must be a non-empty string`);
        }
      }
    }
  }

  // Validate cron jobs if present
  if (config.crons) {
    for (const job of config.crons) {
      if (!job.id) throw new Error(`agent.json for ${agentName}: cron job missing id`);
      if (!job.name) throw new Error(`agent.json for ${agentName}: cron job "${job.id}" missing name`);
      if (!job.prompt) throw new Error(`agent.json for ${agentName}: cron job "${job.id}" missing prompt`);
      if (!job.schedule?.kind) throw new Error(`agent.json for ${agentName}: cron job "${job.id}" missing schedule.kind`);
      const kind = job.schedule.kind;
      switch (kind) {
        case "every":
          if (!("interval" in job.schedule) || !job.schedule.interval) {
            throw new Error(`agent.json for ${agentName}: cron job "${job.id}" missing schedule.interval`);
          }
          break;
        case "at":
          if (!("at" in job.schedule) || !job.schedule.at) {
            throw new Error(`agent.json for ${agentName}: cron job "${job.id}" missing schedule.at`);
          }
          break;
        case "cron":
          if (!("expression" in job.schedule) || !job.schedule.expression) {
            throw new Error(`agent.json for ${agentName}: cron job "${job.id}" missing schedule.expression`);
          }
          break;
        default:
          throw new Error(`agent.json for ${agentName}: cron job "${job.id}" unsupported schedule kind "${kind as string}" (expected "every", "at", or "cron")`);
      }
    }
  }

  return config;
}

/**
 * Load a subagent template config from templates/{templateName}/agent.json.
 * Templates are optional blueprints for ephemeral subagents.
 * Returns undefined if the template doesn't exist.
 */
export async function loadTemplateConfig(
  rondelHome: string,
  templateName: string,
): Promise<AgentConfig | undefined> {
  const configPath = join(rondelPaths(rondelHome).templates, templateName, "agent.json");
  try {
    const raw = await readFile(configPath, "utf-8");
    return parseJsonWithEnv(raw) as AgentConfig;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Org config loading
// ---------------------------------------------------------------------------

export async function loadOrgConfig(orgDir: string): Promise<OrgConfig> {
  const configPath = join(orgDir, "org.json");
  const raw = await readFile(configPath, "utf-8");
  const config = parseJsonWithEnv(raw) as OrgConfig;

  if (!config.orgName) throw new Error(`org.json in ${orgDir}: missing orgName`);

  return config;
}

// ---------------------------------------------------------------------------
// Single-item discovery (used for hot-adding at runtime)
// ---------------------------------------------------------------------------

/**
 * Load and validate a single agent from a known directory.
 * Optionally associate it with an org if the agent is under an org's subtree.
 */
export async function discoverSingleAgent(
  agentDir: string,
  org?: { orgName: string; orgDir: string },
): Promise<DiscoveredAgent> {
  const config = await loadAgentConfig(agentDir);
  return {
    agentName: config.agentName,
    agentDir,
    config,
    orgName: org?.orgName,
    orgDir: org?.orgDir,
  };
}

/** Load and validate a single org from a known directory. */
export async function discoverSingleOrg(orgDir: string): Promise<DiscoveredOrg> {
  const config = await loadOrgConfig(orgDir);
  return { orgName: config.orgName, orgDir, config };
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/** Internal scan context passed through the recursive directory walk. */
interface ScanContext {
  readonly orgs: DiscoveredOrg[];
  readonly agents: DiscoveredAgent[];
  readonly currentOrg?: DiscoveredOrg;
}

/**
 * Recursively scan workspaces/ for org.json and agent.json files.
 * Returns both discovered orgs and agents in a single pass.
 * Throws on duplicate orgName or agentName values, or nested orgs.
 */
export async function discoverAll(rondelHome: string): Promise<DiscoveryResult> {
  const workspacesDir = rondelPaths(rondelHome).workspaces;
  const ctx: ScanContext = { orgs: [], agents: [] };

  await scanDir(workspacesDir, ctx);

  // Validate uniqueness of orgName
  const seenOrgs = new Map<string, string>(); // orgName → orgDir
  for (const org of ctx.orgs) {
    const existing = seenOrgs.get(org.orgName);
    if (existing) {
      throw new Error(
        `Duplicate orgName "${org.orgName}" found in:\n` +
        `  1. ${existing}\n` +
        `  2. ${org.orgDir}\n` +
        `Each organization must have a unique orgName field in org.json.`,
      );
    }
    seenOrgs.set(org.orgName, org.orgDir);
  }

  // Validate uniqueness of agentName
  const seenAgents = new Map<string, string>(); // agentName → agentDir
  for (const agent of ctx.agents) {
    const existing = seenAgents.get(agent.agentName);
    if (existing) {
      throw new Error(
        `Duplicate agentName "${agent.agentName}" found in:\n` +
        `  1. ${existing}\n` +
        `  2. ${agent.agentDir}\n` +
        `Each agent must have a unique agentName field in agent.json.`,
      );
    }
    seenAgents.set(agent.agentName, agent.agentDir);
  }

  return { orgs: ctx.orgs, agents: ctx.agents };
}

/**
 * Convenience wrapper — returns only agents (backward compat).
 * Delegates to discoverAll() internally.
 */
export async function discoverAgents(rondelHome: string): Promise<DiscoveredAgent[]> {
  const result = await discoverAll(rondelHome);
  return result.agents;
}

async function scanDir(dir: string, ctx: ScanContext): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // Directory doesn't exist or can't be read — skip
  }

  // Check if this directory has an agent.json — takes priority over org.json
  const hasAgentJson = entries.some((e) => e.isFile() && e.name === "agent.json");
  if (hasAgentJson) {
    try {
      const config = await loadAgentConfig(dir);
      if (config.enabled !== false) {
        ctx.agents.push({
          agentName: config.agentName,
          agentDir: dir,
          config,
          orgName: ctx.currentOrg?.orgName,
          orgDir: ctx.currentOrg?.orgDir,
        });
      }
    } catch {
      // Invalid agent.json — skip (doctor command will catch these)
    }
    return; // Don't recurse into agent directories
  }

  // Check if this directory has an org.json
  let orgForChildren = ctx.currentOrg;
  const hasOrgJson = entries.some((e) => e.isFile() && e.name === "org.json");
  if (hasOrgJson) {
    if (ctx.currentOrg) {
      throw new Error(
        `Nested organizations are not allowed.\n` +
        `  Parent org: "${ctx.currentOrg.orgName}" at ${ctx.currentOrg.orgDir}\n` +
        `  Nested org.json found at: ${dir}\n` +
        `Move the nested org outside its parent, or remove the inner org.json.`,
      );
    }
    try {
      const config = await loadOrgConfig(dir);
      if (config.enabled === false) {
        return; // Disabled org — skip entire subtree
      }
      const org: DiscoveredOrg = { orgName: config.orgName, orgDir: dir, config };
      ctx.orgs.push(org);
      orgForChildren = org;
    } catch {
      // Invalid org.json — skip (doctor command will catch these)
    }
  }

  // Recurse into subdirectories
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".")) continue; // skip hidden dirs
    await scanDir(join(dir, entry.name), { ...ctx, currentOrg: orgForChildren });
  }
}
