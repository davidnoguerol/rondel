import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, dirname } from "node:path";
import { atomicWriteFile } from "../shared/atomic-file.js";
import { AdminApi } from "./admin-api.js";
import { SendMessageSchema, validateBody } from "./schemas.js";
import { queryLedger, type LedgerQueryOptions } from "../ledger/index.js";
import { appendToInbox, removeFromInbox } from "../messaging/inbox.js";
import { rondelPaths } from "../config/config.js";
import type { AgentManager } from "../agents/agent-manager.js";
import type { Router } from "../routing/router.js";
import type { RondelHooks } from "../shared/hooks.js";
import type { InterAgentMessage } from "../shared/types/index.js";
import type { Logger } from "../shared/logger.js";

/**
 * Internal HTTP bridge between MCP server processes and Rondel core.
 *
 * Listens on 127.0.0.1 with a random available port.
 * MCP server processes receive the bridge URL via RONDEL_BRIDGE_URL env var
 * and call it to query Rondel state.
 *
 * Localhost-only, no auth — same-machine, same-user process communication.
 *
 * Read-only endpoints live here. Admin mutation endpoints are delegated
 * to AdminApi, which returns { status, data } for the bridge to send.
 */
export class Bridge {
  private server: Server | null = null;
  private port: number = 0;
  private readonly log: Logger;
  private readonly admin: AdminApi;

  constructor(
    private readonly agentManager: AgentManager,
    log: Logger,
    private readonly rondelHome: string = "",
    private readonly hooks?: RondelHooks,
    private readonly router?: Router,
  ) {
    this.log = log.child("bridge");
    this.admin = new AdminApi(agentManager, rondelHome, log);
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

      if (path === "/orgs") {
        this.handleListOrgs(res);
        return;
      }

      const orgMatch = path.match(/^\/orgs\/([^/]+)$/);
      if (orgMatch) {
        this.handleGetOrgDetails(res, orgMatch[1]);
        return;
      }

      if (path === "/admin/status") {
        this.delegateAdmin(res, () => this.admin.systemStatus());
        return;
      }

      const transcriptMatch = path.match(/^\/transcripts\/([^/]+)\/recent$/);
      if (transcriptMatch) {
        const lastN = parseInt(url.searchParams.get("last_n") ?? "10", 10);
        this.handleRecentTranscript(res, transcriptMatch[1], lastN);
        return;
      }

      // --- Conversation ledger ---
      if (path === "/ledger/query") {
        this.handleLedgerQuery(res, url.searchParams);
        return;
      }

      // --- Inter-agent messaging ---
      if (path === "/messages/teammates") {
        const fromAgent = url.searchParams.get("from");
        if (!fromAgent) {
          this.sendJson(res, 400, { error: "Missing 'from' query parameter" });
          return;
        }
        this.handleListTeammates(res, fromAgent);
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
        this.readBody(req, res, (body) => this.delegateAdmin(res, () => this.admin.setEnv(body)));
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

      // --- Inter-agent messaging ---
      if (path === "/messages/send") {
        this.readBody(req, res, (body) => this.handleSendMessage(res, body));
        return;
      }

      if (path === "/admin/agents") {
        this.readBody(req, res, (body) => this.delegateAdmin(res, () => this.admin.addAgent(body)));
        return;
      }

      if (path === "/admin/orgs") {
        this.readBody(req, res, (body) => this.delegateAdmin(res, () => this.admin.addOrg(body)));
        return;
      }

      if (path === "/admin/reload") {
        req.resume(); // drain body — endpoint has no parameters
        this.delegateAdmin(res, () => this.admin.reload());
        return;
      }

      this.sendJson(res, 404, { error: "Not found" });
      return;
    }

    // --- PATCH routes ---
    if (method === "PATCH") {
      const adminAgentMatch = path.match(/^\/admin\/agents\/([^/]+)$/);
      if (adminAgentMatch) {
        this.readBody(req, res, (body) => this.delegateAdmin(res, () => this.admin.updateAgent(adminAgentMatch[1], body)));
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

      const adminDeleteMatch = path.match(/^\/admin\/agents\/([^/]+)$/);
      if (adminDeleteMatch) {
        this.delegateAdmin(res, () => this.admin.deleteAgent(adminDeleteMatch[1]));
        return;
      }

      this.sendJson(res, 404, { error: "Not found" });
      return;
    }

    this.sendJson(res, 405, { error: "Method not allowed" });
  }

  // ---------------------------------------------------------------------------
  // Read-only endpoints
  // ---------------------------------------------------------------------------

  private handleListAgents(res: ServerResponse): void {
    const agentNames = this.agentManager.getAgentNames();

    const agents = agentNames.map((name) => {
      const conversations = this.agentManager.getConversationsForAgent(name);
      const org = this.agentManager.getAgentOrg(name);
      return {
        name,
        org: org?.orgName,
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

  private handleListOrgs(res: ServerResponse): void {
    const orgs = this.agentManager.getOrgs().map((o) => ({
      name: o.orgName,
      displayName: o.config.displayName,
      dir: o.orgDir,
    }));
    this.sendJson(res, 200, { orgs });
  }

  private handleGetOrgDetails(res: ServerResponse, orgName: string): void {
    const org = this.agentManager.getOrgByName(orgName);
    if (!org) {
      this.sendJson(res, 404, { error: `Organization "${orgName}" not found` });
      return;
    }

    // Find all agents belonging to this org
    const allAgentNames = this.agentManager.getAgentNames();
    const orgAgents = allAgentNames
      .filter((name) => this.agentManager.getAgentOrg(name)?.orgName === orgName)
      .map((name) => {
        const template = this.agentManager.getTemplate(name);
        const conversations = this.agentManager.getConversationsForAgent(name);
        return {
          name,
          model: template?.config.model,
          admin: template?.config.admin === true,
          activeConversations: conversations.length,
        };
      });

    this.sendJson(res, 200, {
      name: org.orgName,
      displayName: org.config.displayName,
      enabled: org.config.enabled !== false,
      dir: org.orgDir,
      sharedContextDir: join(org.orgDir, "shared"),
      agentCount: orgAgents.length,
      agents: orgAgents,
    });
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

  // ---------------------------------------------------------------------------
  // Transcript endpoints
  // ---------------------------------------------------------------------------

  /**
   * Read recent user-conversation turns for an agent.
   * Finds the most recent non-agent-mail session and extracts the last N
   * user/assistant text exchanges. Used by agent-mail processes to recall
   * what their agent has been discussing with the user.
   */
  private async handleRecentTranscript(res: ServerResponse, agentName: string, lastN: number): Promise<void> {
    const agentNames = this.agentManager.getAgentNames();
    if (!agentNames.includes(agentName)) {
      this.sendJson(res, 404, { error: `Agent "${agentName}" not found` });
      return;
    }

    // Clamp lastN to reasonable range
    const n = Math.max(1, Math.min(lastN, 50));

    try {
      const stateDir = rondelPaths(this.rondelHome).state;
      const transcriptsDir = join(stateDir, "transcripts", agentName);

      // Build a set of session IDs to exclude (agent-mail, subagent, cron)
      const excludeSessionIds = new Set<string>();
      try {
        const sessionIndex = JSON.parse(await readFile(join(stateDir, "sessions.json"), "utf-8")) as Record<string, { sessionId: string; chatId: string }>;
        for (const entry of Object.values(sessionIndex)) {
          if (entry.chatId === "agent-mail") {
            excludeSessionIds.add(entry.sessionId);
          }
        }
      } catch {
        // sessions.json doesn't exist or is invalid — no exclusions
      }

      // Find session files, sorted by modification time (most recent first)
      const { readdir, stat } = await import("node:fs/promises");
      let files: string[];
      try {
        files = (await readdir(transcriptsDir)).filter((f) => f.endsWith(".jsonl"));
      } catch {
        this.sendJson(res, 200, { turns: [], message: "No transcripts found" });
        return;
      }

      // Get modification times and sort descending
      const withStats = await Promise.all(
        files.map(async (f) => {
          const s = await stat(join(transcriptsDir, f)).catch(() => null);
          return { file: f, mtime: s?.mtimeMs ?? 0 };
        }),
      );
      withStats.sort((a, b) => b.mtime - a.mtime);

      // Find the most recent user-conversation transcript
      let targetFile: string | null = null;
      for (const { file } of withStats) {
        // Skip subagent/cron transcripts by filename convention
        if (file.startsWith("sub_") || file.startsWith("cron_")) continue;
        // Skip agent-mail transcripts by session ID
        const sessionId = file.replace(".jsonl", "");
        if (excludeSessionIds.has(sessionId)) continue;
        targetFile = file;
        break;
      }

      if (!targetFile) {
        this.sendJson(res, 200, { turns: [], message: "No user conversation transcripts found" });
        return;
      }

      // Read the transcript and extract user/assistant text turns
      const content = await readFile(join(transcriptsDir, targetFile), "utf-8");
      const lines = content.split("\n").filter((l) => l.trim());

      const turns: Array<{ role: "user" | "assistant"; text: string }> = [];
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);

          if (entry.type === "user" && entry.text) {
            turns.push({ role: "user", text: entry.text });
          } else if (entry.type === "assistant" && entry.message?.content) {
            // Extract text blocks from assistant content array
            const textParts: string[] = [];
            for (const block of entry.message.content) {
              if (block.type === "text" && block.text) {
                textParts.push(block.text);
              }
            }
            if (textParts.length > 0) {
              turns.push({ role: "assistant", text: textParts.join("\n") });
            }
          }
        } catch {
          continue; // skip malformed lines
        }
      }

      // Return the last N turns
      const recent = turns.slice(-n);
      this.sendJson(res, 200, { turns: recent, session_file: targetFile, total_turns: turns.length });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error(`Failed to read transcript for ${agentName}: ${message}`);
      this.sendJson(res, 500, { error: `Failed to read transcript: ${message}` });
    }
  }


  // ---------------------------------------------------------------------------
  // Conversation ledger endpoint
  // ---------------------------------------------------------------------------

  private async handleLedgerQuery(res: ServerResponse, params: URLSearchParams): Promise<void> {
    try {
      const stateDir = rondelPaths(this.rondelHome).state;
      const options: LedgerQueryOptions = {
        agent: params.get("agent") ?? undefined,
        since: params.get("since") ?? undefined,
        kinds: params.get("kinds")?.split(",").filter(Boolean) ?? undefined,
        limit: params.has("limit") ? parseInt(params.get("limit")!, 10) : undefined,
      };
      const events = await queryLedger(stateDir, options);
      this.sendJson(res, 200, { events });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.sendJson(res, 500, { error: `Ledger query failed: ${message}` });
    }
  }

  // ---------------------------------------------------------------------------
  // Inter-agent messaging endpoints
  // ---------------------------------------------------------------------------

  private async handleSendMessage(res: ServerResponse, body: unknown): Promise<void> {
    const parsed = validateBody(SendMessageSchema, body);
    if (!parsed.success) {
      this.sendJson(res, 400, { error: parsed.error });
      return;
    }

    const { from, to, content, reply_to_chat_id } = parsed.data;

    // Self-send check
    if (from === to) {
      this.sendJson(res, 400, { error: "Cannot send a message to yourself" });
      return;
    }

    // Sender and recipient must exist
    const agentNames = this.agentManager.getAgentNames();
    if (!agentNames.includes(from)) {
      this.sendJson(res, 404, { error: `Sender agent "${from}" not found` });
      return;
    }
    if (!agentNames.includes(to)) {
      this.sendJson(res, 404, { error: `Recipient agent "${to}" not found` });
      return;
    }

    // Org isolation check
    const blocked = this.checkOrgIsolation(from, to);
    if (blocked) {
      this.sendJson(res, 403, { error: blocked });
      return;
    }

    // Build message envelope
    const messageId = randomUUID();
    const message: InterAgentMessage = {
      id: messageId,
      from,
      to,
      replyToChatId: reply_to_chat_id,
      content,
      sentAt: new Date().toISOString(),
    };

    // Emit hook (for logging/observability)
    this.hooks?.emit("message:sent", { message });

    // Persist to inbox BEFORE delivery (source of truth for durability)
    const stateDir = rondelPaths(this.rondelHome).state;
    try {
      await appendToInbox(stateDir, message);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.log.error(`Failed to persist message to inbox: ${errMsg}`);
      this.sendJson(res, 500, { error: "Failed to persist message" });
      return;
    }

    // Wrap content in delivery format and push-deliver
    const wrappedContent =
      `[Message from ${from} — ${messageId}]\n\n` +
      `${content}\n\n` +
      `[End of message. Respond naturally — your response will be delivered back to them.]`;

    if (!this.router) {
      this.sendJson(res, 500, { error: "Router not available — inter-agent messaging not configured" });
      return;
    }

    this.router.deliverAgentMail(to, wrappedContent, {
      senderAgent: from,
      senderChatId: reply_to_chat_id,
      messageId,
    });

    // Remove from inbox after successful delivery injection
    removeFromInbox(stateDir, to, messageId).catch((err) => {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.log.warn(`Failed to remove delivered message from inbox: ${errMsg}`);
    });

    this.hooks?.emit("message:delivered", { message });

    this.sendJson(res, 200, { ok: true, message_id: messageId });
  }

  private handleListTeammates(res: ServerResponse, fromAgent: string): void {
    const agentNames = this.agentManager.getAgentNames();
    if (!agentNames.includes(fromAgent)) {
      this.sendJson(res, 404, { error: `Agent "${fromAgent}" not found` });
      return;
    }

    const teammates = agentNames
      .filter((name) => name !== fromAgent && !this.checkOrgIsolation(fromAgent, name))
      .map((name) => ({
        name,
        org: this.agentManager.getAgentOrg(name)?.orgName,
      }));

    this.sendJson(res, 200, { teammates });
  }

  /**
   * Check org isolation rules. Returns null if allowed, error string if blocked.
   *
   * Rules:
   * 1. Global agent (no org) can message any agent
   * 2. Anyone can message a global agent
   * 3. Same-org is allowed; cross-org is blocked
   */
  private checkOrgIsolation(from: string, to: string): string | null {
    const fromOrg = this.agentManager.getAgentOrg(from);
    const toOrg = this.agentManager.getAgentOrg(to);

    // Global agents (no org) are unrestricted
    if (!fromOrg || !toOrg) return null;

    // Same org is allowed
    if (fromOrg.orgName === toOrg.orgName) return null;

    return `Cross-org messaging blocked: ${fromOrg.orgName} → ${toOrg.orgName}`;
  }

  // ---------------------------------------------------------------------------
  // Admin delegation
  // ---------------------------------------------------------------------------

  /**
   * Delegate to an AdminApi method and write the result as HTTP response.
   * Handles both sync and async admin methods.
   */
  private async delegateAdmin(res: ServerResponse, fn: () => { status: number; data: unknown } | Promise<{ status: number; data: unknown }>): Promise<void> {
    try {
      const result = await fn();
      this.sendJson(res, result.status, result.data);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error(`Admin endpoint error: ${message}`);
      if (!res.headersSent) this.sendJson(res, 500, { error: message });
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

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
