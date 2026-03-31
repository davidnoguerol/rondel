import type { CronJob } from "./scheduling.js";

// --- MCP config (shared between agent config and process spawning) ---

export interface McpServerEntry {
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
}

// --- Config shapes ---

export interface RondelConfig {
  readonly defaultModel: string;
  readonly allowedUsers: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

// --- Agent config ---

export interface AgentConfig {
  readonly agentName: string;
  readonly enabled: boolean;
  readonly admin?: boolean; // If true, agent gets admin MCP tools (add_agent, update_agent, set_env, reload)
  readonly model: string;
  readonly permissionMode: string;
  readonly workingDirectory: string | null;
  readonly telegram: {
    readonly botToken: string;
  };
  readonly tools: {
    readonly allowed: readonly string[];
    readonly disallowed: readonly string[];
  };
  readonly mcp?: {
    readonly servers?: Readonly<Record<string, McpServerEntry>>;
  };
  readonly crons?: readonly CronJob[];
}

// --- Organization config ---

/** Configuration loaded from org.json. */
export interface OrgConfig {
  readonly orgName: string;
  readonly displayName?: string;
  readonly enabled?: boolean; // default: true
}

/** A discovered agent: its config, absolute directory path, and agentName. */
export interface DiscoveredAgent {
  readonly agentName: string;
  readonly agentDir: string;
  readonly config: AgentConfig;
  readonly orgName?: string;   // undefined = global agent (not part of any org)
  readonly orgDir?: string;    // absolute path to org directory, undefined for global agents
}

/** A discovered organization with its filesystem location. */
export interface DiscoveredOrg {
  readonly orgName: string;
  readonly orgDir: string;
  readonly config: OrgConfig;
}

/** Result of scanning workspaces/ for both orgs and agents. */
export interface DiscoveryResult {
  readonly orgs: DiscoveredOrg[];
  readonly agents: DiscoveredAgent[];
}
