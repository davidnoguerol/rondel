import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { FlowclawConfig, AgentConfig } from "./types.js";

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

export async function loadFlowclawConfig(projectDir: string): Promise<FlowclawConfig> {
  const configPath = join(projectDir, "flowclaw.config.json");
  const raw = await readFile(configPath, "utf-8");
  const config = parseJsonWithEnv(raw) as FlowclawConfig;

  if (!config.projectId) throw new Error("flowclaw.config.json: missing projectId");
  if (!config.agents || config.agents.length === 0) throw new Error("flowclaw.config.json: missing or empty agents array");
  if (!config.allowedUsers || config.allowedUsers.length === 0) throw new Error("flowclaw.config.json: missing or empty allowedUsers array");

  return config;
}

export async function loadAgentConfig(projectDir: string, agentName: string): Promise<AgentConfig> {
  const configPath = join(projectDir, "agents", agentName, "agent.json");
  const raw = await readFile(configPath, "utf-8");
  const config = parseJsonWithEnv(raw) as AgentConfig;

  if (!config.agentName) throw new Error(`agent.json for ${agentName}: missing agentName`);
  if (!config.telegram?.botToken) throw new Error(`agent.json for ${agentName}: missing telegram.botToken`);

  // Validate cron jobs if present
  if (config.crons) {
    for (const job of config.crons) {
      if (!job.id) throw new Error(`agent.json for ${agentName}: cron job missing id`);
      if (!job.name) throw new Error(`agent.json for ${agentName}: cron job "${job.id}" missing name`);
      if (!job.prompt) throw new Error(`agent.json for ${agentName}: cron job "${job.id}" missing prompt`);
      if (!job.schedule?.kind) throw new Error(`agent.json for ${agentName}: cron job "${job.id}" missing schedule.kind`);
      if (job.schedule.kind !== "every") throw new Error(`agent.json for ${agentName}: cron job "${job.id}" unsupported schedule kind "${job.schedule.kind}" (only "every" is supported)`);
      if (!job.schedule.interval) throw new Error(`agent.json for ${agentName}: cron job "${job.id}" missing schedule.interval`);
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
  projectDir: string,
  templateName: string,
): Promise<AgentConfig | undefined> {
  const configPath = join(projectDir, "templates", templateName, "agent.json");
  try {
    const raw = await readFile(configPath, "utf-8");
    return parseJsonWithEnv(raw) as AgentConfig;
  } catch {
    return undefined;
  }
}

/**
 * Discover agent directories under agents/.
 * Returns directory names that contain an agent.json file.
 */
export async function discoverAgents(projectDir: string): Promise<string[]> {
  const agentsDir = join(projectDir, "agents");
  const entries = await readdir(agentsDir, { withFileTypes: true });
  const discovered: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      await readFile(join(agentsDir, entry.name, "agent.json"), "utf-8");
      discovered.push(entry.name);
    } catch {
      // Directory exists but no agent.json — skip
    }
  }

  return discovered;
}
