import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { FlowclawConfig, AgentConfig, DiscoveredAgent } from "../shared/types.js";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Resolve the FlowClaw home directory. Override with FLOWCLAW_HOME env var. */
export function resolveFlowclawHome(): string {
  return process.env.FLOWCLAW_HOME ?? join(homedir(), ".flowclaw");
}

/** Standard subdirectories under FLOWCLAW_HOME. */
export function flowclawPaths(flowclawHome: string) {
  return {
    config: join(flowclawHome, "config.json"),
    env: join(flowclawHome, ".env"),
    workspaces: join(flowclawHome, "workspaces"),
    templates: join(flowclawHome, "templates"),
    state: join(flowclawHome, "state"),
    sessions: join(flowclawHome, "state", "sessions.json"),
    cronState: join(flowclawHome, "state", "cron-state.json"),
    lock: join(flowclawHome, "state", "flowclaw.lock"),
    log: join(flowclawHome, "state", "flowclaw.log"),
    transcripts: join(flowclawHome, "state", "transcripts"),
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

export async function loadFlowclawConfig(flowclawHome: string): Promise<FlowclawConfig> {
  const configPath = flowclawPaths(flowclawHome).config;
  const raw = await readFile(configPath, "utf-8");
  const config = parseJsonWithEnv(raw) as FlowclawConfig;

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
  if (!config.telegram?.botToken) throw new Error(`agent.json for ${config.agentName}: missing telegram.botToken`);

  // Validate cron jobs if present
  if (config.crons) {
    for (const job of config.crons) {
      if (!job.id) throw new Error(`agent.json for ${config.agentName}: cron job missing id`);
      if (!job.name) throw new Error(`agent.json for ${config.agentName}: cron job "${job.id}" missing name`);
      if (!job.prompt) throw new Error(`agent.json for ${config.agentName}: cron job "${job.id}" missing prompt`);
      if (!job.schedule?.kind) throw new Error(`agent.json for ${config.agentName}: cron job "${job.id}" missing schedule.kind`);
      if (job.schedule.kind !== "every") throw new Error(`agent.json for ${config.agentName}: cron job "${job.id}" unsupported schedule kind "${job.schedule.kind}" (only "every" is supported)`);
      if (!job.schedule.interval) throw new Error(`agent.json for ${config.agentName}: cron job "${job.id}" missing schedule.interval`);
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
  flowclawHome: string,
  templateName: string,
): Promise<AgentConfig | undefined> {
  const configPath = join(flowclawPaths(flowclawHome).templates, templateName, "agent.json");
  try {
    const raw = await readFile(configPath, "utf-8");
    return parseJsonWithEnv(raw) as AgentConfig;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Agent discovery
// ---------------------------------------------------------------------------

/**
 * Recursively scan the workspaces directory for directories containing agent.json.
 * Returns DiscoveredAgent[] with absolute paths and loaded configs.
 * Throws on duplicate agentName values.
 */
export async function discoverAgents(flowclawHome: string): Promise<DiscoveredAgent[]> {
  const workspacesDir = flowclawPaths(flowclawHome).workspaces;
  const discovered: DiscoveredAgent[] = [];

  await scanDir(workspacesDir, discovered);

  // Validate uniqueness of agentName
  const seen = new Map<string, string>(); // agentName → agentDir
  for (const agent of discovered) {
    const existing = seen.get(agent.agentName);
    if (existing) {
      throw new Error(
        `Duplicate agentName "${agent.agentName}" found in:\n` +
        `  1. ${existing}\n` +
        `  2. ${agent.agentDir}\n` +
        `Each agent must have a unique agentName field in agent.json.`,
      );
    }
    seen.set(agent.agentName, agent.agentDir);
  }

  return discovered;
}

async function scanDir(dir: string, results: DiscoveredAgent[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // Directory doesn't exist or can't be read — skip
  }

  // Check if this directory has an agent.json
  const hasAgentJson = entries.some((e) => e.isFile() && e.name === "agent.json");
  if (hasAgentJson) {
    try {
      const config = await loadAgentConfig(dir);
      if (config.enabled !== false) {
        results.push({ agentName: config.agentName, agentDir: dir, config });
      }
    } catch {
      // Invalid agent.json — skip (doctor command will catch these)
    }
    return; // Don't recurse into agent directories
  }

  // Recurse into subdirectories
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".")) continue; // skip hidden dirs
    await scanDir(join(dir, entry.name), results);
  }
}
