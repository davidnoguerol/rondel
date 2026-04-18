import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { randomUUID, randomBytes } from "node:crypto";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { atomicWriteFile } from "../shared/atomic-file.js";
import { AdminApi } from "./admin-api.js";
import {
  SendMessageSchema,
  WebSendRequestSchema,
  ScheduleSkillReloadSchema,
  ToolUseApprovalCreateSchema,
  ApprovalResolveSchema,
  ToolCallEventSchema,
  RecordReadSchema,
  BackupCreateSchema,
  AskUserCreateSchema,
  ASK_USER_DEFAULTS,
  ScheduleCreateRequestSchema,
  ScheduleUpdateRequestSchema,
  ScheduleMutationRequestSchema,
  validateBody,
  BRIDGE_API_VERSION,
} from "./schemas.js";
import type { AskUserOption } from "./schemas.js";
import type { ApprovalService } from "../approvals/index.js";
import type { ReadFileStateStore, FileHistoryStore } from "../filesystem/index.js";
import { ScheduleError, type ScheduleService, type ScheduleCaller } from "../scheduling/index.js";
import type { CreateScheduleInput, UpdateScheduleInput } from "../scheduling/index.js";
import { checkOrgIsolation, type OrgResolution } from "../shared/org-isolation.js";
import { queryLedger, type LedgerQueryOptions } from "../ledger/index.js";
import { appendToInbox, removeFromInbox } from "../messaging/inbox.js";
import { rondelPaths } from "../config/config.js";
import { handleSseRequest, ConversationStreamSource } from "../streams/index.js";
import type { LedgerStreamSource, AgentStateStreamSource, ApprovalStreamSource, ScheduleStreamSource } from "../streams/index.js";
import type { LedgerEvent } from "../ledger/index.js";
import { resolveTranscriptPath, loadTranscriptTurns } from "../shared/transcript.js";
import { WebChannelAdapter } from "../channels/web/index.js";
import type { AgentManager } from "../agents/agent-manager.js";
import type { Router } from "../routing/router.js";
import type { RondelHooks } from "../shared/hooks.js";
import type { InterAgentMessage } from "../shared/types/index.js";
import type { Logger } from "../shared/logger.js";

// Read rondelVersion from the daemon package.json at module load. createRequire
// works in ESM without needing import assertions or JSON plugins, and the
// `version` value flows through GET /version for the web client's handshake.
const pkg = createRequire(import.meta.url)("../../package.json") as { version: string };
const RONDEL_VERSION: string = pkg.version;

// ---------------------------------------------------------------------------
// Ask-user in-memory store shapes
// ---------------------------------------------------------------------------

/** Grace window after which resolved/timeout tombstones are GC'd. */
const ASK_USER_TOMBSTONE_GRACE_MS = 60 * 1000;

/** Telegram inline-keyboard labels render poorly past ~50 chars. */
const ASK_USER_BUTTON_LABEL_MAX = 50;

type AskUserEntry =
  | {
      readonly status: "pending";
      readonly options: readonly AskUserOption[];
      readonly timeoutHandle: NodeJS.Timeout;
    }
  | {
      readonly status: "resolved";
      readonly selectedIndex: number;
      readonly selectedLabel: string;
      readonly resolvedBy?: string;
      readonly tombstoneUntilMs: number;
    }
  | {
      readonly status: "timeout";
      readonly tombstoneUntilMs: number;
    };

function newAskUserRequestId(): string {
  // Matches the ^askuser_<epoch>_<hex>$ pattern the orchestrator's
  // callback router expects.
  const epoch = Math.floor(Date.now() / 1000);
  return `askuser_${epoch}_${randomBytes(4).toString("hex")}`;
}

function truncateButtonLabel(label: string): string {
  if (label.length <= ASK_USER_BUTTON_LABEL_MAX) return label;
  return label.slice(0, ASK_USER_BUTTON_LABEL_MAX - 1) + "…";
}

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

  /**
   * In-memory pending `rondel_ask_user` prompts. Keyed by requestId.
   * Each entry is either an in-flight waiter (status: "pending") or a
   * short-lived tombstone (status: "resolved" | "timeout") kept around
   * for a grace window so the polling MCP tool can observe the outcome
   * before it's garbage-collected.
   *
   * No disk persistence — if the daemon restarts mid-prompt, the MCP
   * tool's poll returns 404 and times out on the agent side. This is
   * deliberate: an ask-user flow has no meaning across restarts because
   * the human's attention (the interactive keyboard they tapped) is
   * tied to the previous process lifetime.
   */
  private readonly askUserStore = new Map<string, AskUserEntry>();

  constructor(
    private readonly agentManager: AgentManager,
    log: Logger,
    private readonly rondelHome: string = "",
    private readonly hooks?: RondelHooks,
    private readonly router?: Router,
    private readonly ledgerStream?: LedgerStreamSource,
    private readonly agentStateStream?: AgentStateStreamSource,
    private readonly approvals?: ApprovalService,
    private readonly readFileState?: ReadFileStateStore,
    private readonly fileHistory?: FileHistoryStore,
    private readonly approvalStream?: ApprovalStreamSource,
    private readonly schedules?: ScheduleService,
    private readonly scheduleStream?: ScheduleStreamSource,
  ) {
    this.log = log.child("bridge");
    this.admin = new AdminApi(agentManager, rondelHome, log, schedules);
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

      // --- Live approval tail (SSE) ---
      // Emits `approval.requested` / `approval.resolved` frames as the
      // ApprovalService fires them. The web /approvals page consumes this
      // to replace the previous 2s polling. Initial list comes from the
      // existing GET /approvals endpoint rendered by the RSC page.
      if (path === "/approvals/tail") {
        this.handleApprovalsTail(req, res);
        return;
      }

      // --- Live schedule tail (SSE) ---
      // Emits `schedule.{created,updated,deleted,ran}` frames as the
      // ScheduleService and Scheduler fire them. Initial list comes from
      // the existing GET /schedules endpoint rendered by the RSC page.
      if (path === "/schedules/tail") {
        this.handleSchedulesTail(req, res);
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

      // --- HITL approvals ---
      if (path === "/approvals") {
        this.handleListApprovals(res);
        return;
      }
      const approvalGetMatch = path.match(/^\/approvals\/([^/]+)$/);
      if (approvalGetMatch) {
        this.handleGetApproval(res, approvalGetMatch[1]);
        return;
      }

      // --- Runtime schedules (durable crons) ---
      if (path === "/schedules") {
        this.handleListSchedules(res, url.searchParams);
        return;
      }
      const scheduleGetMatch = path.match(/^\/schedules\/([^/]+)$/);
      if (scheduleGetMatch) {
        this.handleGetSchedule(res, scheduleGetMatch[1], url.searchParams);
        return;
      }

      // --- Ask-user prompts ---
      const askUserGetMatch = path.match(/^\/prompts\/ask-user\/([^/]+)$/);
      if (askUserGetMatch) {
        this.handleGetAskUser(res, askUserGetMatch[1]);
        return;
      }

      // --- Filesystem read-state + backup history (Phase 3) ---
      const readStateMatch = path.match(/^\/filesystem\/read-state\/([^/]+)$/);
      if (readStateMatch) {
        this.handleGetReadState(
          res,
          readStateMatch[1],
          url.searchParams.get("sessionId") ?? "",
          url.searchParams.get("path") ?? "",
        );
        return;
      }
      const historyRestoreMatch = path.match(/^\/filesystem\/history\/([^/]+)\/([^/]+)$/);
      if (historyRestoreMatch) {
        this.handleRestoreBackup(res, historyRestoreMatch[1], historyRestoreMatch[2]);
        return;
      }
      const historyListMatch = path.match(/^\/filesystem\/history\/([^/]+)$/);
      if (historyListMatch) {
        this.handleListBackups(
          res,
          historyListMatch[1],
          url.searchParams.get("path") ?? undefined,
        );
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

      // --- Agent self-mutation: schedule a post-turn process restart ---
      if (path === "/agent/schedule-skill-reload") {
        this.readBody(req, res, (body) => this.handleScheduleSkillReload(res, body));
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

      // --- HITL approvals ---
      if (path === "/approvals/tool-use") {
        this.readBody(req, res, (body) => this.handleCreateToolUseApproval(res, body));
        return;
      }
      const approvalResolveMatch = path.match(/^\/approvals\/([^/]+)\/resolve$/);
      if (approvalResolveMatch) {
        this.readBody(req, res, (body) => this.handleResolveApproval(res, approvalResolveMatch[1], body));
        return;
      }

      // --- Runtime schedules ---
      if (path === "/schedules") {
        this.readBody(req, res, (body) => this.handleCreateSchedule(res, body));
        return;
      }
      const scheduleRunMatch = path.match(/^\/schedules\/([^/]+)\/run$/);
      if (scheduleRunMatch) {
        this.readBody(req, res, (body) => this.handleRunSchedule(res, scheduleRunMatch[1], body));
        return;
      }

      // --- Ask-user prompts ---
      if (path === "/prompts/ask-user") {
        this.readBody(req, res, (body) => this.handleCreateAskUser(res, body));
        return;
      }

      // --- First-class tool call events (rondel_bash, Phase 3 filesystem) ---
      if (path === "/ledger/tool-call") {
        this.readBody(req, res, (body) => this.handleLedgerToolCall(res, body));
        return;
      }

      // --- Filesystem read-state recording + backup creation (Phase 3) ---
      const recordReadPostMatch = path.match(/^\/filesystem\/read-state\/([^/]+)$/);
      if (recordReadPostMatch) {
        this.readBody(req, res, (body) => this.handleRecordRead(res, recordReadPostMatch[1], body));
        return;
      }
      const backupPostMatch = path.match(/^\/filesystem\/history\/([^/]+)\/backup$/);
      if (backupPostMatch) {
        this.readBody(req, res, (body) => this.handleBackupCreate(res, backupPostMatch[1], body));
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

      const scheduleUpdateMatch = path.match(/^\/schedules\/([^/]+)$/);
      if (scheduleUpdateMatch) {
        this.readBody(req, res, (body) => this.handleUpdateSchedule(res, scheduleUpdateMatch[1], body));
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

      const scheduleDeleteMatch = path.match(/^\/schedules\/([^/]+)$/);
      if (scheduleDeleteMatch) {
        this.readBody(req, res, (body) => this.handleDeleteSchedule(res, scheduleDeleteMatch[1], body));
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

  private handleApprovalsTail(req: IncomingMessage, res: ServerResponse): void {
    if (!this.approvalStream) {
      this.sendJson(res, 503, { error: "Approval stream is not available" });
      return;
    }
    handleSseRequest(req, res, this.approvalStream);
  }

  private handleSchedulesTail(req: IncomingMessage, res: ServerResponse): void {
    if (!this.scheduleStream) {
      this.sendJson(res, 503, { error: "Schedule stream is not available" });
      return;
    }
    handleSseRequest(req, res, this.scheduleStream);
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

  /**
   * POST /agent/schedule-skill-reload — schedule a post-turn restart of the
   * calling conversation so newly-authored skills under `--add-dir` are
   * picked up by Claude CLI. The restart fires on the next idle transition
   * (see Router.consumePendingRestart), never inside the turn that called
   * this endpoint. Session context is preserved via `--resume`.
   */
  private handleScheduleSkillReload(res: ServerResponse, body: unknown): void {
    const parsed = validateBody(ScheduleSkillReloadSchema, body);
    if (!parsed.success) {
      this.sendJson(res, 400, { error: parsed.error });
      return;
    }

    const { agent_name, channel_type, chat_id } = parsed.data;

    if (!this.agentManager.getAgentNames().includes(agent_name)) {
      this.sendJson(res, 404, { error: `Agent "${agent_name}" not found` });
      return;
    }

    const scheduled = this.agentManager.conversations.scheduleRestartAfterTurn(
      agent_name,
      channel_type,
      chat_id,
    );

    if (!scheduled) {
      this.sendJson(res, 404, {
        error: `No active conversation for ${agent_name} @ ${channel_type}:${chat_id}`,
      });
      return;
    }

    this.sendJson(res, 200, { ok: true, scheduled: true });
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

  // ---------------------------------------------------------------------------
  // HITL approvals
  // ---------------------------------------------------------------------------

  /**
   * POST /approvals/tool-use — called by the PreToolUse hook script.
   *
   * The bridge creates a pending record, returns `{requestId}` IMMEDIATELY,
   * and does NOT await the decision. The hook script then polls
   * `GET /approvals/:id` until status === "resolved".
   *
   * Rejected with 503 if the approval service isn't wired up (shouldn't
   * happen in production — startup wiring constructs it unconditionally).
   */
  private handleCreateToolUseApproval(res: ServerResponse, body: unknown): void {
    if (!this.approvals) {
      this.sendJson(res, 503, { error: "Approval service not available" });
      return;
    }
    const validation = validateBody(ToolUseApprovalCreateSchema, body);
    if (!validation.success) {
      this.sendJson(res, 400, { error: validation.error });
      return;
    }
    this.approvals.requestToolUse(validation.data)
      .then(({ requestId }) => {
        this.sendJson(res, 201, { requestId });
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.log.error(`handleCreateToolUseApproval: ${msg}`);
        this.sendJson(res, 500, { error: msg });
      });
  }

  /**
   * GET /approvals/:id — called by the hook script while polling, and by
   * the web UI when a user drills into a specific record.
   */
  private handleGetApproval(res: ServerResponse, requestId: string): void {
    if (!this.approvals) {
      this.sendJson(res, 503, { error: "Approval service not available" });
      return;
    }
    this.approvals.getById(requestId)
      .then((record) => {
        if (!record) {
          this.sendJson(res, 404, { error: `Approval "${requestId}" not found` });
          return;
        }
        this.sendJson(res, 200, record);
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.sendJson(res, 500, { error: msg });
      });
  }

  /**
   * GET /approvals — list pending + recent resolved for the web UI.
   */
  private handleListApprovals(res: ServerResponse): void {
    if (!this.approvals) {
      this.sendJson(res, 503, { error: "Approval service not available" });
      return;
    }
    this.approvals.list()
      .then((lists) => this.sendJson(res, 200, lists))
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.sendJson(res, 500, { error: msg });
      });
  }

  /**
   * POST /approvals/:id/resolve — operator resolution from the web UI.
   *
   * Equivalent in effect to a Telegram button tap: the service
   * flips the record from pending to resolved, unblocks any in-process
   * resolver, and emits the hook event for the ledger.
   */
  private handleResolveApproval(res: ServerResponse, requestId: string, body: unknown): void {
    if (!this.approvals) {
      this.sendJson(res, 503, { error: "Approval service not available" });
      return;
    }
    const validation = validateBody(ApprovalResolveSchema, body);
    if (!validation.success) {
      this.sendJson(res, 400, { error: validation.error });
      return;
    }
    const resolvedBy = validation.data.resolvedBy ?? "web";
    this.approvals.resolve(requestId, validation.data.decision, resolvedBy)
      .then(() => this.sendJson(res, 200, { ok: true }))
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.sendJson(res, 500, { error: msg });
      });
  }

  // ---------------------------------------------------------------------------
  // Ask-user prompts (rondel_ask_user)
  // ---------------------------------------------------------------------------
  //
  // These endpoints are memory-only — if the daemon restarts mid-prompt the
  // polling MCP tool gets a 404 on GET and eventually times out, which is
  // the correct degradation: the human's tap on the previous Telegram
  // keyboard would have nowhere to land anyway.

  /**
   * POST /prompts/ask-user — called by the rondel_ask_user MCP tool.
   *
   * Responds 201 with `{requestId}` immediately after the interactive
   * message has been enqueued to the adapter. The tool then polls GET
   * /prompts/ask-user/:id until the operator taps a button (resolving
   * the entry) or the configured timeout fires.
   */
  private handleCreateAskUser(res: ServerResponse, body: unknown): void {
    const parsed = validateBody(AskUserCreateSchema, body);
    if (!parsed.success) {
      this.sendJson(res, 400, { error: parsed.error });
      return;
    }
    const { agentName, channelType, chatId, prompt, options, timeout_ms } = parsed.data;

    if (!this.agentManager.getAgentNames().includes(agentName)) {
      this.sendJson(res, 404, { error: `Agent "${agentName}" not found` });
      return;
    }

    const registry = this.agentManager.getChannelRegistry();
    const adapter = registry.get(channelType);
    if (!adapter) {
      this.sendJson(res, 400, { error: `Unknown channel type "${channelType}"` });
      return;
    }
    if (!adapter.supportsInteractive) {
      this.sendJson(res, 400, {
        error: `Channel "${channelType}" does not support interactive prompts`,
      });
      return;
    }

    // Resolve the accountId the agent uses on this channel. Mirrors the
    // pattern ApprovalService uses at construction time.
    const template = this.agentManager.getTemplate(agentName);
    if (!template) {
      this.sendJson(res, 500, { error: `Template for agent "${agentName}" missing` });
      return;
    }
    const binding = template.config.channels.find((c) => c.channelType === channelType);
    if (!binding) {
      this.sendJson(res, 400, {
        error: `Agent "${agentName}" has no binding for channel "${channelType}"`,
      });
      return;
    }

    const requestId = newAskUserRequestId();
    const effectiveTimeoutMs = timeout_ms ?? ASK_USER_DEFAULTS.defaultTimeoutMs;

    const timeoutHandle = setTimeout(() => {
      const entry = this.askUserStore.get(requestId);
      if (!entry || entry.status !== "pending") return;
      this.askUserStore.set(requestId, {
        status: "timeout",
        tombstoneUntilMs: Date.now() + ASK_USER_TOMBSTONE_GRACE_MS,
      });
      // Schedule removal after the grace window so the polling tool has
      // a chance to observe the timeout before the record vanishes.
      setTimeout(() => {
        const latest = this.askUserStore.get(requestId);
        if (latest && latest.status !== "pending") {
          this.askUserStore.delete(requestId);
        }
      }, ASK_USER_TOMBSTONE_GRACE_MS).unref?.();
    }, effectiveTimeoutMs);
    timeoutHandle.unref?.();

    this.askUserStore.set(requestId, {
      status: "pending",
      options,
      timeoutHandle,
    });

    // Fire the interactive message. Fire-and-forget — the adapter handles
    // its own retries, and any transport error is logged.
    const buttons = options.map((opt, idx) => ({
      label: truncateButtonLabel(opt.label),
      callbackData: `rondel_aq_${requestId}_${idx}`,
    }));

    adapter
      .sendInteractive(binding.accountId, chatId, prompt, buttons)
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.log.error(`ask-user ${requestId} dispatch failed: ${msg}`);
      });

    this.sendJson(res, 201, { requestId });
  }

  /**
   * GET /prompts/ask-user/:id — polled by the rondel_ask_user MCP tool.
   *
   * Returns one of:
   *   { status: "pending" }
   *   { status: "resolved", selected_index, selected_label, resolvedBy? }
   *   { status: "timeout" }
   *
   * Unknown request ids 404 — which the tool interprets as "the daemon
   * restarted; treat it as a timeout."
   */
  private handleGetAskUser(res: ServerResponse, requestId: string): void {
    const entry = this.askUserStore.get(requestId);
    if (!entry) {
      this.sendJson(res, 404, { error: `ask-user request "${requestId}" not found` });
      return;
    }
    if (entry.status === "pending") {
      this.sendJson(res, 200, { status: "pending" });
      return;
    }
    if (entry.status === "resolved") {
      this.sendJson(res, 200, {
        status: "resolved",
        selected_index: entry.selectedIndex,
        selected_label: entry.selectedLabel,
        ...(entry.resolvedBy ? { resolvedBy: entry.resolvedBy } : {}),
      });
      return;
    }
    // timeout tombstone
    this.sendJson(res, 200, { status: "timeout" });
  }

  /**
   * Resolve an ask-user prompt. Called from the orchestrator's
   * interactive-callback handler when the operator taps a
   * `rondel_aq_<requestId>_<idx>` button.
   *
   * Idempotent — a second call on the same id is a no-op. If the entry
   * doesn't exist (daemon restart, already timed out) we simply log and
   * return; the adapter-level button tap stays cosmetic.
   */
  resolveAskUser(requestId: string, optionIndex: number, resolvedBy: string): void {
    const entry = this.askUserStore.get(requestId);
    if (!entry) {
      this.log.debug(`resolveAskUser(${requestId}): unknown request, ignoring`);
      return;
    }
    if (entry.status !== "pending") {
      this.log.debug(`resolveAskUser(${requestId}): already ${entry.status}, ignoring`);
      return;
    }

    clearTimeout(entry.timeoutHandle);

    if (optionIndex < 0 || optionIndex >= entry.options.length) {
      // Malformed callback — drop it. The keyboard renderer is our own
      // code so this should be unreachable in practice.
      this.log.warn(
        `resolveAskUser(${requestId}): out-of-range optionIndex=${optionIndex} (len=${entry.options.length})`,
      );
      return;
    }

    const option = entry.options[optionIndex];
    this.askUserStore.set(requestId, {
      status: "resolved",
      selectedIndex: optionIndex,
      selectedLabel: option.label,
      resolvedBy,
      tombstoneUntilMs: Date.now() + ASK_USER_TOMBSTONE_GRACE_MS,
    });

    setTimeout(() => {
      const latest = this.askUserStore.get(requestId);
      if (latest && latest.status !== "pending") {
        this.askUserStore.delete(requestId);
      }
    }, ASK_USER_TOMBSTONE_GRACE_MS).unref?.();

    this.log.info(`Ask-user ${requestId}: option ${optionIndex} ("${option.label}") by ${resolvedBy}`);
  }

  /**
   * POST /ledger/tool-call — called by first-class Rondel MCP tools
   * (rondel_bash today; the filesystem suite in Phase 3) when a tool
   * finishes executing. The bridge validates the body, emits the
   * `tool:call` hook event, and LedgerWriter appends a `tool_call`
   * entry. Fire-and-forget from the caller — a malformed body yields
   * 400 but never causes the tool itself to retry.
   */
  private handleLedgerToolCall(res: ServerResponse, body: unknown): void {
    const validation = validateBody(ToolCallEventSchema, body);
    if (!validation.success) {
      this.sendJson(res, 400, { error: validation.error });
      return;
    }
    this.hooks?.emit("tool:call", validation.data);
    this.sendJson(res, 200, { ok: true });
  }

  // ---------------------------------------------------------------------------
  // Filesystem state (Phase 3)
  // ---------------------------------------------------------------------------

  /**
   * POST /filesystem/read-state/{agent} — called by rondel_read_file after
   * a successful read. Records the sha256 hash of the content so subsequent
   * writes/edits can check staleness before overwriting.
   */
  private handleRecordRead(res: ServerResponse, agentName: string, body: unknown): void {
    if (!this.readFileState) {
      this.sendJson(res, 503, { error: "Read-file state store not available" });
      return;
    }
    if (!this.agentManager.getAgentNames().includes(agentName)) {
      this.sendJson(res, 404, { error: `Agent "${agentName}" not found` });
      return;
    }
    const parsed = validateBody(RecordReadSchema, body);
    if (!parsed.success) {
      this.sendJson(res, 400, { error: parsed.error });
      return;
    }
    this.readFileState.record(agentName, parsed.data.sessionId, parsed.data.path, parsed.data.contentHash);
    this.sendJson(res, 200, { ok: true });
  }

  /**
   * GET /filesystem/read-state/{agent}?sessionId=X&path=Y — returns the
   * recorded read hash + timestamp for the given key, or 404 if no record
   * exists. Called by write/edit/multi-edit tools before overwriting.
   */
  private handleGetReadState(res: ServerResponse, agentName: string, sessionId: string, path: string): void {
    if (!this.readFileState) {
      this.sendJson(res, 503, { error: "Read-file state store not available" });
      return;
    }
    if (!this.agentManager.getAgentNames().includes(agentName)) {
      this.sendJson(res, 404, { error: `Agent "${agentName}" not found` });
      return;
    }
    if (!sessionId || !path) {
      this.sendJson(res, 400, { error: "Missing sessionId or path query parameter" });
      return;
    }
    const record = this.readFileState.get(agentName, sessionId, path);
    if (!record) {
      this.sendJson(res, 404, { error: "No read record for this (agent, sessionId, path)" });
      return;
    }
    this.sendJson(res, 200, record);
  }

  /**
   * POST /filesystem/history/{agent}/backup — called by filesystem tools
   * before overwriting an existing file. Routes through the daemon so the
   * FileHistoryStore owns the on-disk layout (and any future retention
   * changes) in one place.
   */
  private handleBackupCreate(res: ServerResponse, agentName: string, body: unknown): void {
    if (!this.fileHistory) {
      this.sendJson(res, 503, { error: "File history store not available" });
      return;
    }
    if (!this.agentManager.getAgentNames().includes(agentName)) {
      this.sendJson(res, 404, { error: `Agent "${agentName}" not found` });
      return;
    }
    const parsed = validateBody(BackupCreateSchema, body);
    if (!parsed.success) {
      this.sendJson(res, 400, { error: parsed.error });
      return;
    }
    this.fileHistory.backup(agentName, parsed.data.originalPath, parsed.data.content)
      .then((backupId) => this.sendJson(res, 201, { backupId }))
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.log.error(`Backup failed for ${agentName}: ${msg}`);
        this.sendJson(res, 500, { error: msg });
      });
  }

  /**
   * GET /filesystem/history/{agent}?path=P — list backups for an agent,
   * optionally filtered to a single original path. Newest first.
   */
  private handleListBackups(res: ServerResponse, agentName: string, originalPath: string | undefined): void {
    if (!this.fileHistory) {
      this.sendJson(res, 503, { error: "File history store not available" });
      return;
    }
    if (!this.agentManager.getAgentNames().includes(agentName)) {
      this.sendJson(res, 404, { error: `Agent "${agentName}" not found` });
      return;
    }
    this.fileHistory.list(agentName, originalPath)
      .then((entries) => this.sendJson(res, 200, { entries }))
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.sendJson(res, 500, { error: msg });
      });
  }

  /**
   * GET /filesystem/history/{agent}/{backupId} — return the pre-image
   * content + recorded original path. Used for manual recovery.
   */
  private handleRestoreBackup(res: ServerResponse, agentName: string, backupId: string): void {
    if (!this.fileHistory) {
      this.sendJson(res, 503, { error: "File history store not available" });
      return;
    }
    if (!this.agentManager.getAgentNames().includes(agentName)) {
      this.sendJson(res, 404, { error: `Agent "${agentName}" not found` });
      return;
    }
    this.fileHistory.restore(agentName, backupId)
      .then((entry) => this.sendJson(res, 200, entry))
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.sendJson(res, 404, { error: msg });
      });
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
   * Delegates to the pure `checkOrgIsolation` function in ../shared/org-isolation.ts.
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
  // Runtime schedules
  //
  // Self-vs-admin and cross-org enforcement live inside ScheduleService —
  // these HTTP handlers just translate wire shapes and map ScheduleError
  // codes onto HTTP status codes.
  //
  // TODO(security): caller identity is currently taken at face value from
  // the request (body field `caller.*` on mutations, query params on reads).
  // The orchestrator injects `RONDEL_PARENT_AGENT` and `RONDEL_AGENT_ADMIN`
  // into each MCP server process's env, and the MCP tool layer copies them
  // into outgoing requests — but the bridge never verifies that the identity
  // claimed in the request matches the process that sent it. Because the
  // bridge listens on 127.0.0.1 with no token auth, any agent that can run
  // shell commands (rondel_bash) can curl this endpoint with any agentName
  // and isAdmin=true and impersonate another agent — creating schedules on
  // their behalf, deleting their schedules, or cross-org targeting that the
  // service-layer checks would otherwise block. The same weakness exists on
  // the admin endpoints (/admin/*), where the MCP tool layer is the only
  // gate on who can call DELETE /admin/agents/:name. Scheduling doesn't add
  // a new security boundary, but it adds a new axis — body-supplied
  // `caller.agentName` enables cross-agent impersonation that admin
  // endpoints don't model. The threat model is single-user, same-machine,
  // so an agent that reached rondel_bash is already effectively root in
  // user-land; this is a known, tolerated gap, not an unexpected one. A
  // future hardening pass should move to server-side identity resolution so
  // the bridge learns who the caller is from something the caller process
  // cannot forge.
  // ---------------------------------------------------------------------------

  private parseBoolParam(value: string | null): boolean | undefined {
    if (value === null) return undefined;
    if (value === "1" || value === "true") return true;
    if (value === "0" || value === "false") return false;
    return undefined;
  }

  private callerFromQuery(params: URLSearchParams): ScheduleCaller | { error: string } {
    const agentName = params.get("callerAgent");
    if (!agentName) return { error: "Missing callerAgent query parameter" };
    return {
      agentName,
      isAdmin: this.parseBoolParam(params.get("isAdmin")) === true,
      channelType: params.get("callerChannelType") ?? undefined,
      accountId: params.get("callerAccountId") ?? undefined,
      chatId: params.get("callerChatId") ?? undefined,
    };
  }

  private mapScheduleError(err: unknown, res: ServerResponse): void {
    if (err instanceof ScheduleError) {
      const status =
        err.code === "not_found" ? 404 :
        err.code === "forbidden" ? 403 :
        err.code === "cross_org" ? 403 :
        err.code === "unknown_agent" ? 404 :
        400;
      this.sendJson(res, status, { error: err.message, code: err.code });
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    this.log.error(`Schedule endpoint error: ${msg}`);
    this.sendJson(res, 500, { error: msg });
  }

  private handleListSchedules(res: ServerResponse, params: URLSearchParams): void {
    if (!this.schedules) {
      this.sendJson(res, 503, { error: "Schedule service not available" });
      return;
    }
    const callerResult = this.callerFromQuery(params);
    if ("error" in callerResult) {
      this.sendJson(res, 400, { error: callerResult.error });
      return;
    }
    try {
      const summaries = this.schedules.list(callerResult, {
        targetAgent: params.get("targetAgent") ?? undefined,
        includeDisabled: this.parseBoolParam(params.get("includeDisabled")) === true,
      });
      this.sendJson(res, 200, { schedules: summaries });
    } catch (err) {
      this.mapScheduleError(err, res);
    }
  }

  private handleGetSchedule(res: ServerResponse, id: string, params: URLSearchParams): void {
    if (!this.schedules) {
      this.sendJson(res, 503, { error: "Schedule service not available" });
      return;
    }
    const callerResult = this.callerFromQuery(params);
    if ("error" in callerResult) {
      this.sendJson(res, 400, { error: callerResult.error });
      return;
    }
    try {
      const summary = this.schedules.get(callerResult, id);
      this.sendJson(res, 200, summary);
    } catch (err) {
      this.mapScheduleError(err, res);
    }
  }

  private async handleCreateSchedule(res: ServerResponse, body: unknown): Promise<void> {
    if (!this.schedules) {
      this.sendJson(res, 503, { error: "Schedule service not available" });
      return;
    }
    const parsed = validateBody(ScheduleCreateRequestSchema, body);
    if (!parsed.success) {
      this.sendJson(res, 400, { error: parsed.error });
      return;
    }
    try {
      const { caller, input } = parsed.data;
      const callerCtx: ScheduleCaller = {
        agentName: caller.agentName,
        isAdmin: caller.isAdmin === true,
        channelType: caller.channelType,
        accountId: caller.accountId,
        chatId: caller.chatId,
      };
      // The Zod schema already constrains sessionTarget to "isolated" or
      // /^session:[A-Za-z0-9_-]+$/, which satisfies the CronSessionTarget
      // template literal. TypeScript can't prove that from a regex string,
      // so we narrow once at the boundary.
      const summary = await this.schedules.create(callerCtx, input as CreateScheduleInput);
      this.sendJson(res, 201, summary);
    } catch (err) {
      this.mapScheduleError(err, res);
    }
  }

  private async handleUpdateSchedule(res: ServerResponse, id: string, body: unknown): Promise<void> {
    if (!this.schedules) {
      this.sendJson(res, 503, { error: "Schedule service not available" });
      return;
    }
    const parsed = validateBody(ScheduleUpdateRequestSchema, body);
    if (!parsed.success) {
      this.sendJson(res, 400, { error: parsed.error });
      return;
    }
    try {
      const { caller, patch } = parsed.data;
      const callerCtx: ScheduleCaller = {
        agentName: caller.agentName,
        isAdmin: caller.isAdmin === true,
        channelType: caller.channelType,
        accountId: caller.accountId,
        chatId: caller.chatId,
      };
      const summary = await this.schedules.update(callerCtx, id, patch as UpdateScheduleInput);
      this.sendJson(res, 200, summary);
    } catch (err) {
      this.mapScheduleError(err, res);
    }
  }

  private async handleDeleteSchedule(res: ServerResponse, id: string, body: unknown): Promise<void> {
    if (!this.schedules) {
      this.sendJson(res, 503, { error: "Schedule service not available" });
      return;
    }
    const parsed = validateBody(ScheduleMutationRequestSchema, body);
    if (!parsed.success) {
      this.sendJson(res, 400, { error: parsed.error });
      return;
    }
    try {
      const callerCtx: ScheduleCaller = {
        agentName: parsed.data.caller.agentName,
        isAdmin: parsed.data.caller.isAdmin === true,
        channelType: parsed.data.caller.channelType,
        accountId: parsed.data.caller.accountId,
        chatId: parsed.data.caller.chatId,
      };
      await this.schedules.remove(callerCtx, id);
      this.sendJson(res, 200, { deleted: true });
    } catch (err) {
      this.mapScheduleError(err, res);
    }
  }

  private async handleRunSchedule(res: ServerResponse, id: string, body: unknown): Promise<void> {
    if (!this.schedules) {
      this.sendJson(res, 503, { error: "Schedule service not available" });
      return;
    }
    const parsed = validateBody(ScheduleMutationRequestSchema, body);
    if (!parsed.success) {
      this.sendJson(res, 400, { error: parsed.error });
      return;
    }
    try {
      const callerCtx: ScheduleCaller = {
        agentName: parsed.data.caller.agentName,
        isAdmin: parsed.data.caller.isAdmin === true,
        channelType: parsed.data.caller.channelType,
        accountId: parsed.data.caller.accountId,
        chatId: parsed.data.caller.chatId,
      };
      await this.schedules.runNow(callerCtx, id);
      this.sendJson(res, 200, { triggered: true });
    } catch (err) {
      this.mapScheduleError(err, res);
    }
  }

  // ---------------------------------------------------------------------------
  // Admin delegation
  // ---------------------------------------------------------------------------

  /**
   * Delegate to an AdminApi method and write the result as HTTP response.
   * Handles both sync and async admin methods.
   *
   * TODO(security): there is NO authorization check on this path. The only
   * gate on who can reach /admin/* is which MCP tools the agent's Claude
   * process was told about at spawn time (non-admin agents don't see
   * rondel_add_agent et al. in their toolset). Any agent with
   * rondel_bash can bypass that gate entirely by curl'ing these endpoints
   * directly — the bridge listens on 127.0.0.1 with no token auth. See
   * the matching note on the runtime-schedules section above. A future
   * hardening pass should replace client-side gating with server-side
   * identity resolution so the bridge itself decides whether the calling
   * process is allowed to perform an admin action, not the calling
   * process.
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
