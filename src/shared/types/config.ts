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

// --- Channel binding ---

/**
 * Binds an agent to a channel account.
 * An agent can have multiple bindings (e.g., Telegram + Slack).
 */
export interface ChannelBinding {
  readonly channelType: string;      // "telegram", "slack", etc.
  readonly accountId: string;        // key into the adapter's account registry
  readonly credentialEnvVar: string;  // env var name holding the secret (e.g., "KAI_TELEGRAM_TOKEN")
}

// --- Agent config ---

export interface AgentConfig {
  readonly agentName: string;
  readonly enabled: boolean;
  readonly admin?: boolean; // If true, agent gets admin MCP tools (add_agent, update_agent, set_env, reload)
  readonly model: string;
  readonly permissionMode: string;
  readonly workingDirectory: string | null;
  readonly channels: readonly ChannelBinding[];
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
