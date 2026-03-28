/**
 * Agent template registry and initialization facade.
 *
 * This module is the entry point for agent setup. It loads agent configs,
 * assembles system prompts, registers Telegram bot accounts, and provides
 * template lookups. It does NOT own conversation processes, subagents,
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

import { TelegramAdapter } from "./telegram.js";
import { loadAgentConfig } from "./config.js";
import { assembleContext } from "./context-assembler.js";
import { ConversationManager, type AgentTemplate, type ConversationInfo } from "./conversation-manager.js";
import { SubagentManager } from "./subagent-manager.js";
import { CronRunner } from "./cron-runner.js";
import type { SubagentSpawnRequest, SubagentInfo } from "./types.js";
import type { FlowclawHooks } from "./hooks.js";
import type { Logger } from "./logger.js";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { homedir } from "node:os";

// Re-export for backward compat (router, bridge import ConversationInfo from here)
export type { ConversationInfo } from "./conversation-manager.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve the path to the compiled mcp-server.js relative to this module. */
function resolveMcpServerPath(): string {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  return resolve(thisDir, "mcp-server.js");
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
   * Load all agent configs and set up channel adapters.
   *
   * Creates the focused managers (ConversationManager, SubagentManager,
   * CronRunner) and populates the template registry. Does NOT spawn any
   * processes — those are created per-conversation on first message.
   */
  async initialize(
    projectDir: string,
    projectId: string,
    agentNames: readonly string[],
    allowedUsers: readonly string[],
  ): Promise<void> {
    const telegram = new TelegramAdapter(allowedUsers, this.log);

    // Load each agent's config and system prompt
    for (const name of agentNames) {
      const config = await loadAgentConfig(projectDir, name);
      const systemPrompt = await assembleContext(projectDir, name, this.log);

      this.templates.set(name, { name, config, systemPrompt });

      // Register bot as a Telegram account (accountId = agent name)
      const accountId = name;
      telegram.addAccount(accountId, { botToken: config.telegram.botToken });
      this.accountToAgent.set(accountId, name);
      this.agentToAccount.set(name, accountId);

      this.log.info(`Loaded agent template: ${name} (model: ${config.model})`);
    }

    this.telegram = telegram;

    // --- Create focused managers ---

    const stateDir = join(homedir(), ".flowclaw", projectId);
    const transcriptsBaseDir = join(stateDir, "transcripts");
    const getBridgeUrl = () => this.bridgeUrl;
    const getTemplate = (name: string) => this.templates.get(name);

    this._conversations = new ConversationManager(
      stateDir,
      this.mcpServerPath,
      getBridgeUrl,
      this.log,
    );

    this._subagents = new SubagentManager(
      projectDir,
      transcriptsBaseDir,
      this.mcpServerPath,
      getBridgeUrl,
      getTemplate,
      this.hooks,
      this.log,
    );

    this._cronRunner = new CronRunner(
      transcriptsBaseDir,
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
  // Shutdown
  // -------------------------------------------------------------------------

  /** Stop all conversation processes and clean up resources. */
  stopAll(): void {
    this.conversations.stopAll();
    this.subagents.stopPruning();
  }
}
