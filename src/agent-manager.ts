import { AgentProcess, type McpConfigMap, type AgentProcessSessionOptions } from "./agent-process.js";
import { SubagentProcess, type SubagentOptions } from "./subagent-process.js";
import { TelegramAdapter } from "./telegram.js";
import { loadAgentConfig, loadTemplateConfig } from "./config.js";
import { assembleContext, assembleTemplateContext } from "./context-assembler.js";
import { resolveTranscriptPath, createTranscript } from "./transcript.js";
import type { AgentConfig, AgentState, SubagentSpawnRequest, SubagentInfo, CronJob, SessionIndex } from "./types.js";
import type { FlowclawHooks } from "./hooks.js";
import type { Logger } from "./logger.js";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";

/**
 * Agent template — the shared config and system prompt for an agent.
 * One template can spawn many conversations (processes).
 */
interface AgentTemplate {
  readonly name: string;
  readonly config: AgentConfig;
  readonly systemPrompt: string;
}

export interface ConversationInfo {
  readonly agentName: string;
  readonly conversationKey: string;
  readonly chatId: string;
  readonly state: AgentState;
  readonly sessionId: string;
}

/** Resolve the path to the compiled mcp-server.js relative to this module. */
function resolveMcpServerPath(): string {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  return resolve(thisDir, "mcp-server.js");
}

/** How long to keep completed subagent results before pruning. */
const SUBAGENT_RESULT_TTL_MS = 60 * 60 * 1000; // 1 hour
const SUBAGENT_PRUNE_INTERVAL_MS = 5 * 60 * 1000; // check every 5 minutes

/**
 * Manages agent templates, per-conversation processes, session persistence,
 * and transcript lifecycle.
 *
 * Session persistence follows OpenClaw's two-layer model:
 * - Layer 1: Session index (sessions.json) — maps conversation keys to session IDs
 * - Layer 2: Transcripts (JSONL) — append-only conversation history
 */
export class AgentManager {
  private readonly templates = new Map<string, AgentTemplate>();
  private readonly conversations = new Map<string, AgentProcess>(); // conversationKey → process
  private readonly accountToAgent = new Map<string, string>();      // accountId → agentName
  private readonly agentToAccount = new Map<string, string>();      // agentName → accountId
  private readonly subagents = new Map<string, { process: SubagentProcess; info: SubagentInfo; startedAt: number }>();
  private telegram: TelegramAdapter | null = null;
  private readonly mcpServerPath: string;
  private readonly log: Logger;
  private bridgeUrl: string = "";
  private projectDir: string = "";
  private projectId: string = "";
  private pruneTimer: ReturnType<typeof setInterval> | null = null;

  /** Session index: conversation key → session entry. Persisted to disk. */
  private sessionIndex: SessionIndex = {};

  constructor(
    log: Logger,
    private readonly hooks?: FlowclawHooks,
  ) {
    this.log = log.child("agent-manager");
    this.mcpServerPath = resolveMcpServerPath();
    this.pruneTimer = setInterval(() => this.pruneSubagents(), SUBAGENT_PRUNE_INTERVAL_MS);
  }

  /** Set the bridge URL so MCP server processes can reach FlowClaw core. */
  setBridgeUrl(url: string): void {
    this.bridgeUrl = url;
  }

  // --- Session persistence ---

  /** Base directory for all FlowClaw state files. */
  private stateDir(): string {
    return join(homedir(), ".flowclaw", this.projectId);
  }

  /** Base directory for transcript files. */
  private transcriptsDir(): string {
    return join(this.stateDir(), "transcripts");
  }

  private sessionIndexPath(): string {
    return join(this.stateDir(), "sessions.json");
  }

  /** Load session index from disk. Called once during startup. */
  async loadSessionIndex(): Promise<void> {
    try {
      const raw = await readFile(this.sessionIndexPath(), "utf-8");
      this.sessionIndex = JSON.parse(raw) as SessionIndex;
      const count = Object.keys(this.sessionIndex).length;
      this.log.info(`Loaded session index: ${count} session(s)`);
    } catch {
      this.sessionIndex = {};
      this.log.info("No session index found — starting fresh");
    }
  }

  /** Persist session index to disk. Called after session changes and on shutdown. */
  async persistSessionIndex(): Promise<void> {
    const dir = this.stateDir();
    await mkdir(dir, { recursive: true });
    await writeFile(this.sessionIndexPath(), JSON.stringify(this.sessionIndex, null, 2), "utf-8");
  }

  /**
   * Reset a conversation's session. Deletes the session index entry so the
   * next message starts a completely fresh session. Old transcript stays on
   * disk (history preserved). The next call to getOrSpawnConversation() will
   * generate a new UUID and use --session-id (not --resume).
   */
  resetSession(agentName: string, chatId: string): void {
    const key = conversationKey(agentName, chatId);

    // Remove the index entry — next spawn will create a fresh session
    delete this.sessionIndex[key];

    // Stop and remove the existing process
    const process = this.conversations.get(key);
    if (process) {
      process.stop();
      this.conversations.delete(key);
    }

    this.persistSessionIndex().catch(() => {});
    this.log.info(`Session reset: ${key} (entry removed — next message starts fresh)`);
  }

  // --- Initialization ---

  /**
   * Load all agent configs and set up channel adapters.
   * Does NOT spawn any processes — those are created per-conversation.
   */
  async initialize(
    projectDir: string,
    projectId: string,
    agentNames: readonly string[],
    allowedUsers: readonly string[],
  ): Promise<void> {
    const telegram = new TelegramAdapter(allowedUsers, this.log);

    this.projectId = projectId;

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
    this.projectDir = projectDir;
  }

  getTelegram(): TelegramAdapter {
    if (!this.telegram) throw new Error("AgentManager not initialized");
    return this.telegram;
  }

  /** Resolve which agent owns a given account. */
  resolveAgentByAccount(accountId: string): string | undefined {
    return this.accountToAgent.get(accountId);
  }

  /** Get the account ID for a given agent. */
  getAccountForAgent(agentName: string): string | undefined {
    return this.agentToAccount.get(agentName);
  }

  /**
   * Get or spawn a conversation process for a specific chat.
   * First message to a new chat spawns a fresh Claude process.
   * Subsequent messages reuse the existing process.
   *
   * Session persistence: if a session ID exists in the index for this conversation,
   * the process is spawned with --resume to restore context.
   */
  getOrSpawnConversation(agentName: string, chatId: string): AgentProcess | undefined {
    const key = conversationKey(agentName, chatId);
    const existing = this.conversations.get(key);
    if (existing) return existing;

    const template = this.templates.get(agentName);
    if (!template) return undefined;

    this.log.info(`Spawning new conversation: ${agentName} @ chat ${chatId}`);

    const mcpConfig: McpConfigMap = {
      // FlowClaw's own MCP server — always present
      flowclaw: {
        command: "node",
        args: [this.mcpServerPath],
        env: {
          FLOWCLAW_BOT_TOKEN: template.config.telegram.botToken,
          FLOWCLAW_BRIDGE_URL: this.bridgeUrl,
          FLOWCLAW_PARENT_AGENT: agentName,
          FLOWCLAW_PARENT_CHAT_ID: chatId,
        },
      },
      // User-defined MCP servers from agent.json
      ...template.config.mcp?.servers,
    };

    // Resolve session: existing entry → resume, new → fresh session ID
    const existingEntry = this.sessionIndex[key];
    let sessionId: string;
    let resume: boolean;

    if (existingEntry) {
      sessionId = existingEntry.sessionId;
      resume = true;
      this.log.info(`Resuming session ${sessionId} for ${key}`);
    } else {
      sessionId = randomUUID();
      resume = false;
      this.log.info(`New session ${sessionId} for ${key}`);
    }

    // Create/update session index entry
    const now = Date.now();
    this.sessionIndex[key] = {
      sessionId,
      agentName,
      chatId,
      createdAt: existingEntry?.createdAt ?? now,
      updatedAt: now,
    };

    // Resolve transcript path and create file with session header
    const transcriptPath = resolveTranscriptPath(this.transcriptsDir(), agentName, sessionId);
    if (!resume) {
      // New session — create transcript with header (async, don't block)
      createTranscript(transcriptPath, {
        type: "session_start",
        sessionId,
        agentName,
        chatId,
        model: template.config.model,
        timestamp: new Date().toISOString(),
      }, this.log).catch(() => {});
    }

    const sessionOptions: AgentProcessSessionOptions = {
      sessionId,
      resume,
      transcriptPath,
    };

    const process = new AgentProcess(template.config, template.systemPrompt, this.log, mcpConfig, sessionOptions);

    // Listen for session establishment to persist the confirmed session ID
    process.on("sessionEstablished", (confirmedSessionId) => {
      const entry = this.sessionIndex[key];
      if (!entry) return; // entry may have been deleted by resetSession()
      if (confirmedSessionId !== sessionId) {
        // CLI assigned a different session ID than we requested — update index
        this.sessionIndex[key] = { ...entry, sessionId: confirmedSessionId, updatedAt: Date.now() };
      } else {
        this.sessionIndex[key] = { ...entry, updatedAt: Date.now() };
      }
      this.persistSessionIndex().catch(() => {});
    });

    // Listen for resume failure — delete entry so next spawn starts fresh
    process.on("error", (err) => {
      if (err.message === "resume_failed") {
        this.log.warn(`Resume failed for ${key} — entry removed, next spawn starts fresh`);
        delete this.sessionIndex[key];
        this.persistSessionIndex().catch(() => {});
      }
    });

    process.start();
    this.conversations.set(key, process);

    // Persist session index (fire-and-forget)
    this.persistSessionIndex().catch(() => {});

    return process;
  }

  /** Get an existing conversation (don't spawn). */
  getConversation(agentName: string, chatId: string): AgentProcess | undefined {
    return this.conversations.get(conversationKey(agentName, chatId));
  }

  /** Restart a conversation's process. */
  restartConversation(agentName: string, chatId: string): boolean {
    const key = conversationKey(agentName, chatId);
    const process = this.conversations.get(key);
    if (!process) return false;
    this.log.info(`Restarting conversation: ${agentName} @ chat ${chatId}`);
    process.restart();
    return true;
  }

  /** Stop all conversation processes. */
  stopAll(): void {
    for (const [key, process] of this.conversations) {
      this.log.info(`Stopping conversation: ${key}`);
      process.stop();
    }
  }

  /** Get all agent template names. */
  getAgentNames(): string[] {
    return [...this.templates.keys()];
  }

  /** Get info about all active conversations. */
  getAllConversationInfo(): ConversationInfo[] {
    const info: ConversationInfo[] = [];
    for (const [key, process] of this.conversations) {
      const [agentName, chatId] = parseConversationKey(key);
      info.push({
        agentName,
        conversationKey: key,
        chatId,
        state: process.getState(),
        sessionId: process.getSessionId(),
      });
    }
    return info;
  }

  /** Get conversations for a specific agent. */
  getConversationsForAgent(agentName: string): ConversationInfo[] {
    return this.getAllConversationInfo().filter((c) => c.agentName === agentName);
  }

  // --- Subagent lifecycle ---

  /**
   * Spawn an ephemeral subagent to execute a task.
   * Returns immediately with the subagent info (state: "running").
   * The subagent runs in the background. When it finishes, lifecycle hooks fire
   * and the result is delivered back to the parent agent as a message.
   *
   * Follows OpenClaw's async model: spawn is non-blocking, results are push-based.
   */
  async spawnSubagent(request: SubagentSpawnRequest): Promise<SubagentInfo> {
    const id = `sub_${Date.now()}_${randomBytes(3).toString("hex")}`;
    const parentTemplate = this.templates.get(request.parentAgentName);

    // Resolve system prompt: explicit > template > error
    let systemPrompt: string;
    let model: string;
    let allowedTools = request.allowedTools;
    let disallowedTools = request.disallowedTools;
    let mcpServers: Readonly<Record<string, import("./types.js").McpServerEntry>> | undefined;

    if (request.systemPrompt) {
      systemPrompt = request.systemPrompt;
      model = request.model ?? parentTemplate?.config.model ?? "sonnet";
    } else if (request.template) {
      const templateConfig = await loadTemplateConfig(this.projectDir, request.template);
      const templateContext = await assembleTemplateContext(this.projectDir, request.template, this.log);

      if (!templateContext) {
        throw new Error(`Template "${request.template}" not found — missing templates/${request.template}/SYSTEM.md`);
      }

      systemPrompt = templateContext;
      model = request.model ?? templateConfig?.model ?? parentTemplate?.config.model ?? "sonnet";

      if (!allowedTools && templateConfig?.tools?.allowed?.length) {
        allowedTools = templateConfig.tools.allowed;
      }
      if (!disallowedTools && templateConfig?.tools?.disallowed?.length) {
        disallowedTools = templateConfig.tools.disallowed;
      }

      mcpServers = templateConfig?.mcp?.servers;
    } else {
      throw new Error("Either 'template' or 'system_prompt' must be provided");
    }

    const workingDirectory = request.workingDirectory ?? parentTemplate?.config.workingDirectory ?? undefined;

    const mcpConfig: McpConfigMap = {
      flowclaw: {
        command: "node",
        args: [this.mcpServerPath],
        env: {
          FLOWCLAW_BOT_TOKEN: parentTemplate?.config.telegram.botToken ?? "",
          FLOWCLAW_BRIDGE_URL: this.bridgeUrl,
          FLOWCLAW_PARENT_AGENT: request.parentAgentName,
          FLOWCLAW_PARENT_CHAT_ID: request.parentChatId,
        },
      },
      ...mcpServers,
    };

    // Create transcript for subagent — stored under parent agent's directory
    const transcriptPath = resolveTranscriptPath(this.transcriptsDir(), request.parentAgentName, id);
    createTranscript(transcriptPath, {
      type: "session_start",
      sessionId: id,
      agentName: `${request.parentAgentName}/${request.template ?? "subagent"}`,
      chatId: request.parentChatId,
      model,
      timestamp: new Date().toISOString(),
    }, this.log).catch(() => {});

    const options: SubagentOptions = {
      id,
      task: request.task,
      systemPrompt,
      model,
      workingDirectory,
      maxTurns: request.maxTurns,
      timeoutMs: request.timeoutMs,
      allowedTools: allowedTools as string[] | undefined,
      disallowedTools: disallowedTools as string[] | undefined,
      mcpConfig,
      transcriptPath,
    };

    const subProcess = new SubagentProcess(options, this.log);

    const info: SubagentInfo = {
      id,
      parentAgentName: request.parentAgentName,
      parentChatId: request.parentChatId,
      task: request.task,
      state: "running",
      startedAt: new Date().toISOString(),
    };

    this.subagents.set(id, { process: subProcess, info, startedAt: Date.now() });

    // Emit spawning hook — listeners send Telegram notification
    this.hooks?.emit("subagent:spawning", {
      id,
      parentAgentName: request.parentAgentName,
      parentChatId: request.parentChatId,
      task: request.task,
      template: request.template,
    });

    subProcess.start();
    this.log.info(`Subagent spawned: ${id} (parent: ${request.parentAgentName}, task: "${request.task.slice(0, 80)}")`);

    // Watch in background — don't block the caller.
    // When the subagent finishes, emit hooks so listeners can deliver the result.
    subProcess.done.then((result) => {
      const finalInfo: SubagentInfo = {
        ...info,
        state: result.state,
        result: result.result,
        error: result.error,
        costUsd: result.costUsd,
        completedAt: result.completedAt,
      };

      if (result.state === "completed") {
        this.hooks?.emit("subagent:completed", { info: finalInfo });
      } else {
        this.hooks?.emit("subagent:failed", { info: finalInfo });
      }
    });

    return info;
  }

  /** Get current state of a subagent. */
  getSubagent(id: string): SubagentInfo | undefined {
    const entry = this.subagents.get(id);
    if (!entry) return undefined;

    const result = entry.process.getResult();
    return {
      ...entry.info,
      state: result.state,
      result: result.result,
      error: result.error,
      costUsd: result.costUsd,
      completedAt: result.completedAt,
    };
  }

  /** Kill a running subagent. */
  killSubagent(id: string): boolean {
    const entry = this.subagents.get(id);
    if (!entry) return false;
    if (entry.process.getState() !== "running") return false;

    entry.process.kill("killed");
    this.log.info(`Subagent killed: ${id}`);
    return true;
  }

  /** List subagents, optionally filtered by parent agent. */
  listSubagents(parentAgentName?: string): SubagentInfo[] {
    const results: SubagentInfo[] = [];
    for (const [, entry] of this.subagents) {
      if (parentAgentName && entry.info.parentAgentName !== parentAgentName) continue;
      const result = entry.process.getResult();
      results.push({
        ...entry.info,
        state: result.state,
        result: result.result,
        error: result.error,
        costUsd: result.costUsd,
        completedAt: result.completedAt,
      });
    }
    return results;
  }

  // --- Cron run lifecycle ---

  /** Get an agent template (config + system prompt) by name. */
  getTemplate(agentName: string): { config: AgentConfig; systemPrompt: string } | undefined {
    return this.templates.get(agentName);
  }

  /**
   * Spawn an ephemeral process to execute a cron job.
   * Reuses the agent's template (model, tools, MCP config) but runs in isolation.
   * Returns a promise that resolves when the run completes.
   */
  async spawnCronRun(
    agentName: string,
    job: CronJob,
  ): Promise<{ result?: string; error?: string; costUsd?: number; state: import("./types.js").SubagentState }> {
    const template = this.templates.get(agentName);
    if (!template) throw new Error(`Unknown agent: ${agentName}`);

    const id = `cron_${job.id}_${Date.now()}_${randomBytes(3).toString("hex")}`;

    const mcpConfig: McpConfigMap = {
      flowclaw: {
        command: "node",
        args: [this.mcpServerPath],
        env: {
          FLOWCLAW_BOT_TOKEN: template.config.telegram.botToken,
          FLOWCLAW_BRIDGE_URL: this.bridgeUrl,
          FLOWCLAW_PARENT_AGENT: agentName,
          FLOWCLAW_PARENT_CHAT_ID: "", // no parent chat for cron runs
        },
      },
      ...template.config.mcp?.servers,
    };

    // Create transcript for cron run
    const transcriptPath = resolveTranscriptPath(this.transcriptsDir(), agentName, id);
    await createTranscript(transcriptPath, {
      type: "session_start",
      sessionId: id,
      agentName,
      chatId: `cron:${job.id}`,
      model: job.model ?? template.config.model,
      timestamp: new Date().toISOString(),
    }, this.log);

    const options: SubagentOptions = {
      id,
      task: job.prompt,
      systemPrompt: template.systemPrompt,
      model: job.model ?? template.config.model,
      workingDirectory: template.config.workingDirectory ?? undefined,
      allowedTools: template.config.tools.allowed as string[] | undefined,
      disallowedTools: template.config.tools.disallowed as string[] | undefined,
      timeoutMs: job.timeoutMs,
      mcpConfig,
      transcriptPath,
    };

    const subProcess = new SubagentProcess(options, this.log);
    subProcess.start();

    this.log.info(`Cron run started: ${id} (agent: ${agentName}, job: ${job.id})`);

    const result = await subProcess.done;
    this.log.info(`Cron run finished: ${id} (state: ${result.state})`);
    return result;
  }

  /** Remove completed subagent results older than the TTL. */
  private pruneSubagents(): void {
    const now = Date.now();
    for (const [id, entry] of this.subagents) {
      if (entry.process.getState() === "running") continue;
      if (now - entry.startedAt > SUBAGENT_RESULT_TTL_MS) {
        this.subagents.delete(id);
        this.log.debug(`Pruned subagent result: ${id}`);
      }
    }
  }
}

function conversationKey(agentName: string, chatId: string): string {
  return `${agentName}:${chatId}`;
}

function parseConversationKey(key: string): [string, string] {
  const idx = key.indexOf(":");
  return [key.slice(0, idx), key.slice(idx + 1)];
}
