import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";

const TELEGRAM_API = "https://api.telegram.org/bot";

const BOT_TOKEN = process.env.RONDEL_CHANNEL_TELEGRAM_TOKEN;
if (!BOT_TOKEN) {
  process.stderr.write("RONDEL_CHANNEL_TELEGRAM_TOKEN is required\n");
  process.exit(1);
}

const BRIDGE_URL = process.env.RONDEL_BRIDGE_URL ?? "";
const PARENT_AGENT = process.env.RONDEL_PARENT_AGENT ?? "";
const PARENT_CHANNEL_TYPE = process.env.RONDEL_PARENT_CHANNEL_TYPE || "internal";
const PARENT_ACCOUNT_ID = process.env.RONDEL_PARENT_ACCOUNT_ID || PARENT_AGENT;
const PARENT_CHAT_ID = process.env.RONDEL_PARENT_CHAT_ID ?? "";
const IS_ADMIN = process.env.RONDEL_AGENT_ADMIN === "1";

const baseUrl = `${TELEGRAM_API}${BOT_TOKEN}`;

// --- Telegram API helpers ---

async function telegramCall(method: string, params: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(`${baseUrl}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Telegram ${method} error ${response.status}: ${text}`);
  }

  const data = (await response.json()) as { ok: boolean; result?: unknown };
  if (!data.ok) {
    throw new Error(`Telegram ${method} returned ok=false`);
  }

  return data.result;
}

async function sendTelegramText(chatId: string, text: string): Promise<void> {
  // Chunk if needed (Telegram 4096 char limit)
  const MAX = 4096;
  if (text.length <= MAX) {
    await telegramCall("sendMessage", { chat_id: chatId, text, parse_mode: "Markdown" });
    return;
  }

  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= MAX) {
      await telegramCall("sendMessage", { chat_id: chatId, text: remaining, parse_mode: "Markdown" });
      break;
    }
    let breakPoint = remaining.lastIndexOf("\n", MAX);
    if (breakPoint < MAX * 0.5) breakPoint = remaining.lastIndexOf(" ", MAX);
    if (breakPoint < MAX * 0.5) breakPoint = MAX;
    await telegramCall("sendMessage", { chat_id: chatId, text: remaining.slice(0, breakPoint), parse_mode: "Markdown" });
    remaining = remaining.slice(breakPoint).trimStart();
  }
}

async function sendTelegramPhoto(chatId: string, imagePath: string, caption?: string): Promise<void> {
  const absolutePath = resolve(imagePath);
  const imageData = await readFile(absolutePath);

  // Detect mime type from extension
  const ext = absolutePath.split(".").pop()?.toLowerCase() ?? "png";
  const mimeTypes: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
  };
  const mimeType = mimeTypes[ext] ?? "image/png";

  // Telegram sendPhoto requires multipart/form-data for file uploads
  const formData = new FormData();
  formData.append("chat_id", chatId);
  formData.append("photo", new Blob([imageData], { type: mimeType }), `photo.${ext}`);
  if (caption) {
    formData.append("caption", caption);
  }

  const response = await fetch(`${baseUrl}/sendPhoto`, {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Telegram sendPhoto error ${response.status}: ${text}`);
  }
}

// --- MCP Server ---

const server = new McpServer({
  name: "rondel",
  version: "0.1.0",
  description: "Rondel agent tools — Telegram messaging",
});

server.registerTool(
  "rondel_send_telegram",
  {
    description: "Send a text message to a Telegram chat. Use this to proactively send messages, notifications, or follow-ups.",
    inputSchema: {
      chat_id: z.string().describe("The Telegram chat ID to send the message to"),
      text: z.string().describe("The message text to send (supports Markdown formatting)"),
    },
  },
  async ({ chat_id, text }) => {
    try {
      await sendTelegramText(chat_id, text);
      return {
        content: [{ type: "text" as const, text: `Message sent to chat ${chat_id}` }],
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
  "rondel_send_telegram_photo",
  {
    description: "Send a photo to a Telegram chat. The image must be a local file path.",
    inputSchema: {
      chat_id: z.string().describe("The Telegram chat ID to send the photo to"),
      image_path: z.string().describe("Absolute or relative path to the image file on disk"),
      caption: z.string().optional().describe("Optional caption for the photo"),
    },
  },
  async ({ chat_id, image_path, caption }) => {
    try {
      await sendTelegramPhoto(chat_id, image_path, caption ?? undefined);
      return {
        content: [{ type: "text" as const, text: `Photo sent to chat ${chat_id}` }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: `Failed to send photo: ${message}` }],
        isError: true,
      };
    }
  },
);

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

async function bridgeDelete(path: string): Promise<unknown> {
  if (!BRIDGE_URL) {
    throw new Error("RONDEL_BRIDGE_URL not set — bridge tools unavailable");
  }

  const response = await fetch(`${BRIDGE_URL}${path}`, { method: "DELETE" });
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
      "Spawn an ephemeral subagent to execute a task. This tool returns immediately with the subagent ID. " +
      "The subagent runs in the background. When it completes, the result will be delivered to you " +
      "automatically as a message — do NOT poll with rondel_subagent_status. Just wait for the result " +
      "to arrive. The user will be notified in Telegram that work is being delegated. " +
      "Provide either 'template' (a named template from templates/) or 'system_prompt' (inline instructions).",
    inputSchema: {
      task: z.string().describe("The task for the subagent to execute"),
      template: z.string().optional().describe("Template name from templates/ directory (e.g., 'coder', 'researcher')"),
      system_prompt: z.string().optional().describe("Inline system prompt (alternative to template)"),
      working_directory: z.string().optional().describe("Directory for the subagent to work in"),
      model: z.string().optional().describe("Model override (defaults to parent's model)"),
      max_turns: z.number().optional().describe("Maximum agentic turns before stopping"),
      timeout_ms: z.number().optional().describe("Timeout in milliseconds (default: 300000 = 5 minutes)"),
    },
  },
  async ({ task, template, system_prompt, working_directory, model, max_turns, timeout_ms }) => {
    try {
      if (!template && !system_prompt) {
        return {
          content: [{ type: "text" as const, text: "Error: either 'template' or 'system_prompt' must be provided" }],
          isError: true,
        };
      }

      const data = await bridgePost("/subagents/spawn", {
        task,
        template,
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

// --- System status tool (available to all agents) ---

server.registerTool(
  "rondel_system_status",
  {
    description:
      "Get Rondel system status: all agents, their active conversations, states, and uptime. " +
      "Use this to check system health and see what agents are running.",
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
