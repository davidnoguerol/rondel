import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { atomicWriteFile } from "../shared/atomic-file.js";
import { flowclawPaths, discoverAgents, discoverSingleAgent } from "../config/index.js";
import { scaffoldAgent } from "../cli/scaffold.js";
import type { AgentManager } from "../agents/agent-manager.js";
import type { Logger } from "../shared/logger.js";

/**
 * Internal HTTP bridge between MCP server processes and FlowClaw core.
 *
 * Listens on 127.0.0.1 with a random available port.
 * MCP server processes receive the bridge URL via FLOWCLAW_BRIDGE_URL env var
 * and call it to query FlowClaw state.
 *
 * Localhost-only, no auth — same-machine, same-user process communication.
 */
export class Bridge {
  private server: Server | null = null;
  private port: number = 0;
  private readonly log: Logger;

  constructor(
    private readonly agentManager: AgentManager,
    log: Logger,
    private readonly flowclawHome: string = "",
  ) {
    this.log = log.child("bridge");
  }

  /** Start the bridge server. Resolves with the assigned port. */
  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => this.handleRequest(req, res));

      server.on("error", (err) => {
        this.log.error(`Bridge server error: ${err.message}`);
        reject(err);
      });

      // Listen on 127.0.0.1 with port 0 (OS assigns an available port)
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (!addr || typeof addr === "string") {
          reject(new Error("Failed to get bridge server address"));
          return;
        }
        this.port = addr.port;
        this.server = server;
        this.log.info(`Bridge listening on http://127.0.0.1:${this.port}`);
        resolve(this.port);
      });
    });
  }

  /** Stop the bridge server. */
  stop(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
      this.log.info("Bridge stopped");
    }
  }

  /** Get the full bridge URL. */
  getUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.port}`);
    const path = url.pathname;
    const method = req.method ?? "GET";

    // --- GET routes ---
    if (method === "GET") {
      if (path === "/agents") {
        this.handleListAgents(res);
        return;
      }

      const conversationsMatch = path.match(/^\/conversations\/([^/]+)$/);
      if (conversationsMatch) {
        this.handleListConversations(res, conversationsMatch[1]);
        return;
      }

      if (path === "/subagents") {
        const parent = url.searchParams.get("parent") ?? undefined;
        this.handleListSubagents(res, parent);
        return;
      }

      const subagentMatch = path.match(/^\/subagents\/([^/]+)$/);
      if (subagentMatch) {
        this.handleGetSubagent(res, subagentMatch[1]);
        return;
      }

      const memoryGetMatch = path.match(/^\/memory\/([^/]+)$/);
      if (memoryGetMatch) {
        this.handleGetMemory(res, memoryGetMatch[1]);
        return;
      }

      if (path === "/admin/status") {
        this.handleAdminStatus(res);
        return;
      }

      this.sendJson(res, 404, { error: "Not found" });
      return;
    }

    // --- PUT routes ---
    if (method === "PUT") {
      const memoryPutMatch = path.match(/^\/memory\/([^/]+)$/);
      if (memoryPutMatch) {
        this.readBody(req, res, (body) => this.handlePutMemory(res, memoryPutMatch[1], body));
        return;
      }

      if (path === "/admin/env") {
        this.readBody(req, res, (body) => this.handleAdminSetEnv(res, body));
        return;
      }

      this.sendJson(res, 404, { error: "Not found" });
      return;
    }

    // --- POST routes ---
    if (method === "POST") {
      if (path === "/subagents/spawn") {
        this.readBody(req, res, (body) => this.handleSpawnSubagent(res, body));
        return;
      }

      if (path === "/admin/agents") {
        this.readBody(req, res, (body) => this.handleAdminAddAgent(res, body));
        return;
      }

      if (path === "/admin/reload") {
        req.resume(); // drain body — endpoint has no parameters
        this.handleAdminReload(res);
        return;
      }

      this.sendJson(res, 404, { error: "Not found" });
      return;
    }

    // --- PATCH routes ---
    if (method === "PATCH") {
      const adminAgentMatch = path.match(/^\/admin\/agents\/([^/]+)$/);
      if (adminAgentMatch) {
        this.readBody(req, res, (body) => this.handleAdminUpdateAgent(res, adminAgentMatch[1], body));
        return;
      }

      this.sendJson(res, 404, { error: "Not found" });
      return;
    }

    // --- DELETE routes ---
    if (method === "DELETE") {
      const subagentMatch = path.match(/^\/subagents\/([^/]+)$/);
      if (subagentMatch) {
        this.handleKillSubagent(res, subagentMatch[1]);
        return;
      }

      this.sendJson(res, 404, { error: "Not found" });
      return;
    }

    this.sendJson(res, 405, { error: "Method not allowed" });
  }

  private handleListAgents(res: ServerResponse): void {
    const agentNames = this.agentManager.getAgentNames();

    const agents = agentNames.map((name) => {
      const conversations = this.agentManager.getConversationsForAgent(name);
      return {
        name,
        activeConversations: conversations.length,
        conversations: conversations.map((c) => ({
          chatId: c.chatId,
          state: c.state,
          sessionId: c.sessionId,
        })),
      };
    });

    this.sendJson(res, 200, { agents });
  }

  private handleListConversations(res: ServerResponse, agentName: string): void {
    const agentNames = this.agentManager.getAgentNames();
    if (!agentNames.includes(agentName)) {
      this.sendJson(res, 404, { error: `Agent "${agentName}" not found` });
      return;
    }

    const conversations = this.agentManager.getConversationsForAgent(agentName);
    this.sendJson(res, 200, {
      agent: agentName,
      conversations: conversations.map((c) => ({
        chatId: c.chatId,
        state: c.state,
        sessionId: c.sessionId,
      })),
    });
  }

  // --- Subagent endpoints ---

  private handleListSubagents(res: ServerResponse, parent?: string): void {
    const subagents = this.agentManager.listSubagents(parent);
    this.sendJson(res, 200, { subagents });
  }

  private handleGetSubagent(res: ServerResponse, id: string): void {
    const info = this.agentManager.getSubagent(id);
    if (!info) {
      this.sendJson(res, 404, { error: `Subagent "${id}" not found` });
      return;
    }
    this.sendJson(res, 200, info);
  }

  private handleSpawnSubagent(res: ServerResponse, body: unknown): void {
    const req = body as Record<string, unknown>;

    if (!req || typeof req.task !== "string" || !req.task) {
      this.sendJson(res, 400, { error: "Missing required field: task" });
      return;
    }

    if (!req.template && !req.system_prompt) {
      this.sendJson(res, 400, { error: "Either 'template' or 'system_prompt' must be provided" });
      return;
    }

    if (!req.parent_agent_name || !req.parent_chat_id) {
      this.sendJson(res, 400, { error: "Missing required fields: parent_agent_name, parent_chat_id" });
      return;
    }

    this.agentManager
      .spawnSubagent({
        parentAgentName: req.parent_agent_name as string,
        parentChatId: req.parent_chat_id as string,
        task: req.task as string,
        template: req.template as string | undefined,
        systemPrompt: req.system_prompt as string | undefined,
        workingDirectory: req.working_directory as string | undefined,
        model: req.model as string | undefined,
        maxTurns: typeof req.max_turns === "number" ? req.max_turns : undefined,
        timeoutMs: typeof req.timeout_ms === "number" ? req.timeout_ms : undefined,
        allowedTools: Array.isArray(req.allowed_tools) ? req.allowed_tools : undefined,
        disallowedTools: Array.isArray(req.disallowed_tools) ? req.disallowed_tools : undefined,
      })
      .then((info) => this.sendJson(res, 201, info))
      .catch((err: Error) => {
        this.log.error(`Subagent spawn failed: ${err.message}`);
        this.sendJson(res, 500, { error: err.message });
      });
  }

  private handleKillSubagent(res: ServerResponse, id: string): void {
    const killed = this.agentManager.killSubagent(id);
    if (!killed) {
      const info = this.agentManager.getSubagent(id);
      if (!info) {
        this.sendJson(res, 404, { error: `Subagent "${id}" not found` });
      } else {
        this.sendJson(res, 409, { error: `Subagent "${id}" is not running (state: ${info.state})` });
      }
      return;
    }
    this.sendJson(res, 200, { killed: true });
  }

  // --- Memory endpoints ---

  private async handleGetMemory(res: ServerResponse, agentName: string): Promise<void> {
    const agentNames = this.agentManager.getAgentNames();
    if (!agentNames.includes(agentName)) {
      this.sendJson(res, 404, { error: `Agent "${agentName}" not found` });
      return;
    }

    const memoryPath = join(this.agentManager.getAgentDir(agentName), "MEMORY.md");
    try {
      const content = await readFile(memoryPath, "utf-8");
      this.sendJson(res, 200, { content });
    } catch {
      this.sendJson(res, 200, { content: null });
    }
  }

  private async handlePutMemory(res: ServerResponse, agentName: string, body: unknown): Promise<void> {
    const agentNames = this.agentManager.getAgentNames();
    if (!agentNames.includes(agentName)) {
      this.sendJson(res, 404, { error: `Agent "${agentName}" not found` });
      return;
    }

    const req = body as Record<string, unknown>;
    if (!req || typeof req.content !== "string") {
      this.sendJson(res, 400, { error: "Missing required field: content (string)" });
      return;
    }

    const memoryPath = join(this.agentManager.getAgentDir(agentName), "MEMORY.md");
    try {
      await mkdir(dirname(memoryPath), { recursive: true });
      await atomicWriteFile(memoryPath, req.content as string);
      this.sendJson(res, 200, { ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error(`Failed to write memory for ${agentName}: ${message}`);
      this.sendJson(res, 500, { error: `Failed to write memory: ${message}` });
    }
  }

  // --- Admin endpoints ---

  private static readonly AGENT_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
  private static readonly BOT_TOKEN_PATTERN = /^\d+:.+$/;
  private static readonly ENV_KEY_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

  private handleAdminStatus(res: ServerResponse): void {
    this.sendJson(res, 200, this.agentManager.getSystemStatus());
  }

  private async handleAdminAddAgent(res: ServerResponse, body: unknown): Promise<void> {
    const req = body as Record<string, unknown>;

    const agentName = req?.agent_name;
    const botToken = req?.bot_token;
    const model = (req?.model as string | undefined) ?? "sonnet";
    const location = (req?.location as string | undefined) ?? "global/agents";

    if (typeof agentName !== "string" || !Bridge.AGENT_NAME_PATTERN.test(agentName)) {
      this.sendJson(res, 400, { error: "Invalid agent_name. Must start with a letter/number and contain only letters, numbers, hyphens, underscores." });
      return;
    }

    if (typeof botToken !== "string" || !Bridge.BOT_TOKEN_PATTERN.test(botToken)) {
      this.sendJson(res, 400, { error: "Invalid bot_token. Expected Telegram bot token format (e.g., 123456:ABC...)." });
      return;
    }

    if (this.agentManager.getAgentNames().includes(agentName)) {
      this.sendJson(res, 409, { error: `Agent "${agentName}" already exists.` });
      return;
    }

    const paths = flowclawPaths(this.flowclawHome);
    const agentDir = join(paths.workspaces, location, agentName);

    // Guard against path traversal (e.g., location: "../../..")
    if (!agentDir.startsWith(paths.workspaces)) {
      this.sendJson(res, 400, { error: "Invalid location — must stay within workspaces directory." });
      return;
    }

    try {
      await scaffoldAgent({ agentDir, agentName, botToken, model });
      const agent = await discoverSingleAgent(agentDir);
      await this.agentManager.registerAgent(agent);
      this.sendJson(res, 201, { ok: true, agent_name: agentName, agent_dir: agentDir });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error(`Admin add agent failed: ${message}`);
      this.sendJson(res, 500, { error: message });
    }
  }

  private async handleAdminUpdateAgent(res: ServerResponse, agentName: string, body: unknown): Promise<void> {
    const template = this.agentManager.getTemplate(agentName);
    if (!template) {
      this.sendJson(res, 404, { error: `Agent "${agentName}" not found.` });
      return;
    }

    const patch = body as Record<string, unknown>;
    if (!patch || typeof patch !== "object") {
      this.sendJson(res, 400, { error: "Request body must be a JSON object." });
      return;
    }

    try {
      // Read existing agent.json, merge patch, write back
      const agentDir = this.agentManager.getAgentDir(agentName);
      const configPath = join(agentDir, "agent.json");
      const existing = JSON.parse(await readFile(configPath, "utf-8")) as Record<string, unknown>;

      // Only allow safe fields to be patched
      const allowedFields = ["model", "enabled", "admin"] as const;
      for (const field of allowedFields) {
        if (field in patch) {
          existing[field] = patch[field];
        }
      }

      await atomicWriteFile(configPath, JSON.stringify(existing, null, 2) + "\n");

      // Reload and update the template
      const agent = await discoverSingleAgent(agentDir);
      await this.agentManager.updateAgentConfig(agentName, agent.config);

      this.sendJson(res, 200, { ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error(`Admin update agent failed: ${message}`);
      this.sendJson(res, 500, { error: message });
    }
  }

  private async handleAdminReload(res: ServerResponse): Promise<void> {
    try {
      const agents = await discoverAgents(this.flowclawHome);
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

      this.sendJson(res, 200, { ok: true, agents_added: added, agents_updated: updated });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error(`Admin reload failed: ${message}`);
      this.sendJson(res, 500, { error: message });
    }
  }

  private async handleAdminSetEnv(res: ServerResponse, body: unknown): Promise<void> {
    const req = body as Record<string, unknown>;
    const key = req?.key;
    const value = req?.value;

    if (typeof key !== "string" || !Bridge.ENV_KEY_PATTERN.test(key)) {
      this.sendJson(res, 400, { error: "Invalid key. Must be uppercase letters, digits, and underscores (e.g., BOT_TOKEN)." });
      return;
    }

    if (typeof value !== "string") {
      this.sendJson(res, 400, { error: "Missing required field: value (string)." });
      return;
    }

    try {
      const envPath = flowclawPaths(this.flowclawHome).env;

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
            // File ended with \n, split produced empty last element — insert before it
            lines.splice(lines.length - 1, 0, newLine);
          } else {
            lines.push(newLine);
          }
        }

        await atomicWriteFile(envPath, lines.join("\n"));
      }

      // Set in current process for immediate effect
      process.env[key] = value;

      this.sendJson(res, 200, { ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error(`Admin set env failed: ${message}`);
      this.sendJson(res, 500, { error: message });
    }
  }

  // --- Helpers ---

  /** Max request body size (1 MB). Defense against runaway requests. */
  private static readonly MAX_BODY_SIZE = 1_048_576;

  /**
   * Read and parse a JSON request body.
   * Sends 400 on parse failure and 413 if body exceeds size limit —
   * the caller's callback is only invoked on successful parse.
   * Handles both sync and async callbacks safely (catches rejected promises).
   */
  private readBody(req: IncomingMessage, res: ServerResponse, callback: (body: unknown) => void | Promise<void>): void {
    const chunks: Buffer[] = [];
    let totalSize = 0;

    req.on("data", (chunk: Buffer) => {
      totalSize += chunk.length;
      if (totalSize > Bridge.MAX_BODY_SIZE) {
        req.destroy();
        this.sendJson(res, 413, { error: "Request body too large" });
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
        Promise.resolve(callback(body)).catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          this.log.error(`Unhandled error in request handler: ${message}`);
          if (!res.headersSent) this.sendJson(res, 500, { error: message });
        });
      } catch {
        this.sendJson(res, 400, { error: "Invalid JSON in request body" });
      }
    });
  }

  private sendJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  }
}
