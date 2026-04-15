import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { atomicWriteFile } from "../shared/atomic-file.js";
import { AdminApi } from "./admin-api.js";
import {
  SendMessageSchema,
  WebSendRequestSchema,
  validateBody,
  BRIDGE_API_VERSION,
  WorkflowStartRequestSchema,
  StepCompleteRequestSchema,
  ResolveGateRequestSchema,
  ListWorkflowsQuerySchema,
} from "./schemas.js";
import { checkOrgIsolation, type OrgResolution } from "./org-isolation.js";
import { queryLedger, type LedgerQueryOptions } from "../ledger/index.js";
import { appendToInbox, removeFromInbox } from "../messaging/inbox.js";
import { rondelPaths } from "../config/config.js";
import { handleSseRequest, ConversationStreamSource } from "../streams/index.js";
import type { LedgerStreamSource, AgentStateStreamSource } from "../streams/index.js";
import type { LedgerEvent } from "../ledger/index.js";
import { resolveTranscriptPath, loadTranscriptTurns } from "../shared/transcript.js";
import { WebChannelAdapter } from "../channels/web/index.js";
import type { AgentManager } from "../agents/agent-manager.js";
import type { Router } from "../routing/router.js";
import type { RondelHooks } from "../shared/hooks.js";
import type { InterAgentMessage } from "../shared/types/index.js";
import type { Logger } from "../shared/logger.js";
import type { WorkflowManager } from "../workflows/index.js";
import {
  GateResolutionError,
  WorkflowStartError,
} from "../workflows/index.js";
import { readRunState, listRunIds, listGateRecords } from "../workflows/index.js";

// Read rondelVersion from the daemon package.json at module load. createRequire
// works in ESM without needing import assertions or JSON plugins, and the
// `version` value flows through GET /version for the web client's handshake.
const pkg = createRequire(import.meta.url)("../../package.json") as { version: string };
const RONDEL_VERSION: string = pkg.version;

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
    private readonly ledgerStream?: LedgerStreamSource,
    private readonly agentStateStream?: AgentStateStreamSource,
    private readonly workflowManager?: WorkflowManager,
    /**
     * Resolve a workflow id to its discovery scope.
     *   - `undefined` — no such workflow
     *   - `null`      — global workflow (under workspaces/global/workflows/)
     *   - `string`    — org-scoped workflow (org name)
     *
     * Used by handleStartWorkflow to enforce cross-org isolation, mirroring
     * the inter-agent messaging check.
     */
    private readonly resolveWorkflowScope?: (id: string) => string | null | undefined,
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
      // Version handshake — checked first, cheapest endpoint.
      // Clients call this on boot to detect daemon/client version skew.
      if (path === "/version") {
        this.sendJson(res, 200, {
          apiVersion: BRIDGE_API_VERSION,
          rondelVersion: RONDEL_VERSION,
        });
        return;
      }

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

      // --- Live ledger tail (SSE) ---
      // /ledger/tail            → all agents, no filter
      // /ledger/tail/:agent     → one agent, server-side filter
      // Optional ?since=<ISO8601> backfills events newer than the cursor
      // before the live stream attaches, so the client never observes a
      // gap between its last historical fetch and the first live frame.
      if (path === "/ledger/tail") {
        this.handleLedgerTail(req, res, undefined, url.searchParams);
        return;
      }
      const ledgerTailMatch = path.match(/^\/ledger\/tail\/([^/]+)$/);
      if (ledgerTailMatch) {
        this.handleLedgerTail(req, res, ledgerTailMatch[1], url.searchParams);
        return;
      }

      // --- Live agent state (SSE) ---
      // Snapshot frame on connect, then one delta per state transition.
      if (path === "/agents/state/tail") {
        this.handleAgentStateTail(req, res);
        return;
      }

      // --- Per-conversation history + live tail (web chat) ---
      // /conversations/{agent}/{channelType}/{chatId}/history
      //    → historical turns parsed from the transcript file
      // /conversations/{agent}/{channelType}/{chatId}/tail   (SSE)
      //    → live stream of user/agent/typing/session events for this chat
      const convHistoryMatch = path.match(/^\/conversations\/([^/]+)\/([^/]+)\/([^/]+)\/history$/);
      if (convHistoryMatch) {
        this.handleConversationHistory(res, convHistoryMatch[1], convHistoryMatch[2], convHistoryMatch[3]);
        return;
      }
      const convTailMatch = path.match(/^\/conversations\/([^/]+)\/([^/]+)\/([^/]+)\/tail$/);
      if (convTailMatch) {
        this.handleConversationTail(req, res, convTailMatch[1], convTailMatch[2], convTailMatch[3]);
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

      // --- Workflows (Layer 4 v0) ---
      if (path === "/workflows") {
        this.handleListWorkflows(res, url.searchParams);
        return;
      }
      const workflowGetMatch = path.match(/^\/workflows\/(run_[^/]+)$/);
      if (workflowGetMatch) {
        this.handleGetWorkflow(res, workflowGetMatch[1]);
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

      // --- Web chat: user → agent message injection ---
      if (path === "/web/messages/send") {
        this.readBody(req, res, (body) => this.handleWebSendMessage(res, body));
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

      // --- Workflows (Layer 4 v0) ---
      if (path === "/workflows/start") {
        this.readBody(req, res, (body) => this.handleStartWorkflow(res, body));
        return;
      }
      if (path === "/workflows/step-complete") {
        this.readBody(req, res, (body) => this.handleStepComplete(res, body));
        return;
      }
      const gateResolveMatch = path.match(/^\/workflows\/gates\/(gate_[^/]+)\/resolve$/);
      if (gateResolveMatch) {
        const gateId = gateResolveMatch[1];
        this.readBody(req, res, (body) => this.handleResolveGate(res, gateId, body));
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
        parentChannelType: (req.parent_channel_type as string) || "internal",
        parentAccountId: (req.parent_account_id as string) || (req.parent_agent_name as string),
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
  // SSE endpoints
  // ---------------------------------------------------------------------------
  //
  // These delegate to the generic `handleSseRequest` from streams/. The bridge
  // is responsible only for: (a) building the per-request filter closure,
  // (b) building the per-request replay closure (for `?since=` backfill), and
  // (c) returning a clean error if the corresponding stream source isn't wired.

  private handleLedgerTail(
    req: IncomingMessage,
    res: ServerResponse,
    agentName: string | undefined,
    params: URLSearchParams,
  ): void {
    if (!this.ledgerStream) {
      this.sendJson(res, 503, { error: "Ledger stream is not available" });
      return;
    }

    // Per-agent filter applied at the SSE handler boundary, so the shared
    // upstream subscription stays single — N clients fan out from one
    // listener on LedgerWriter.
    const filter = agentName
      ? (event: LedgerEvent) => event.agent === agentName
      : undefined;

    // Optional ?since=<ISO8601> backfill — replays events newer than the
    // cursor before the live stream attaches. The web client passes this
    // automatically using the timestamp of the newest historical event
    // it already has from its server-side fetch, so the visible timeline
    // never has a gap.
    const since = params.get("since") ?? undefined;
    const stateDir = rondelPaths(this.rondelHome).state;
    const replay = since
      ? async (send: (frame: { event: string; data: LedgerEvent }) => void) => {
          // queryLedger returns newest-first; we replay oldest-first so the
          // live timeline reads in chronological order.
          const events = await queryLedger(stateDir, {
            agent: agentName,
            since,
          });
          for (const event of [...events].reverse()) {
            send({ event: "ledger.appended", data: event });
          }
        }
      : undefined;

    handleSseRequest(req, res, this.ledgerStream, { filter, replay });
  }

  private handleAgentStateTail(req: IncomingMessage, res: ServerResponse): void {
    if (!this.agentStateStream) {
      this.sendJson(res, 503, { error: "Agent-state stream is not available" });
      return;
    }
    handleSseRequest(req, res, this.agentStateStream);
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
    const blocked = this.isBlockedByOrg(from, to);
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

    // Resolve sender's channel type for routing replies back
    const senderPrimary = this.agentManager.getPrimaryChannel(from);
    if (!senderPrimary) {
      this.log.error(`Cannot resolve channel for sender "${from}" — agent-mail reply will be lost`);
      this.sendJson(res, 500, { error: `No channel binding for sender "${from}"` });
      return;
    }
    const senderChannelType = senderPrimary.channelType;

    this.router.deliverAgentMail(to, wrappedContent, {
      senderAgent: from,
      senderChannelType,
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
      .filter((name) => name !== fromAgent && !this.isBlockedByOrg(fromAgent, name))
      .map((name) => ({
        name,
        org: this.agentManager.getAgentOrg(name)?.orgName,
      }));

    this.sendJson(res, 200, { teammates });
  }

  /**
   * Resolve an agent name to its OrgResolution (global / org / unknown).
   * An agent is "unknown" iff it isn't registered as a template.
   */
  private resolveAgentOrg(name: string): OrgResolution {
    if (!this.agentManager.getTemplate(name)) return { status: "unknown" };
    const org = this.agentManager.getAgentOrg(name);
    return org ? { status: "org", orgName: org.orgName } : { status: "global" };
  }

  /**
   * Check org isolation rules for an inter-agent message.
   * Delegates to the pure `checkOrgIsolation` function in ./org-isolation.ts.
   * Method is named `isBlockedByOrg` to avoid shadowing the imported function
   * inside this class body (footgun: `this.checkOrgIsolation(...)` vs
   * `checkOrgIsolation(...)` is subtle and easy to miswrite during a refactor).
   */
  private isBlockedByOrg(from: string, to: string): string | null {
    return checkOrgIsolation((name) => this.resolveAgentOrg(name), from, to);
  }

  // ---------------------------------------------------------------------------
  // Web chat endpoints
  // ---------------------------------------------------------------------------

  /**
   * POST /web/messages/send — inject a user message into a web conversation.
   *
   * Normalizes the HTTP body to a `ChannelMessage` via the WebChannelAdapter
   * and dispatches it through the shared `ChannelRegistry` handler pipeline.
   * From there, Router.handleInboundMessage treats it exactly like a Telegram
   * message: spawn-or-reuse the per-conversation process, queue if busy,
   * start typing indicator, send to Claude.
   *
   * The response text streams back to the client over the conversation tail
   * SSE endpoint, not this HTTP call.
   */
  private handleWebSendMessage(res: ServerResponse, body: unknown): void {
    const parsed = validateBody(WebSendRequestSchema, body);
    if (!parsed.success) {
      this.sendJson(res, 400, { error: parsed.error });
      return;
    }

    const { agent_name: agentName, chat_id: chatId, text } = parsed.data;

    if (!this.agentManager.getAgentNames().includes(agentName)) {
      this.sendJson(res, 404, { error: `Agent "${agentName}" not found` });
      return;
    }

    const webAdapter = this.resolveWebAdapter();
    if (!webAdapter) {
      this.sendJson(res, 503, { error: "Web channel is not available" });
      return;
    }

    // Pre-check the synthetic web account is registered for this agent.
    // If registration failed at startup (e.g. duplicate account), we'd
    // otherwise silently drop the message into Router's "no agent for
    // channel" warn path and the user would see nothing. Surface a
    // concrete 503 so the UI can render a diagnostic.
    if (this.agentManager.resolveAgentByChannel("web", agentName) !== agentName) {
      this.sendJson(res, 503, {
        error: `Agent "${agentName}" has no active web channel account — check daemon logs`,
      });
      return;
    }

    webAdapter.ingestUserMessage({
      accountId: agentName,
      chatId,
      text,
      senderId: "web-user",
      senderName: "Web",
    });

    this.sendJson(res, 200, { ok: true });
  }

  /**
   * Resolve the in-process web adapter via the channel registry. Kept local to
   * the bridge so AgentManager doesn't leak a concrete channel class through
   * its public API (CLAUDE.md: channel adapters own their own quirks).
   */
  private resolveWebAdapter(): WebChannelAdapter | undefined {
    const registry = this.agentManager.getChannelRegistry();
    const adapter = registry.get("web");
    return adapter instanceof WebChannelAdapter ? adapter : undefined;
  }

  /**
   * Validate a channelType against the set of adapters the daemon currently
   * knows about. Used by conversation history/tail endpoints to reject typos
   * in the URL (`/conversations/alice/telgrm/...`) with a clear 400 instead
   * of silently returning an empty view.
   */
  private isKnownChannelType(channelType: string): boolean {
    // `internal` is the synthetic channel used for agent-mail conversations.
    // It isn't registered in the channel registry but is a valid target for
    // history/tail lookups on agent-mail chats.
    if (channelType === "internal") return true;
    return this.agentManager.getChannelRegistry().get(channelType) !== undefined;
  }

  /**
   * GET /conversations/{agent}/{channelType}/{chatId}/history
   *
   * Returns the ordered user/assistant turns for a conversation, parsed from
   * the Claude CLI transcript file. Used by the web UI to rehydrate a chat
   * view on reload (and to mirror the recent history of a Telegram chat when
   * the user opens it in read-only mode).
   */
  private async handleConversationHistory(
    res: ServerResponse,
    agentName: string,
    channelType: string,
    chatId: string,
  ): Promise<void> {
    if (!this.agentManager.getAgentNames().includes(agentName)) {
      this.sendJson(res, 404, { error: `Agent "${agentName}" not found` });
      return;
    }
    if (!this.isKnownChannelType(channelType)) {
      this.sendJson(res, 400, { error: `Unknown channel type "${channelType}"` });
      return;
    }

    const entry = this.agentManager.conversations.getSessionEntry(agentName, channelType, chatId);
    if (!entry) {
      this.sendJson(res, 200, { turns: [], sessionId: null });
      return;
    }

    try {
      const transcriptPath = resolveTranscriptPath(
        this.agentManager.conversations.getTranscriptsDir(),
        agentName,
        entry.sessionId,
      );
      const turns = await loadTranscriptTurns(transcriptPath);
      // Cap at a reasonable ceiling — a long conversation becomes hundreds of
      // turns quickly and the web UI only needs the recent context to
      // rehydrate. 200 is generous for MVP; we'll tune if needed.
      const trimmed = turns.slice(-200);
      this.sendJson(res, 200, { turns: trimmed, sessionId: entry.sessionId });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error(`Failed to load transcript for ${agentName}:${channelType}:${chatId}: ${message}`);
      this.sendJson(res, 500, { error: `Failed to load transcript: ${message}` });
    }
  }

  /**
   * GET /conversations/{agent}/{channelType}/{chatId}/tail  (SSE)
   *
   * Live stream of all events for a single conversation: user messages,
   * agent responses, session lifecycle, and (web channel only) typing
   * indicators. A new `ConversationStreamSource` is constructed per request
   * and disposed when the SSE handler cleans up.
   */
  private handleConversationTail(
    req: IncomingMessage,
    res: ServerResponse,
    agentName: string,
    channelType: string,
    chatId: string,
  ): void {
    if (!this.hooks) {
      this.sendJson(res, 503, { error: "Hooks not available" });
      return;
    }
    if (!this.agentManager.getAgentNames().includes(agentName)) {
      this.sendJson(res, 404, { error: `Agent "${agentName}" not found` });
      return;
    }
    if (!this.isKnownChannelType(channelType)) {
      this.sendJson(res, 400, { error: `Unknown channel type "${channelType}"` });
      return;
    }

    const source = new ConversationStreamSource({
      agentName,
      channelType,
      chatId,
      hooks: this.hooks,
      webAdapter: this.resolveWebAdapter(),
    });

    // Dispose the per-request source when the client disconnects. We wire
    // the cleanup on both req and res so any teardown path (client close,
    // socket error, heartbeat-detected dead socket) triggers dispose.
    const disposeOnce = (): void => {
      try {
        source.dispose();
      } catch {
        // Source dispose is best-effort — nothing to recover here.
      }
    };
    req.on("close", disposeOnce);
    res.on("close", disposeOnce);
    res.on("error", disposeOnce);

    handleSseRequest(req, res, source, {
      replay: async (send) => {
        // For web conversations, replay the adapter's ring buffer so a fresh
        // tab sees the last few typing/response frames before live attaches.
        // Non-web conversations have nothing to replay here — their historical
        // context lives in the transcript and is fetched via /history.
        source.replayRingBuffer(send);
        return Promise.resolve();
      },
    });
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

  // ---------------------------------------------------------------------------
  // Workflow endpoints (Layer 4 v0)
  // ---------------------------------------------------------------------------

  /**
   * 503 if workflows are disabled at startup. Returns true if the request
   * was handled (workflow manager missing), false if the caller should
   * proceed with normal handling.
   */
  private requireWorkflowManager(res: ServerResponse): WorkflowManager | null {
    if (!this.workflowManager) {
      this.sendJson(res, 503, {
        error: "Workflow engine is disabled (config.features.workflows = false)",
      });
      return null;
    }
    return this.workflowManager;
  }

  private async handleStartWorkflow(res: ServerResponse, body: unknown): Promise<void> {
    const manager = this.requireWorkflowManager(res);
    if (!manager) return;

    const parsed = validateBody(WorkflowStartRequestSchema, body);
    if (!parsed.success) {
      this.sendJson(res, 400, { error: parsed.error });
      return;
    }

    // Org isolation: block an agent from starting a workflow that belongs
    // to a different org. Global workflows are visible to everyone; org
    // workflows are visible only to agents in the same org (and to global
    // agents, mirroring the inter-agent messaging policy).
    if (this.resolveWorkflowScope) {
      const scope = this.resolveWorkflowScope(parsed.data.workflow_id);
      if (scope === undefined) {
        this.sendJson(res, 404, {
          error: `Unknown workflow id "${parsed.data.workflow_id}"`,
          code: "unknown_workflow",
        });
        return;
      }
      if (scope !== null) {
        const originatorOrg = this.resolveAgentOrg(parsed.data.originator_agent);
        if (
          originatorOrg.status === "org" &&
          originatorOrg.orgName !== scope
        ) {
          this.sendJson(res, 403, {
            error: `Cross-org workflow start blocked: agent "${parsed.data.originator_agent}" (org=${originatorOrg.orgName}) cannot start workflow "${parsed.data.workflow_id}" (org=${scope})`,
            code: "cross_org_blocked",
          });
          return;
        }
      }
    }

    try {
      const handle = await manager.startRun(
        {
          agent: parsed.data.originator_agent,
          channelType: parsed.data.originator_channel_type,
          accountId: parsed.data.originator_account_id,
          chatId: parsed.data.originator_chat_id,
        },
        parsed.data.workflow_id,
        parsed.data.inputs,
      );
      // Don't await `completion` — the runner proceeds in the background.
      // We swallow errors with a catch so an unhandled rejection doesn't
      // crash the daemon if the runner fails much later.
      handle.completion.catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.log.error(`Workflow run ${handle.runId} crashed: ${msg}`);
      });
      this.sendJson(res, 200, {
        ok: true,
        run_id: handle.runId,
        workflow_id: parsed.data.workflow_id,
      });
    } catch (err) {
      if (err instanceof WorkflowStartError) {
        const status = err.code === "unknown_workflow" ? 404 : 400;
        this.sendJson(res, status, { error: err.message, code: err.code });
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error(`Failed to start workflow: ${msg}`);
      this.sendJson(res, 500, { error: msg });
    }
  }

  private handleStepComplete(res: ServerResponse, body: unknown): void {
    const manager = this.requireWorkflowManager(res);
    if (!manager) return;

    const parsed = validateBody(StepCompleteRequestSchema, body);
    if (!parsed.success) {
      this.sendJson(res, 400, { error: parsed.error });
      return;
    }

    manager.notifyStepComplete({
      runId: parsed.data.run_id,
      stepKey: parsed.data.step_key,
      status: parsed.data.status,
      summary: parsed.data.summary,
      artifact: parsed.data.artifact,
      failReason: parsed.data.fail_reason,
    });

    this.sendJson(res, 200, { ok: true });
  }

  private async handleResolveGate(
    res: ServerResponse,
    gateId: string,
    body: unknown,
  ): Promise<void> {
    const manager = this.requireWorkflowManager(res);
    if (!manager) return;

    const parsed = validateBody(ResolveGateRequestSchema, body);
    if (!parsed.success) {
      this.sendJson(res, 400, { error: parsed.error });
      return;
    }

    try {
      const resolved = await manager.resolveGate(parsed.data.run_id, gateId, {
        decision: parsed.data.decision,
        decidedBy: parsed.data.decided_by,
        note: parsed.data.note ?? null,
      });
      this.sendJson(res, 200, { ok: true, gate: resolved });
    } catch (err) {
      if (err instanceof GateResolutionError) {
        const status = err.code === "not_found" ? 404 : 409;
        this.sendJson(res, status, { error: err.message, code: err.code });
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error(`Failed to resolve gate ${gateId}: ${msg}`);
      this.sendJson(res, 500, { error: msg });
    }
  }

  private async handleListWorkflows(
    res: ServerResponse,
    params: URLSearchParams,
  ): Promise<void> {
    const manager = this.requireWorkflowManager(res);
    if (!manager) return;

    const parsed = ListWorkflowsQuerySchema.safeParse({
      status: params.get("status") ?? undefined,
      limit: params.get("limit") ? Number(params.get("limit")) : undefined,
    });
    if (!parsed.success) {
      this.sendJson(res, 400, { error: parsed.error.issues.map((i) => i.message).join("; ") });
      return;
    }

    const stateDir = rondelPaths(this.rondelHome).state;
    try {
      const ids = await listRunIds(stateDir);
      const runs = [];
      for (const id of ids) {
        const state = await readRunState(stateDir, id);
        if (!state) continue;
        if (parsed.data.status && parsed.data.status !== "all" && state.status !== parsed.data.status) {
          continue;
        }
        runs.push(state);
      }
      // Newest first
      runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
      const limit = parsed.data.limit ?? 50;
      this.sendJson(res, 200, { runs: runs.slice(0, limit) });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.sendJson(res, 500, { error: msg });
    }
  }

  private async handleGetWorkflow(res: ServerResponse, runId: string): Promise<void> {
    const manager = this.requireWorkflowManager(res);
    if (!manager) return;

    const stateDir = rondelPaths(this.rondelHome).state;
    try {
      const state = await readRunState(stateDir, runId);
      if (!state) {
        this.sendJson(res, 404, { error: `Run "${runId}" not found` });
        return;
      }
      const gates = await listGateRecords(stateDir, runId);
      this.sendJson(res, 200, { run: state, gates });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.sendJson(res, 500, { error: msg });
    }
  }

  private sendJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  }
}
