/**
 * Agent template registry and initialization facade.
 *
 * This module is the entry point for agent setup. It loads discovered agent
 * configs, assembles system prompts, registers channel accounts, and
 * provides template lookups. It does NOT own conversation processes, subagents,
 * or session persistence — those are handled by dedicated managers:
 *
 * - ConversationManager: per-chat process lifecycle + session persistence
 * - SubagentManager: ephemeral subagent spawning + tracking
 * - CronRunner: cron job execution
 *
 * AgentManager acts as a facade for code that needs both template data and
 * conversation access (e.g. router, bridge). It delegates to the focused
 * managers for actual work.
 */

import { TelegramAdapter } from "../channels/telegram.js";
import { ChannelRegistry } from "../channels/channel-registry.js";
import { rondelPaths } from "../config/config.js";
import { assembleContext } from "../config/context-assembler.js";
import { ConversationManager, type AgentTemplate, type ConversationInfo } from "./conversation-manager.js";
import { SubagentManager } from "./subagent-manager.js";
import { CronRunner } from "../scheduling/cron-runner.js";
import type { AgentConfig, ChannelBinding, DiscoveredAgent, DiscoveredOrg, SubagentSpawnRequest, SubagentInfo } from "../shared/types/index.js";
import { AGENT_MAIL_CHAT_ID, INTERNAL_CHANNEL_TYPE } from "../shared/types/index.js";
import type { RondelHooks } from "../shared/hooks.js";
import type { Logger } from "../shared/logger.js";
import { readFile } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Re-export for backward compat (router, bridge import ConversationInfo from here)
export type { ConversationInfo } from "./conversation-manager.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve the path to the compiled mcp-server.js relative to this module. */
function resolveMcpServerPath(): string {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  return resolve(thisDir, "..", "bridge", "mcp-server.js");
}

/** Resolve the credential value from a ChannelBinding's env var name. */
function resolveCredential(binding: ChannelBinding): string {
  const value = process.env[binding.credentials];
  if (!value) {
    throw new Error(
      `Channel credential "${binding.credentials}" for account "${binding.accountId}" ` +
      `is not set in environment. Add it to .env or set it as an environment variable.`,
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// AgentManager
// ---------------------------------------------------------------------------

/**
 * Facade that ties together template registry, conversation manager,
 * subagent manager, and cron runner. External modules (router, bridge,
 * scheduler, index.ts) interact with this class — it delegates internally.
 */
export class AgentManager {
  // --- Template registry ---
  private readonly templates = new Map<string, AgentTemplate>();
  private readonly agentDirs = new Map<string, string>(); // agentName → absolute dir path

  // --- Channel bindings ---
  private readonly agentChannels = new Map<string, ChannelBinding[]>();  // agentName → bindings
  /** Reverse lookup: "channelType:accountId" → agentName */
  private readonly channelAccountToAgent = new Map<string, string>();
  private channelRegistry: ChannelRegistry | null = null;

  // --- Org registry ---
  private readonly orgRegistry: DiscoveredOrg[] = [];
  private readonly agentOrgs = new Map<string, { orgName: string; orgDir: string }>(); // agentName → org info

  // --- Focused managers (created during initialize()) ---
  private _conversations: ConversationManager | null = null;
  private _subagents: SubagentManager | null = null;
  private _cronRunner: CronRunner | null = null;

  // --- Shared infrastructure ---
  private readonly mcpServerPath: string;
  private readonly log: Logger;
  private bridgeUrl: string = "";
  private rondelHome: string = "";
  /** Framework-level context appended to system prompts for agent-mail conversations. */
  private agentMailContext: string = "";

  constructor(
    log: Logger,
    private readonly hooks?: RondelHooks,
  ) {
    this.log = log.child("agent-manager");
    this.mcpServerPath = resolveMcpServerPath();
  }

  // -------------------------------------------------------------------------
  // Accessors for focused managers
  // -------------------------------------------------------------------------

  /** The conversation lifecycle manager. Available after initialize(). */
  get conversations(): ConversationManager {
    if (!this._conversations) throw new Error("AgentManager not initialized");
    return this._conversations;
  }

  /** The subagent lifecycle manager. Available after initialize(). */
  get subagents(): SubagentManager {
    if (!this._subagents) throw new Error("AgentManager not initialized");
    return this._subagents;
  }

  /** The cron job execution engine. Available after initialize(). */
  get cronRunner(): CronRunner {
    if (!this._cronRunner) throw new Error("AgentManager not initialized");
    return this._cronRunner;
  }

  // -------------------------------------------------------------------------
  // Configuration
  // -------------------------------------------------------------------------

  /** Set the bridge URL so MCP server processes can reach Rondel core. */
  setBridgeUrl(url: string): void {
    this.bridgeUrl = url;
  }

  // -------------------------------------------------------------------------
  // Initialization
  // -------------------------------------------------------------------------

  /**
   * Load all discovered agents and orgs, set up channel adapters.
   *
   * Creates the focused managers (ConversationManager, SubagentManager,
   * CronRunner) and populates the template registry. Does NOT spawn any
   * processes — those are created per-conversation on first message.
   */
  async initialize(
    rondelHome: string,
    agents: readonly DiscoveredAgent[],
    allowedUsers: readonly string[],
    orgs?: readonly DiscoveredOrg[],
  ): Promise<void> {
    this.rondelHome = rondelHome;
    const paths = rondelPaths(rondelHome);

    // Create channel registry and register adapters
    const registry = new ChannelRegistry();
    registry.register(new TelegramAdapter(allowedUsers, this.log));
    this.channelRegistry = registry;

    // Store discovered orgs
    if (orgs) {
      this.orgRegistry.length = 0;
      this.orgRegistry.push(...orgs);
      this.log.info(`Loaded ${orgs.length} organization(s)`);
    }

    // Global context directory for system prompt assembly
    const globalContextDir = join(paths.workspaces, "global");

    // Load framework-level agent-mail context (templates/context/AGENT-MAIL.md)
    const agentMailPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "templates", "context", "AGENT-MAIL.md");
    try {
      this.agentMailContext = await readFile(agentMailPath, "utf-8");
      this.log.info("Loaded agent-mail context template");
    } catch {
      this.log.warn(`Agent-mail context not found at ${agentMailPath} — agent-mail conversations will use default system prompt`);
    }

    // Load each agent's system prompt and register
    for (const agent of agents) {
      const systemPrompt = await assembleContext(agent.agentDir, this.log, {
        globalContextDir,
        orgDir: agent.orgDir,
      });

      this.templates.set(agent.agentName, {
        name: agent.agentName,
        agentDir: agent.agentDir,
        config: agent.config,
        systemPrompt,
      });
      this.agentDirs.set(agent.agentName, agent.agentDir);

      // Store org association
      if (agent.orgName && agent.orgDir) {
        this.agentOrgs.set(agent.agentName, { orgName: agent.orgName, orgDir: agent.orgDir });
      }

      // Register channel bindings
      this.registerChannelBindings(agent.agentName, agent.config);

      const orgLabel = agent.orgName ? `, org: ${agent.orgName}` : "";
      this.log.info(`Loaded agent template: ${agent.agentName} (model: ${agent.config.model}${orgLabel}, dir: ${agent.agentDir})`);
    }

    // --- Create focused managers ---

    const getBridgeUrl = () => this.bridgeUrl;
    const getTemplate = (name: string) => this.templates.get(name);

    this._conversations = new ConversationManager(
      paths.state,
      this.mcpServerPath,
      getBridgeUrl,
      this.log,
      this.hooks,
    );

    this._subagents = new SubagentManager(
      rondelHome,
      paths.transcripts,
      this.mcpServerPath,
      getBridgeUrl,
      getTemplate,
      this.hooks,
      this.log,
    );

    this._cronRunner = new CronRunner(
      rondelHome,
      paths.transcripts,
      this.mcpServerPath,
      getBridgeUrl,
      getTemplate,
      this._conversations,
      this.log,
    );
  }

  /**
   * Register channel bindings for an agent. Adds accounts to the appropriate
   * channel adapters and updates the bidirectional lookup maps.
   */
  private registerChannelBindings(agentName: string, config: AgentConfig): void {
    const bindings = config.channels ?? [];
    this.agentChannels.set(agentName, [...bindings]);

    for (const binding of bindings) {
      const credential = resolveCredential(binding);
      const lookupKey = `${binding.channelType}:${binding.accountId}`;
      this.channelAccountToAgent.set(lookupKey, agentName);

      // Register the account with the appropriate channel adapter
      const adapter = this.channelRegistry?.get(binding.channelType);
      if (adapter) {
        adapter.addAccount(binding.accountId, credential);
      } else {
        this.log.warn(`No adapter for channel type "${binding.channelType}" — skipping account "${binding.accountId}" for agent "${agentName}"`);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Template queries
  // -------------------------------------------------------------------------

  /** Get all agent template names. */
  getAgentNames(): string[] {
    return [...this.templates.keys()];
  }

  /** Get an agent template (config + system prompt) by name. */
  getTemplate(agentName: string): AgentTemplate | undefined {
    return this.templates.get(agentName);
  }

  /** Get the filesystem path to an agent's directory. */
  getAgentDir(agentName: string): string {
    const dir = this.agentDirs.get(agentName);
    if (!dir) throw new Error(`Unknown agent: ${agentName}`);
    return dir;
  }

  // -------------------------------------------------------------------------
  // Channel access (new multi-channel API)
  // -------------------------------------------------------------------------

  /** Get the channel registry. */
  getChannelRegistry(): ChannelRegistry {
    if (!this.channelRegistry) throw new Error("AgentManager not initialized");
    return this.channelRegistry;
  }

  /** Get all channel bindings for an agent. */
  getChannelsForAgent(agentName: string): readonly ChannelBinding[] {
    return this.agentChannels.get(agentName) ?? [];
  }

  /** Get the primary channel binding (first in list — used for notifications). */
  getPrimaryChannel(agentName: string): { channelType: string; accountId: string } | undefined {
    const bindings = this.agentChannels.get(agentName);
    if (!bindings || bindings.length === 0) return undefined;
    return { channelType: bindings[0].channelType, accountId: bindings[0].accountId };
  }

  /** Reverse lookup: which agent owns this channel + account pair? */
  resolveAgentByChannel(channelType: string, accountId: string): string | undefined {
    return this.channelAccountToAgent.get(`${channelType}:${accountId}`);
  }

  // -------------------------------------------------------------------------
  // Facade: conversation lifecycle (delegates to ConversationManager)
  // -------------------------------------------------------------------------

  /**
   * Get or spawn a conversation process for a specific chat.
   * Delegates to ConversationManager, passing the resolved template.
   */
  getOrSpawnConversation(agentName: string, channelType: string, chatId: string): import("./agent-process.js").AgentProcess | undefined {
    const template = this.templates.get(agentName);
    if (!template) return undefined;

    // Agent-mail conversations get additional framework context appended
    if (chatId === AGENT_MAIL_CHAT_ID && this.agentMailContext) {
      const agentMailTemplate: AgentTemplate = {
        ...template,
        systemPrompt: template.systemPrompt + "\n\n" + this.agentMailContext,
      };
      return this.conversations.getOrSpawn(agentMailTemplate, channelType, chatId);
    }

    return this.conversations.getOrSpawn(template, channelType, chatId);
  }

  /** Get an existing conversation process (don't spawn). */
  getConversation(agentName: string, channelType: string, chatId: string): import("./agent-process.js").AgentProcess | undefined {
    return this.conversations.get(agentName, channelType, chatId);
  }

  /** Restart a conversation's process. */
  restartConversation(agentName: string, channelType: string, chatId: string): boolean {
    return this.conversations.restart(agentName, channelType, chatId);
  }

  /** Reset a conversation's session (delete index entry, stop process). */
  resetSession(agentName: string, channelType: string, chatId: string): void {
    this.conversations.resetSession(agentName, channelType, chatId);
  }

  /** Get conversations for a specific agent. */
  getConversationsForAgent(agentName: string): ConversationInfo[] {
    return this.conversations.getForAgent(agentName);
  }

  // -------------------------------------------------------------------------
  // Facade: session persistence (delegates to ConversationManager)
  // -------------------------------------------------------------------------

  /** Load session index from disk. Called once during startup. */
  async loadSessionIndex(): Promise<void> {
    return this.conversations.loadSessionIndex();
  }

  /** Persist session index to disk. Called on shutdown. */
  async persistSessionIndex(): Promise<void> {
    return this.conversations.persistSessionIndex();
  }

  // -------------------------------------------------------------------------
  // Facade: subagent lifecycle (delegates to SubagentManager)
  // -------------------------------------------------------------------------

  /** Spawn an ephemeral subagent. See SubagentManager.spawn(). */
  async spawnSubagent(request: SubagentSpawnRequest): Promise<SubagentInfo> {
    return this.subagents.spawn(request);
  }

  /** Get subagent status by ID. */
  getSubagent(id: string): SubagentInfo | undefined {
    return this.subagents.get(id);
  }

  /** Kill a running subagent. */
  killSubagent(id: string): boolean {
    return this.subagents.kill(id);
  }

  /** List subagents, optionally filtered by parent agent. */
  listSubagents(parentAgentName?: string): SubagentInfo[] {
    return this.subagents.list(parentAgentName);
  }

  // -------------------------------------------------------------------------
  // Runtime agent management
  // -------------------------------------------------------------------------

  /**
   * Register a new agent at runtime (hot-add).
   * Replicates what initialize() does per-agent: assembles system prompt,
   * registers template, adds channel accounts, and starts polling.
   */
  async registerAgent(agent: DiscoveredAgent): Promise<void> {
    if (this.templates.has(agent.agentName)) {
      throw new Error(`Agent "${agent.agentName}" already exists`);
    }
    if (!this.channelRegistry) throw new Error("AgentManager not initialized");

    const paths = rondelPaths(this.rondelHome);
    const globalContextDir = join(paths.workspaces, "global");
    const systemPrompt = await assembleContext(agent.agentDir, this.log, {
      globalContextDir,
      orgDir: agent.orgDir,
    });

    this.templates.set(agent.agentName, {
      name: agent.agentName,
      agentDir: agent.agentDir,
      config: agent.config,
      systemPrompt,
    });
    this.agentDirs.set(agent.agentName, agent.agentDir);

    // Store org association
    if (agent.orgName && agent.orgDir) {
      this.agentOrgs.set(agent.agentName, { orgName: agent.orgName, orgDir: agent.orgDir });
    }

    // Register and start channel bindings
    this.registerChannelBindings(agent.agentName, agent.config);
    for (const binding of agent.config.channels) {
      try {
        this.channelRegistry.startAccount(binding.channelType, binding.accountId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log.warn(`Failed to start account "${binding.accountId}" for channel "${binding.channelType}": ${msg}`);
      }
    }

    const orgLabel = agent.orgName ? `, org: ${agent.orgName}` : "";
    this.log.info(`Registered agent at runtime: ${agent.agentName} (model: ${agent.config.model}${orgLabel}, dir: ${agent.agentDir})`);
  }

  /**
   * Unregister an agent at runtime. Stops channel accounts, kills active
   * conversations, and removes from all registries. Does NOT delete files.
   */
  unregisterAgent(agentName: string): void {
    if (!this.templates.has(agentName)) {
      throw new Error(`Agent "${agentName}" not found`);
    }
    if (!this.channelRegistry) throw new Error("AgentManager not initialized");

    // Stop all conversations for this agent
    if (this._conversations) {
      const convos = this._conversations.getForAgent(agentName);
      for (const c of convos) {
        this._conversations.resetSession(agentName, c.channelType, c.chatId);
      }
    }

    // Remove channel bindings and stop accounts
    const bindings = this.agentChannels.get(agentName) ?? [];
    for (const binding of bindings) {
      this.channelAccountToAgent.delete(`${binding.channelType}:${binding.accountId}`);
      try {
        this.channelRegistry.removeAccount(binding.channelType, binding.accountId);
      } catch {
        // adapter may not exist or account already removed
      }
    }
    this.agentChannels.delete(agentName);

    // Remove template, dir, and org association
    this.templates.delete(agentName);
    this.agentDirs.delete(agentName);
    this.agentOrgs.delete(agentName);

    this.log.info(`Unregistered agent: ${agentName}`);
  }

  /**
   * Update an existing agent's config and reassemble its system prompt.
   * Running conversations keep their current prompt — new conversations use the update.
   */
  async updateAgentConfig(agentName: string, newConfig: AgentConfig): Promise<void> {
    const existing = this.templates.get(agentName);
    if (!existing) throw new Error(`Agent "${agentName}" not found`);

    const paths = rondelPaths(this.rondelHome);
    const globalContextDir = join(paths.workspaces, "global");
    const orgInfo = this.agentOrgs.get(agentName);
    const systemPrompt = await assembleContext(existing.agentDir, this.log, {
      globalContextDir,
      orgDir: orgInfo?.orgDir,
    });

    this.templates.set(agentName, {
      name: agentName,
      agentDir: existing.agentDir,
      config: newConfig,
      systemPrompt,
    });

    this.log.info(`Updated agent config: ${agentName} (model: ${newConfig.model})`);
  }

  /** Get a system status summary. */
  getSystemStatus(): {
    uptimeSeconds: number;
    agentCount: number;
    orgCount: number;
    agents: { name: string; model: string; admin: boolean; org?: string; conversations: number }[];
    orgs: { name: string; displayName?: string; agentCount: number }[];
  } {
    const agents = [...this.templates.values()].map((t) => ({
      name: t.name,
      model: t.config.model,
      admin: t.config.admin === true,
      org: this.agentOrgs.get(t.name)?.orgName,
      conversations: this._conversations ? this._conversations.getForAgent(t.name).length : 0,
    }));

    // Build org summary with agent counts
    const orgAgentCounts = new Map<string, number>();
    for (const org of this.agentOrgs.values()) {
      orgAgentCounts.set(org.orgName, (orgAgentCounts.get(org.orgName) ?? 0) + 1);
    }
    const orgs = this.orgRegistry.map((o) => ({
      name: o.orgName,
      displayName: o.config.displayName,
      agentCount: orgAgentCounts.get(o.orgName) ?? 0,
    }));

    return {
      uptimeSeconds: Math.floor(process.uptime()),
      agentCount: agents.length,
      orgCount: this.orgRegistry.length,
      agents,
      orgs,
    };
  }

  // -------------------------------------------------------------------------
  // Org queries
  // -------------------------------------------------------------------------

  /** Get all discovered organizations. */
  getOrgs(): readonly DiscoveredOrg[] {
    return this.orgRegistry;
  }

  /** Get a discovered org by name. */
  getOrgByName(orgName: string): DiscoveredOrg | undefined {
    return this.orgRegistry.find((o) => o.orgName === orgName);
  }

  /** Get the org a specific agent belongs to (undefined for global agents). */
  getAgentOrg(agentName: string): { orgName: string; orgDir: string } | undefined {
    return this.agentOrgs.get(agentName);
  }

  /** Register a new org at runtime. */
  registerOrg(org: DiscoveredOrg): void {
    if (this.orgRegistry.some((o) => o.orgName === org.orgName)) {
      throw new Error(`Organization "${org.orgName}" already exists`);
    }
    this.orgRegistry.push(org);
    this.log.info(`Registered org: ${org.orgName} (dir: ${org.orgDir})`);
  }

  // -------------------------------------------------------------------------
  // Shutdown
  // -------------------------------------------------------------------------

  /** Stop all conversation processes and clean up resources. */
  stopAll(): void {
    this.conversations.stopAll();
    this.subagents.stopPruning();
  }
}
