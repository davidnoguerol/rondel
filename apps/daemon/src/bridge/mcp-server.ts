import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { registerTelegramTools } from "../channels/telegram/index.js";
import {
  registerBashTool,
  registerReadFileTool,
  registerWriteFileTool,
  registerEditFileTool,
  registerMultiEditFileTool,
  registerAskUserTool,
} from "../tools/index.js";

const BRIDGE_URL = process.env.RONDEL_BRIDGE_URL ?? "";
const PARENT_AGENT = process.env.RONDEL_PARENT_AGENT ?? "";
const PARENT_CHANNEL_TYPE = process.env.RONDEL_PARENT_CHANNEL_TYPE || "internal";
const PARENT_ACCOUNT_ID = process.env.RONDEL_PARENT_ACCOUNT_ID || PARENT_AGENT;
const PARENT_CHAT_ID = process.env.RONDEL_PARENT_CHAT_ID ?? "";
const IS_ADMIN = process.env.RONDEL_AGENT_ADMIN === "1";

// --- MCP Server ---

const server = new McpServer({
  name: "rondel",
  version: "0.1.0",
  description: "Rondel agent tools",
});

// Channel-specific tools are registered by the owning channel module.
// The core MCP server stays channel-agnostic. Each register function is
// a no-op when its channel's token env var isn't set for this agent.
registerTelegramTools(server);

// First-class Rondel tools (run in this MCP process, not Claude's).
// Each tool handles its own safety classification + approval flow +
// ledger emit via the HTTP bridge. Not gated on IS_ADMIN — these
// replace the native Bash/Write/Edit surface for every agent.
registerBashTool(server);
registerReadFileTool(server);
registerWriteFileTool(server);
registerEditFileTool(server);
registerMultiEditFileTool(server);
registerAskUserTool(server);

// --- Bridge tools (query Rondel core state) ---

async function bridgeCall(path: string): Promise<unknown> {
  if (!BRIDGE_URL) {
    throw new Error("RONDEL_BRIDGE_URL not set — bridge tools unavailable");
  }

  const response = await fetch(`${BRIDGE_URL}${path}`);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Bridge ${path} error ${response.status}: ${text}`);
  }

  return response.json();
}

async function bridgePost(path: string, body: unknown): Promise<unknown> {
  if (!BRIDGE_URL) {
    throw new Error("RONDEL_BRIDGE_URL not set — bridge tools unavailable");
  }

  const response = await fetch(`${BRIDGE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Bridge POST ${path} error ${response.status}: ${text}`);
  }

  return response.json();
}

async function bridgePut(path: string, body: unknown): Promise<unknown> {
  if (!BRIDGE_URL) {
    throw new Error("RONDEL_BRIDGE_URL not set — bridge tools unavailable");
  }

  const response = await fetch(`${BRIDGE_URL}${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Bridge PUT ${path} error ${response.status}: ${text}`);
  }

  return response.json();
}

async function bridgeDelete(path: string, body?: unknown): Promise<unknown> {
  if (!BRIDGE_URL) {
    throw new Error("RONDEL_BRIDGE_URL not set — bridge tools unavailable");
  }

  const init: RequestInit = { method: "DELETE" };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`${BRIDGE_URL}${path}`, init);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Bridge DELETE ${path} error ${response.status}: ${text}`);
  }

  return response.json();
}

async function bridgePatch(path: string, body: unknown): Promise<unknown> {
  if (!BRIDGE_URL) {
    throw new Error("RONDEL_BRIDGE_URL not set — bridge tools unavailable");
  }

  const response = await fetch(`${BRIDGE_URL}${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Bridge PATCH ${path} error ${response.status}: ${text}`);
  }

  return response.json();
}

server.registerTool(
  "rondel_list_agents",
  {
    description: "List all configured agents and their active conversations. Use this to see which agents exist, how many conversations each has, and what state those conversations are in.",
    inputSchema: {},
  },
  async () => {
    try {
      const data = await bridgeCall("/agents");
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: `Failed to list agents: ${message}` }],
        isError: true,
      };
    }
  },
);

server.registerTool(
  "rondel_agent_status",
  {
    description: "Get detailed status of a specific agent's conversations. Shows each active conversation's chat ID, state (idle/busy/crashed/halted), and session ID.",
    inputSchema: {
      agent_name: z.string().describe("The agent name to get status for (e.g., 'assistant', 'dev-lead')"),
    },
  },
  async ({ agent_name }) => {
    try {
      const data = await bridgeCall(`/conversations/${encodeURIComponent(agent_name)}`);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: `Failed to get agent status: ${message}` }],
        isError: true,
      };
    }
  },
);

// --- Subagent tools ---

server.registerTool(
  "rondel_spawn_subagent",
  {
    description:
      "Spawn an ephemeral subagent to execute a task. Returns immediately with the subagent ID; " +
      "the subagent runs in the background and its result is delivered to you as a message when " +
      "it completes — do NOT poll with rondel_subagent_status. The user is notified in Telegram " +
      "that work is being delegated. Reusable role prompts belong in skills — read the relevant " +
      "skill first and pass its recommended system_prompt directly here.",
    inputSchema: {
      task: z.string().describe("The task for the subagent to execute"),
      system_prompt: z.string().describe("Inline system prompt. Required. Often sourced from a skill's documented recipe."),
      working_directory: z.string().optional().describe("Directory for the subagent to work in"),
      model: z.string().optional().describe("Model override (defaults to parent's model)"),
      max_turns: z.number().optional().describe("Maximum agentic turns before stopping"),
      timeout_ms: z.number().optional().describe("Timeout in milliseconds (default: 300000 = 5 minutes)"),
    },
  },
  async ({ task, system_prompt, working_directory, model, max_turns, timeout_ms }) => {
    try {
      const data = await bridgePost("/subagents/spawn", {
        task,
        system_prompt,
        working_directory,
        model,
        max_turns,
        timeout_ms,
        parent_agent_name: PARENT_AGENT,
        parent_channel_type: PARENT_CHANNEL_TYPE,
        parent_account_id: PARENT_ACCOUNT_ID,
        parent_chat_id: PARENT_CHAT_ID,
      });

      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: `Failed to spawn subagent: ${message}` }],
        isError: true,
      };
    }
  },
);

server.registerTool(
  "rondel_subagent_status",
  {
    description:
      "Check the status of a subagent. Results are normally delivered automatically — " +
      "only use this if you need to check on a subagent that hasn't reported back yet. " +
      "Returns state (running/completed/failed/killed/timeout), result text, error, cost, and timing.",
    inputSchema: {
      subagent_id: z.string().describe("The subagent ID returned by rondel_spawn_subagent"),
    },
  },
  async ({ subagent_id }) => {
    try {
      const data = await bridgeCall(`/subagents/${encodeURIComponent(subagent_id)}`);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: `Failed to get subagent status: ${message}` }],
        isError: true,
      };
    }
  },
);

server.registerTool(
  "rondel_kill_subagent",
  {
    description: "Kill a running subagent. Use this to cancel a subagent that is taking too long or is no longer needed.",
    inputSchema: {
      subagent_id: z.string().describe("The subagent ID to kill"),
    },
  },
  async ({ subagent_id }) => {
    try {
      const data = await bridgeDelete(`/subagents/${encodeURIComponent(subagent_id)}`);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: `Failed to kill subagent: ${message}` }],
        isError: true,
      };
    }
  },
);

// --- Inter-agent messaging tools ---

server.registerTool(
  "rondel_send_message",
  {
    description:
      "Send a message to another agent. The message is delivered asynchronously — the recipient " +
      "processes it in their own context and the response is automatically delivered back to your " +
      "conversation. Use rondel_list_teammates to see which agents you can message. " +
      "For large content (documents, drafts, code), write to a shared drive file and reference " +
      "the path in your message instead of including the full content.",
    inputSchema: {
      to: z.string().describe("The recipient agent name (e.g., 'architect', 'dev-lead')"),
      content: z.string().describe("The message content to send"),
    },
  },
  async ({ to, content }) => {
    try {
      const data = await bridgePost("/messages/send", {
        from: PARENT_AGENT,
        to,
        content,
        reply_to_chat_id: PARENT_CHAT_ID,
      });
      const result = data as { ok: boolean; message_id: string };
      return {
        content: [{
          type: "text" as const,
          text: `Message sent to ${to} (id: ${result.message_id}). ` +
            `Their response will be delivered to your conversation automatically.`,
        }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: `Failed to send message: ${message}` }],
        isError: true,
      };
    }
  },
);

server.registerTool(
  "rondel_list_teammates",
  {
    description:
      "List agents you can send messages to. Returns only agents reachable from your organization " +
      "(same-org and global agents). Use this before sending a message to see who is available.",
    inputSchema: {},
  },
  async () => {
    try {
      const data = await bridgeCall(`/messages/teammates?from=${encodeURIComponent(PARENT_AGENT)}`);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: `Failed to list teammates: ${message}` }],
        isError: true,
      };
    }
  },
);

// --- Transcript tools ---

server.registerTool(
  "rondel_recall_user_conversation",
  {
    description:
      "Recall your recent conversation with the user. Returns the last N turns (user messages and " +
      "your responses) from your most recent user conversation session. Use this when you need context " +
      "about what you and the user have been discussing — especially when handling inter-agent messages " +
      "that ask about your recent user interactions.",
    inputSchema: {
      last_n_turns: z.number().int().min(1).max(50).optional()
        .describe("Number of recent turns to retrieve (default: 10, max: 50)"),
    },
  },
  async ({ last_n_turns }) => {
    try {
      const n = last_n_turns ?? 10;
      const data = await bridgeCall(
        `/transcripts/${encodeURIComponent(PARENT_AGENT)}/recent?last_n=${n}`,
      ) as { turns: Array<{ role: string; text: string }>; total_turns: number };

      if (!data.turns || data.turns.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No recent user conversation found." }],
        };
      }

      const formatted = data.turns
        .map((t) => `[${t.role.toUpperCase()}]: ${t.text}`)
        .join("\n\n");

      return {
        content: [{
          type: "text" as const,
          text: `Recent conversation (${data.turns.length} of ${data.total_turns} total turns):\n\n${formatted}`,
        }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: `Failed to recall conversation: ${message}` }],
        isError: true,
      };
    }
  },
);

// --- Memory tools ---

server.registerTool(
  "rondel_memory_read",
  {
    description:
      "Read your persistent memory file (MEMORY.md). This file is automatically loaded into your " +
      "system prompt at session start, so you already have its contents in context. Use this tool " +
      "mid-session to check the current state of your memory after a save, or to verify what's there.",
    inputSchema: {},
  },
  async () => {
    try {
      const data = (await bridgeCall(`/memory/${encodeURIComponent(PARENT_AGENT)}`)) as { content: string | null };
      if (data.content === null) {
        return {
          content: [{ type: "text" as const, text: "No memory file exists yet. Use rondel_memory_save to create one." }],
        };
      }
      return {
        content: [{ type: "text" as const, text: data.content }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: `Failed to read memory: ${message}` }],
        isError: true,
      };
    }
  },
);

server.registerTool(
  "rondel_memory_save",
  {
    description:
      "Save content to your persistent memory file (MEMORY.md). This overwrites the entire file — " +
      "read your current memory first if you want to preserve existing entries. Memory survives " +
      "session resets (/new), Rondel restarts, and context compaction. Use this to remember " +
      "decisions, user preferences, lessons learned, project context, and anything worth keeping " +
      "across sessions. The content will be included in your system prompt on future sessions.",
    inputSchema: {
      content: z.string().describe("The full content to write to MEMORY.md (replaces the entire file)"),
    },
  },
  async ({ content }) => {
    try {
      await bridgePut(`/memory/${encodeURIComponent(PARENT_AGENT)}`, { content });
      return {
        content: [{ type: "text" as const, text: "Memory saved successfully. It will be loaded into your context on future sessions." }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: `Failed to save memory: ${message}` }],
        isError: true,
      };
    }
  },
);

// --- Skill reload (for rondel-create-skill / self-extension) ---

// Intentionally registered outside the IS_ADMIN gate: skills ≠ permissions.
// Every agent manages its own per-agent `.claude/skills/` directory and must
// be able to reload them after authoring one. The tool only restarts the
// calling conversation's own process — no cross-agent impact — so the
// admin scope gate doesn't apply.
server.registerTool(
  "rondel_reload_skills",
  {
    description:
      "Reload your skills after authoring or editing a SKILL.md file under your agent's " +
      "`.claude/skills/` directory. Claude CLI only discovers skills at process spawn time, so " +
      "newly-written skills need a restart to appear in your catalog. This tool schedules the " +
      "restart for AFTER your current response completes — your session context is preserved " +
      "via --resume, and you do not need to do anything special. Finish your turn normally; " +
      "the restart happens silently between turns and your next response will have the new " +
      "skill available. Use this immediately after writing a skill with the rondel-create-skill " +
      "workflow.",
    inputSchema: {},
  },
  async () => {
    try {
      await bridgePost("/agent/schedule-skill-reload", {
        agent_name: PARENT_AGENT,
        channel_type: PARENT_CHANNEL_TYPE,
        chat_id: PARENT_CHAT_ID,
      });
      return {
        content: [{
          type: "text" as const,
          text:
            "Skill reload scheduled. Finish your turn normally — the restart will fire once " +
            "your response is complete, and your next message will have the new skill in context.",
        }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: `Failed to schedule skill reload: ${message}` }],
        isError: true,
      };
    }
  },
);

// --- System status tool (available to all agents) ---

server.registerTool(
  "rondel_system_status",
  {
    description:
      "Get Rondel system status: all agents, their active conversations, uptime, and the daemon's " +
      "current ISO timestamp (`currentTimeIso`). Use this to check system health, see what agents " +
      "are running, and get a fresh date/time reading when the user asks.",
    inputSchema: {},
  },
  async () => {
    try {
      const data = await bridgeCall("/admin/status");
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: `Failed to get system status: ${message}` }],
        isError: true,
      };
    }
  },
);

// --- Conversation ledger tool (available to all agents) ---

server.registerTool(
  "rondel_ledger_query",
  {
    description:
      "Query the conversation ledger to see what agents have been doing. Returns structured " +
      "events: user messages, agent responses, inter-agent messages, subagent spawns/results, " +
      "cron results, session lifecycle (start, crash, halt). Events contain summaries, not full " +
      "message bodies. Use this to understand recent activity, spot patterns, or check what " +
      "happened while you were idle.",
    inputSchema: {
      agent: z.string().optional().describe("Filter by agent name. Omit to query all agents you can see."),
      since: z.string().optional().describe("Time filter: relative (\"6h\", \"30m\", \"1d\") or ISO 8601 timestamp."),
      kinds: z.array(z.string()).optional().describe(
        "Filter by event kind. Options: user_message, agent_response, inter_agent_sent, " +
        "inter_agent_received, subagent_spawned, subagent_result, cron_completed, cron_failed, " +
        "session_start, session_resumed, session_reset, crash, halt",
      ),
      limit: z.number().int().min(1).max(500).optional().describe("Max events to return (default: 50, max: 500)."),
    },
  },
  async ({ agent, since, kinds, limit }) => {
    try {
      const params = new URLSearchParams();
      if (agent) params.set("agent", agent);
      if (since) params.set("since", since);
      if (kinds?.length) params.set("kinds", kinds.join(","));
      if (limit !== undefined) params.set("limit", String(limit));
      const query = params.toString();
      const data = await bridgeCall(`/ledger/query${query ? `?${query}` : ""}`);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: `Failed to query ledger: ${message}` }],
        isError: true,
      };
    }
  },
);

// --- Runtime scheduling tools (durable crons — see scheduling module) ---

/**
 * Identity envelope the bridge expects on every schedule call. Populated
 * from the per-conversation env vars so self-vs-admin and default delivery
 * checks don't trust agent-supplied identity.
 */
function scheduleCaller() {
  return {
    agentName: PARENT_AGENT,
    isAdmin: IS_ADMIN,
    channelType: PARENT_CHANNEL_TYPE,
    accountId: PARENT_ACCOUNT_ID,
    chatId: PARENT_CHAT_ID || undefined,
  };
}

/** Shared Zod input shape for the schedule-kind discriminated union. */
const scheduleInputShape = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("every"),
    interval: z.string().describe('Duration like "30s", "5m", "1h", "2h30m", "7d"'),
  }),
  z.object({
    kind: z.literal("at"),
    at: z.string().describe('ISO 8601 timestamp (e.g., "2026-04-19T08:00:00Z") or relative offset ("20m", "1h30m")'),
  }),
  z.object({
    kind: z.literal("cron"),
    expression: z.string().describe('Standard 5-field cron (e.g., "0 8 * * *")'),
    timezone: z.string().optional().describe('Optional IANA timezone (e.g., "America/Sao_Paulo"). Defaults to daemon local TZ.'),
  }),
]);

const deliveryShape = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("none") }),
  z.object({
    mode: z.literal("announce"),
    chatId: z.string(),
    channelType: z.string().optional(),
    accountId: z.string().optional(),
  }),
]);

server.registerTool(
  "rondel_schedule_create",
  {
    description:
      "Create a durable scheduled task. Survives daemon restarts, has no TTL, and — if no explicit `delivery` is given — " +
      "routes its output back to the conversation you're in. Use this for reminders, recurring tasks, and anything that " +
      "needs to fire later than the current turn. Three schedule kinds: `every` (interval), `at` (one-shot absolute/relative " +
      "time, auto-deletes by default), `cron` (5-field expression).\n\n" +
      "Prefer this over the native CronCreate (which is session-only and capped at 7 days — and is disallowed in Rondel).",
    inputSchema: {
      name: z.string().describe("Short human-readable label for the schedule."),
      schedule: scheduleInputShape,
      prompt: z.string().describe("The task to run when the schedule fires (agent turn prompt)."),
      delivery: deliveryShape.optional().describe(
        "Where to deliver the result. Omit to auto-route back to the current conversation.",
      ),
      sessionTarget: z.string().optional().describe(
        'Either "isolated" (default — fresh subagent per run) or "session:<name>" (persistent named session).',
      ),
      model: z.string().optional().describe("Override the agent's default model for this schedule only."),
      timeoutMs: z.number().int().positive().optional().describe("Max runtime for the triggered turn, in ms."),
      deleteAfterRun: z.boolean().optional().describe(
        'Remove the schedule after its first successful run. Defaults to true for `kind: "at"`, false otherwise.',
      ),
      targetAgent: z.string().optional().describe(
        "Admin-only: create the schedule on behalf of another agent. Defaults to yourself.",
      ),
    },
  },
  async (input) => {
    try {
      const data = await bridgePost("/schedules", {
        caller: scheduleCaller(),
        input,
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: `Failed to create schedule: ${message}` }],
        isError: true,
      };
    }
  },
);

server.registerTool(
  "rondel_schedule_list",
  {
    description:
      "List durable schedules. By default returns your own schedules; admin agents can pass `targetAgent` to list another " +
      "agent's. Each entry includes current `nextRunAtMs`, `lastRunAtMs`, and `lastStatus`.",
    inputSchema: {
      targetAgent: z.string().optional().describe("Admin-only: list another agent's schedules."),
      includeDisabled: z.boolean().optional().describe("Include disabled schedules in the result."),
    },
  },
  async ({ targetAgent, includeDisabled }) => {
    try {
      const params = new URLSearchParams();
      const caller = scheduleCaller();
      params.set("callerAgent", caller.agentName);
      if (caller.isAdmin) params.set("isAdmin", "true");
      if (caller.channelType) params.set("callerChannelType", caller.channelType);
      if (caller.accountId) params.set("callerAccountId", caller.accountId);
      if (caller.chatId) params.set("callerChatId", caller.chatId);
      if (targetAgent) params.set("targetAgent", targetAgent);
      if (includeDisabled) params.set("includeDisabled", "true");
      const data = await bridgeCall(`/schedules?${params.toString()}`);
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: `Failed to list schedules: ${message}` }],
        isError: true,
      };
    }
  },
);

server.registerTool(
  "rondel_schedule_update",
  {
    description:
      "Update an existing schedule. Pass only the fields you want to change — omitted fields are preserved. Use this to " +
      "change the schedule, rewrite the prompt, retarget delivery, or toggle enabled/disabled.",
    inputSchema: {
      scheduleId: z.string().describe("The schedule id returned from rondel_schedule_create or rondel_schedule_list."),
      patch: z.object({
        name: z.string().optional(),
        schedule: scheduleInputShape.optional(),
        prompt: z.string().optional(),
        delivery: deliveryShape.optional(),
        sessionTarget: z.string().optional(),
        model: z.string().nullable().optional(),
        timeoutMs: z.number().int().positive().optional(),
        deleteAfterRun: z.boolean().optional(),
        enabled: z.boolean().optional(),
      }),
    },
  },
  async ({ scheduleId, patch }) => {
    try {
      const data = await bridgePatch(`/schedules/${encodeURIComponent(scheduleId)}`, {
        caller: scheduleCaller(),
        patch,
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: `Failed to update schedule: ${message}` }],
        isError: true,
      };
    }
  },
);

server.registerTool(
  "rondel_schedule_delete",
  {
    description:
      "Cancel a durable schedule. Non-admins can only delete their own; admins may delete any schedule in the same org " +
      "(or on global agents).",
    inputSchema: {
      scheduleId: z.string().describe("The schedule id to cancel."),
    },
  },
  async ({ scheduleId }) => {
    try {
      const data = await bridgeDelete(`/schedules/${encodeURIComponent(scheduleId)}`, {
        caller: scheduleCaller(),
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: `Failed to delete schedule: ${message}` }],
        isError: true,
      };
    }
  },
);

server.registerTool(
  "rondel_schedule_run",
  {
    description:
      "Fire a schedule immediately, ignoring its normal next-run time. Useful for testing or when the user asks for the " +
      "scheduled task to run right now. Does not affect future firings.",
    inputSchema: {
      scheduleId: z.string().describe("The schedule id to trigger."),
    },
  },
  async ({ scheduleId }) => {
    try {
      const data = await bridgePost(`/schedules/${encodeURIComponent(scheduleId)}/run`, {
        caller: scheduleCaller(),
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: `Failed to trigger schedule: ${message}` }],
        isError: true,
      };
    }
  },
);

// --- Heartbeat tools (per-agent liveness — see heartbeats module) ---

server.registerTool(
  "rondel_heartbeat_update",
  {
    description:
      "Record your periodic discipline check-in. Write a short status, the task you're on, and optional notes. " +
      "Called from the rondel-heartbeat skill on every cron fire. Self-write only — you cannot write another " +
      "agent's heartbeat. The record is silent (no channel delivery); the web dashboard and admin tools pick it up.",
    inputSchema: {
      status: z.string().describe(
        'One-line free-form status. Examples: "drafting Q2 summary, blocked on analyst data", "idle — no tasks queued", "in flow on ingestion rewrite".',
      ),
      currentTask: z.string().optional().describe(
        "One-line summary of your primary current task. Optional.",
      ),
      notes: z.string().optional().describe(
        "Longer free-form note for future-you to read. Optional; keep it short.",
      ),
    },
  },
  async ({ status, currentTask, notes }) => {
    try {
      const data = await bridgePost("/heartbeats/update", {
        callerAgent: PARENT_AGENT,
        status,
        currentTask,
        notes,
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: `Failed to update heartbeat: ${message}` }],
        isError: true,
      };
    }
  },
);

// Note: `rondel_heartbeat_read_all` is admin-only and registered inside
// the `if (IS_ADMIN)` block below. Non-admin agents never see the tool.

// --- Task board tools (per-org work queue — see tasks module) ---
//
// Eight tools mirroring the bridge's /tasks/* endpoints. Each forwards
// `callerAgent: PARENT_AGENT` for identity + `isAdmin: IS_ADMIN` for
// cross-org access. Discipline for when to use these vs
// rondel_send_message vs rondel_spawn_subagent lives in the
// rondel-task-management skill.

const TaskPriorityEnum = z.enum(["urgent", "high", "normal", "low"]);
const TaskOutputShape = z.object({
  type: z.literal("file"),
  path: z.string().min(1),
  label: z.string().optional(),
});

server.registerTool(
  "rondel_task_create",
  {
    description:
      "Create a task before starting work >10min. Produces a persistent record on the team board with an " +
      "assignee, priority, DAG dependencies, and an audit trail. The task lives in the assignee's org. " +
      "Any agent in the org can create; admins can create cross-org. Use this instead of rondel_send_message " +
      "when the work is durable (>10min), multi-step, or needs multi-agent handoff.",
    inputSchema: {
      title: z.string().min(1).max(120).describe("One-line summary, ≤120 chars."),
      description: z.string().optional().describe("Full context. Markdown ok. ≤8KB."),
      assignedTo: z.string().describe("The agent who will do the work."),
      priority: TaskPriorityEnum.optional().describe("Default: normal."),
      blockedBy: z.array(z.string()).optional().describe(
        "Task ids that must reach status=completed before this task can be claimed. Creates symmetric DAG edges.",
      ),
      dueDate: z.string().optional().describe("ISO 8601. Past dueDate classifies the task as overdue on the next stale sweep."),
      externalAction: z.boolean().optional().describe(
        "When true, rondel_task_complete opens an approval before flipping status. Use for tasks that ship externally-visible artifacts (publishing, invoicing, etc.).",
      ),
    },
  },
  async (args) => {
    try {
      const data = await bridgePost("/tasks/create", {
        callerAgent: PARENT_AGENT,
        isAdmin: IS_ADMIN,
        ...args,
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text" as const, text: `Failed to create task: ${msg}` }], isError: true };
    }
  },
);

server.registerTool(
  "rondel_task_claim",
  {
    description:
      "Atomically claim a task assigned to you. Transitions pending → in_progress. First caller wins the " +
      "O_EXCL lockfile; subsequent callers get claim_conflict. Check that every task in blockedBy is " +
      "completed first — claim will reject with blocked_by_open if any are open.",
    inputSchema: { id: z.string().describe("The task id.") },
  },
  async ({ id }) => {
    try {
      const data = await bridgePost(`/tasks/${encodeURIComponent(id)}/claim`, {
        callerAgent: PARENT_AGENT,
        isAdmin: IS_ADMIN,
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text" as const, text: `Failed to claim task: ${msg}` }], isError: true };
    }
  },
);

server.registerTool(
  "rondel_task_update",
  {
    description:
      "Patch a task's non-status fields (title, description, priority, assignedTo, dueDate, blockedBy). " +
      "Status flips happen through the dedicated claim/complete/block/unblock/cancel tools. Reassigning " +
      "across orgs is blocked; cycle-introducing blockedBy changes are rejected with cycle_detected.",
    inputSchema: {
      id: z.string().describe("The task id."),
      title: z.string().min(1).max(120).optional(),
      description: z.string().optional(),
      priority: TaskPriorityEnum.optional(),
      assignedTo: z.string().optional(),
      dueDate: z.string().nullable().optional().describe("ISO 8601 to set, null to clear."),
      blockedBy: z.array(z.string()).optional(),
    },
  },
  async ({ id, ...patch }) => {
    try {
      const data = await bridgePost(`/tasks/${encodeURIComponent(id)}/update`, {
        callerAgent: PARENT_AGENT,
        isAdmin: IS_ADMIN,
        ...patch,
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text" as const, text: `Failed to update task: ${msg}` }], isError: true };
    }
  },
);

server.registerTool(
  "rondel_task_complete",
  {
    description:
      "Mark a task you're working on as completed. Provide a summary result and an optional outputs list. " +
      "For tasks with externalAction=true, the response is `{status: 'approval_pending', approvalRequestId}` " +
      "and the task stays in_progress until the human approves via the web UI or channel; on denial the task " +
      "flips to blocked with the denial reason.",
    inputSchema: {
      id: z.string().describe("The task id."),
      result: z.string().min(1).describe("Summary of what shipped (≤8KB). Required."),
      outputs: z.array(TaskOutputShape).optional().describe(
        "Concrete deliverables. Use file outputs for anything durable.",
      ),
    },
  },
  async ({ id, result, outputs }) => {
    try {
      const data = await bridgePost(`/tasks/${encodeURIComponent(id)}/complete`, {
        callerAgent: PARENT_AGENT,
        isAdmin: IS_ADMIN,
        result,
        outputs,
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text" as const, text: `Failed to complete task: ${msg}` }], isError: true };
    }
  },
);

server.registerTool(
  "rondel_task_block",
  {
    description:
      "Mark a task as blocked with a structured reason. Releases the claim lockfile. Use for external " +
      'waits — "waiting on user reply", "upstream API returning 500s, retrying at 18:00". The orchestrator sees ' +
      "blocked tasks on the board and in heartbeat sweeps.",
    inputSchema: {
      id: z.string().describe("The task id."),
      reason: z.string().min(1).describe("Why you're stuck. One sentence, concrete."),
    },
  },
  async ({ id, reason }) => {
    try {
      const data = await bridgePost(`/tasks/${encodeURIComponent(id)}/block`, {
        callerAgent: PARENT_AGENT,
        isAdmin: IS_ADMIN,
        reason,
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text" as const, text: `Failed to block task: ${msg}` }], isError: true };
    }
  },
);

server.registerTool(
  "rondel_task_unblock",
  {
    description:
      "Move a blocked task back to pending. Clears the blockedReason; the next claim puts it back in flight.",
    inputSchema: { id: z.string() },
  },
  async ({ id }) => {
    try {
      const data = await bridgePost(`/tasks/${encodeURIComponent(id)}/unblock`, {
        callerAgent: PARENT_AGENT,
        isAdmin: IS_ADMIN,
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text" as const, text: `Failed to unblock task: ${msg}` }], isError: true };
    }
  },
);

server.registerTool(
  "rondel_task_cancel",
  {
    description:
      "Terminally cancel a task. Writes an audit entry and emits task:cancelled. The record is preserved " +
      "(not deleted). Use when a task is no longer needed, the scope changed, or a dependency fell through.",
    inputSchema: {
      id: z.string().describe("The task id."),
      reason: z.string().optional().describe("Why you're cancelling — becomes the blockedReason on the record."),
    },
  },
  async ({ id, reason }) => {
    try {
      const data = await bridgePost(`/tasks/${encodeURIComponent(id)}/cancel`, {
        callerAgent: PARENT_AGENT,
        isAdmin: IS_ADMIN,
        reason,
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text" as const, text: `Failed to cancel task: ${msg}` }], isError: true };
    }
  },
);

server.registerTool(
  "rondel_task_list",
  {
    description:
      "List tasks in your org with optional filters. Ordered unblocked-first, then priority (urgent → low), " +
      "then oldest first. Completed/cancelled tasks are hidden unless includeCompleted=true.",
    inputSchema: {
      org: z.string().optional().describe("Admin-only org override. Ignored by non-admins."),
      assignee: z.string().optional().describe("Filter to one assignee's tasks."),
      status: z.enum(["pending", "in_progress", "blocked", "completed", "cancelled"]).optional(),
      priority: TaskPriorityEnum.optional(),
      includeCompleted: z.boolean().optional().describe("Default false."),
      staleOnly: z.boolean().optional().describe("Return only tasks past their staleness threshold."),
    },
  },
  async ({ org, assignee, status, priority, includeCompleted, staleOnly }) => {
    try {
      const params = new URLSearchParams();
      params.set("callerAgent", PARENT_AGENT);
      if (IS_ADMIN) params.set("isAdmin", "true");
      if (assignee) params.set("assignee", assignee);
      if (status) params.set("status", status);
      if (priority) params.set("priority", priority);
      if (includeCompleted) params.set("includeCompleted", "true");
      if (staleOnly) params.set("staleOnly", "true");
      const target = org ?? "global"; // the handler filters by caller's org anyway
      const data = await bridgeCall(`/tasks/${encodeURIComponent(target)}?${params.toString()}`);
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text" as const, text: `Failed to list tasks: ${msg}` }], isError: true };
    }
  },
);

server.registerTool(
  "rondel_task_get",
  {
    description:
      "Read one task by id, optionally with its full audit log. Use this to inspect history after a state " +
      "change or to check dependencies before claiming. Returns 404 if the id is not in your scope.",
    inputSchema: {
      id: z.string().describe("The task id."),
      org: z.string().optional().describe("Admin-only cross-org hint."),
      includeAudit: z.boolean().optional().describe("Default false."),
    },
  },
  async ({ id, org, includeAudit }) => {
    try {
      const params = new URLSearchParams();
      params.set("callerAgent", PARENT_AGENT);
      if (IS_ADMIN) params.set("isAdmin", "true");
      if (includeAudit) params.set("includeAudit", "true");
      const target = org ?? "global";
      const data = await bridgeCall(
        `/tasks/${encodeURIComponent(target)}/${encodeURIComponent(id)}?${params.toString()}`,
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text" as const, text: `Failed to get task: ${msg}` }], isError: true };
    }
  },
);

// --- Org tools (available to all agents, read-only) ---

server.registerTool(
  "rondel_list_orgs",
  {
    description:
      "List all organizations in Rondel. Shows org names, display names, and directories. " +
      "Organizations group agents and provide shared context.",
    inputSchema: {},
  },
  async () => {
    try {
      const data = await bridgeCall("/orgs");
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: `Failed to list orgs: ${message}` }],
        isError: true,
      };
    }
  },
);

server.registerTool(
  "rondel_org_details",
  {
    description:
      "Get detailed information about a specific organization: its agents, config, and shared context directory. " +
      "Use rondel_list_orgs first to see available org names.",
    inputSchema: {
      org_name: z.string().describe("The organization name to get details for"),
    },
  },
  async ({ org_name }) => {
    try {
      const data = await bridgeCall(`/orgs/${encodeURIComponent(org_name)}`);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: `Failed to get org details: ${message}` }],
        isError: true,
      };
    }
  },
);

// --- Admin tools (only registered for admin agents) ---

if (IS_ADMIN) {
  server.registerTool(
    "rondel_add_agent",
    {
      description:
        "Create a new Rondel agent. Scaffolds the directory with config and identity files, " +
        "registers it with the orchestrator, and starts its Telegram bot immediately. The new agent " +
        "begins its bootstrap ritual on first message. IMPORTANT: Before calling this tool, confirm " +
        "the plan with the user. Walk them through creating a Telegram bot via @BotFather to get the " +
        "token. Don't proceed until you have the token and the user has confirmed.",
      inputSchema: {
        agent_name: z.string().describe("Unique agent name (letters, numbers, hyphens, underscores)"),
        bot_token: z.string().describe("Telegram bot token from @BotFather (e.g., 123456:ABC-DEF...)"),
        model: z.string().optional().describe("Model to use (default: 'sonnet')"),
        org: z.string().optional().describe("Organization name to add the agent to. Sets location to '{org}/agents'. Use rondel_list_orgs to see available orgs."),
        location: z.string().optional().describe("Location within workspaces/ directory (default: 'global/agents'). Overridden by 'org' if both provided."),
        working_directory: z.string().optional().describe("Absolute path to the project directory the agent should work in (e.g., '/Users/neo/projects/flint-app')"),
      },
    },
    async ({ agent_name, bot_token, model, org, location, working_directory }) => {
      try {
        // If org is provided, derive location from it (convenience shorthand)
        const effectiveLocation = org ? `${org}/agents` : location;

        const data = await bridgePost("/admin/agents", {
          agent_name,
          bot_token,
          model,
          location: effectiveLocation,
          working_directory,
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Failed to add agent: ${message}` }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "rondel_update_agent",
    {
      description:
        "Update an existing agent's configuration. Changes apply to new conversations — " +
        "running conversations keep their current settings. Confirm with the user before making changes.",
      inputSchema: {
        agent_name: z.string().describe("The agent name to update"),
        model: z.string().optional().describe("New model (e.g., 'sonnet', 'haiku', 'opus')"),
        enabled: z.boolean().optional().describe("Enable or disable the agent"),
        admin: z.boolean().optional().describe("Grant or revoke admin privileges"),
        working_directory: z.string().optional().describe("Absolute path to the project directory the agent should work in"),
      },
    },
    async ({ agent_name, model, enabled, admin, working_directory }) => {
      try {
        const patch: Record<string, unknown> = {};
        if (model !== undefined) patch.model = model;
        if (enabled !== undefined) patch.enabled = enabled;
        if (admin !== undefined) patch.admin = admin;
        if (working_directory !== undefined) patch.workingDirectory = working_directory;

        const data = await bridgePatch(`/admin/agents/${encodeURIComponent(agent_name)}`, patch);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Failed to update agent: ${message}` }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "rondel_create_org",
    {
      description:
        "Create a new organization in Rondel. Scaffolds the org directory with org.json and " +
        "shared context structure. Agents can then be added to this org using rondel_add_agent " +
        "with the org parameter. Confirm with the user before creating.",
      inputSchema: {
        org_name: z.string().describe("Unique organization name (letters, numbers, hyphens, underscores)"),
        display_name: z.string().optional().describe("Human-readable display name for the organization"),
      },
    },
    async ({ org_name, display_name }) => {
      try {
        const data = await bridgePost("/admin/orgs", { org_name, display_name });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Failed to create org: ${message}` }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "rondel_reload",
    {
      description:
        "Trigger a full config reload. Discovers new orgs and agents added to the workspaces directory " +
        "and starts them. Also refreshes config for existing agents.",
      inputSchema: {},
    },
    async () => {
      try {
        const data = await bridgePost("/admin/reload", {});
        return {
          content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Failed to reload: ${message}` }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "rondel_delete_agent",
    {
      description:
        "Delete a Rondel agent permanently. Stops its Telegram bot, kills active conversations, " +
        "and removes the agent directory from disk. This is irreversible. " +
        "IMPORTANT: Confirm with the user before calling this — explain what will be deleted and that it cannot be undone.",
      inputSchema: {
        agent_name: z.string().describe("The agent name to delete"),
      },
    },
    async ({ agent_name }) => {
      try {
        const data = await bridgeDelete(`/admin/agents/${encodeURIComponent(agent_name)}`);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Failed to delete agent: ${message}` }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "rondel_heartbeat_read_all",
    {
      description:
        "Read the current fleet heartbeats for an org. Admin-only today; will widen to orchestrator agents " +
        "in a future release. Returns per-agent records (status, currentTask, age, health) plus a list of " +
        "agents in scope that have no heartbeat yet, plus a summary count by health tier " +
        "(healthy/stale/down/missing).\n\n" +
        "Use this to answer 'who's alive, who's stuck, who's missing?' across the team.",
      inputSchema: {
        org: z.string().optional().describe(
          "Target org name (or 'global' for unaffiliated agents). Defaults to 'global'.",
        ),
      },
    },
    async ({ org }) => {
      try {
        const params = new URLSearchParams();
        params.set("callerAgent", PARENT_AGENT);
        params.set("isAdmin", "true");
        const target = org ?? "global";
        const data = await bridgeCall(`/heartbeats/${encodeURIComponent(target)}?${params.toString()}`);
        return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Failed to read heartbeats: ${message}` }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "rondel_set_env",
    {
      description:
        "Set an environment variable in Rondel's .env file. Use for API keys, bot tokens, " +
        "and secrets. Takes effect immediately for new processes. Confirm with the user before " +
        "setting secrets.",
      inputSchema: {
        key: z.string().describe("Environment variable name (uppercase, e.g., SOME_API_KEY)"),
        value: z.string().describe("The value to set"),
      },
    },
    async ({ key, value }) => {
      try {
        const data = await bridgePut(`/admin/env`, { key, value });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Failed to set env var: ${message}` }],
          isError: true,
        };
      }
    },
  );
}

// --- Start ---

const transport = new StdioServerTransport();
await server.connect(transport);
