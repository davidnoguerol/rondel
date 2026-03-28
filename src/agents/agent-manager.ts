/**
 * Agent template registry and initialization facade.
 *
 * This module is the entry point for agent setup. It loads discovered agent
 * configs, assembles system prompts, registers Telegram bot accounts, and
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
import { flowclawPaths } from "../config/config.js";
import { assembleContext } from "../config/context-assembler.js";
import { ConversationManager, type AgentTemplate, type ConversationInfo } from "./conversation-manager.js";
import { SubagentManager } from "./subagent-manager.js";
import { CronRunner } from "../scheduling/cron-runner.js";
import type { AgentConfig, DiscoveredAgent, SubagentSpawnRequest, SubagentInfo } from "../shared/types.js";
import type { FlowclawHooks } from "../shared/hooks.js";
import type { Logger } from "../shared/logger.js";
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
  private readonly accountToAgent = new Map<string, string>(); // accountId → agentName
  private readonly agentToAccount = new Map<string, string>(); // agentName → accountId
  private telegram: TelegramAdapter | null = null;

  // --- Focused managers (created during initialize()) ---
  private _conversations: ConversationManager | null = null;
  private _subagents: SubagentManager | null = null;
  private _cronRunner: CronRunner | null = null;

  // --- Shared infrastructure ---
  private readonly mcpServerPath: string;
  private readonly log: Logger;
  private bridgeUrl: string = "";
  private flowclawHome: string = "";

  constructor(
    log: Logger,
    private readonly hooks?: FlowclawHooks,
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

  /** Set the bridge URL so MCP server processes can reach FlowClaw core. */
  setBridgeUrl(url: string): void {
    this.bridgeUrl = url;
  }

  // -------------------------------------------------------------------------
  // Initialization
  // -------------------------------------------------------------------------

  /**
   * Load all discovered agents and set up channel adapters.
   *
   * Creates the focused managers (ConversationManager, SubagentManager,
   * CronRunner) and populates the template registry. Does NOT spawn any
   * processes — those are created per-conversation on first message.
   */
  async initialize(
    flowclawHome: string,
    agents: readonly DiscoveredAgent[],
    allowedUsers: readonly string[],
  ): Promise<void> {
    this.flowclawHome = flowclawHome;
    const paths = flowclawPaths(flowclawHome);
    const telegram = new TelegramAdapter(allowedUsers, this.log);

    // Global context directory for system prompt assembly
    const globalContextDir = join(paths.workspaces, "global");

    // Load each agent's system prompt and register
    for (const agent of agents) {
      const systemPrompt = await assembleContext(agent.agentDir, this.log, { globalContextDir });

      this.templates.set(agent.agentName, {
        name: agent.agentName,
        agentDir: agent.agentDir,
        config: agent.config,
        systemPrompt,
      });
      this.agentDirs.set(agent.agentName, agent.agentDir);

      // Register bot as a Telegram account (accountId = agent name)
      const accountId = agent.agentName;
      telegram.addAccount(accountId, { botToken: agent.config.telegram.botToken });
      this.accountToAgent.set(accountId, agent.agentName);
      this.agentToAccount.set(agent.agentName, accountId);

      this.log.info(`Loaded agent template: ${agent.agentName} (model: ${agent.config.model}, dir: ${agent.agentDir})`);
    }

    this.telegram = telegram;

    // --- Create focused managers ---

    const getBridgeUrl = () => this.bridgeUrl;
    const getTemplate = (name: string) => this.templates.get(name);

    this._conversations = new ConversationManager(
      paths.state,
      this.mcpServerPath,
      getBridgeUrl,
      this.log,
    );

    this._subagents = new SubagentManager(
      flowclawHome,
      paths.transcripts,
      this.mcpServerPath,
      getBridgeUrl,
      getTemplate,
      this.hooks,
      this.log,
    );

    this._cronRunner = new CronRunner(
      flowclawHome,
      paths.transcripts,
      this.mcpServerPath,
      getBridgeUrl,
      getTemplate,
      this._conversations,
      this.log,
    );
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
  // Channel adapter access
  // -------------------------------------------------------------------------

  getTelegram(): TelegramAdapter {
    if (!this.telegram) throw new Error("AgentManager not initialized");
    return this.telegram;
  }

  /** Resolve which agent owns a given Telegram account. */
  resolveAgentByAccount(accountId: string): string | undefined {
    return this.accountToAgent.get(accountId);
  }

  /** Get the Telegram account ID for a given agent. */
  getAccountForAgent(agentName: string): string | undefined {
    return this.agentToAccount.get(agentName);
  }

  // -------------------------------------------------------------------------
  // Facade: conversation lifecycle (delegates to ConversationManager)
  // -------------------------------------------------------------------------

  /**
   * Get or spawn a conversation process for a specific chat.
   * Delegates to ConversationManager, passing the resolved template.
   */
  getOrSpawnConversation(agentName: string, chatId: string): import("./agent-process.js").AgentProcess | undefined {
    const template = this.templates.get(agentName);
    if (!template) return undefined;
    return this.conversations.getOrSpawn(template, chatId);
  }

  /** Get an existing conversation process (don't spawn). */
  getConversation(agentName: string, chatId: string): import("./agent-process.js").AgentProcess | undefined {
    return this.conversations.get(agentName, chatId);
  }

  /** Restart a conversation's process. */
  restartConversation(agentName: string, chatId: string): boolean {
    return this.conversations.restart(agentName, chatId);
  }

  /** Reset a conversation's session (delete index entry, stop process). */
  resetSession(agentName: string, chatId: string): void {
    this.conversations.resetSession(agentName, chatId);
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
   * registers template, adds Telegram account, and starts polling.
   */
  async registerAgent(agent: DiscoveredAgent): Promise<void> {
    if (this.templates.has(agent.agentName)) {
      throw new Error(`Agent "${agent.agentName}" already exists`);
    }
    if (!this.telegram) throw new Error("AgentManager not initialized");

    const paths = flowclawPaths(this.flowclawHome);
    const globalContextDir = join(paths.workspaces, "global");
    const systemPrompt = await assembleContext(agent.agentDir, this.log, { globalContextDir });

    this.templates.set(agent.agentName, {
      name: agent.agentName,
      agentDir: agent.agentDir,
      config: agent.config,
      systemPrompt,
    });
    this.agentDirs.set(agent.agentName, agent.agentDir);

    const accountId = agent.agentName;
    this.telegram.addAccount(accountId, { botToken: agent.config.telegram.botToken });
    this.accountToAgent.set(accountId, agent.agentName);
    this.agentToAccount.set(agent.agentName, accountId);
    this.telegram.startAccount(accountId);

    this.log.info(`Registered agent at runtime: ${agent.agentName} (model: ${agent.config.model}, dir: ${agent.agentDir})`);
  }

  /**
   * Update an existing agent's config and reassemble its system prompt.
   * Running conversations keep their current prompt — new conversations use the update.
   */
  async updateAgentConfig(agentName: string, newConfig: AgentConfig): Promise<void> {
    const existing = this.templates.get(agentName);
    if (!existing) throw new Error(`Agent "${agentName}" not found`);

    // Bot token changes require a restart — warn if detected
    if (existing.config.telegram.botToken !== newConfig.telegram.botToken) {
      this.log.warn(`Agent "${agentName}" bot token changed — restart required for the new token to take effect`);
    }

    const paths = flowclawPaths(this.flowclawHome);
    const globalContextDir = join(paths.workspaces, "global");
    const systemPrompt = await assembleContext(existing.agentDir, this.log, { globalContextDir });

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
    agents: { name: string; model: string; admin: boolean; conversations: number }[];
  } {
    const agents = [...this.templates.values()].map((t) => ({
      name: t.name,
      model: t.config.model,
      admin: t.config.admin === true,
      conversations: this._conversations ? this._conversations.getForAgent(t.name).length : 0,
    }));

    return {
      uptimeSeconds: Math.floor(process.uptime()),
      agentCount: agents.length,
      agents,
    };
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
