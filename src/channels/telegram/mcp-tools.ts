import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";

/**
 * Telegram-specific MCP tool registration.
 *
 * This module owns all Telegram HTTP protocol knowledge used by the
 * per-agent MCP server. The core MCP server (src/bridge/mcp-server.ts)
 * stays channel-agnostic and simply calls `registerTelegramTools(server)`.
 *
 * Any future channel that exposes MCP tools follows the same pattern:
 * `registerSlackTools(server)`, `registerDiscordTools(server)`, etc.
 *
 * Note: `TelegramAccount.apiCall` in ./adapter.ts also talks to the
 * Telegram HTTP API, but with inbound-reply markdown-fallback behavior.
 * The two are intentionally kept separate for now — consolidation can
 * happen once the shared shape stabilizes across more channels.
 */

const TELEGRAM_API = "https://api.telegram.org/bot";
const MAX_MESSAGE_LENGTH = 4096;

/**
 * Register Telegram MCP tools on the given server.
 *
 * No-op if `RONDEL_CHANNEL_TELEGRAM_TOKEN` is not set — agents on other
 * channels should not be forced to provide a Telegram token. A warning
 * is emitted once to stderr so misconfiguration is visible in logs.
 */
export function registerTelegramTools(server: McpServer): void {
  const botToken = process.env.RONDEL_CHANNEL_TELEGRAM_TOKEN;
  if (!botToken) {
    process.stderr.write(
      "[telegram-mcp] RONDEL_CHANNEL_TELEGRAM_TOKEN not set — rondel_send_telegram* tools unavailable\n",
    );
    return;
  }

  const baseUrl = `${TELEGRAM_API}${botToken}`;

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
    if (text.length <= MAX_MESSAGE_LENGTH) {
      await telegramCall("sendMessage", { chat_id: chatId, text, parse_mode: "Markdown" });
      return;
    }

    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= MAX_MESSAGE_LENGTH) {
        await telegramCall("sendMessage", { chat_id: chatId, text: remaining, parse_mode: "Markdown" });
        break;
      }
      let breakPoint = remaining.lastIndexOf("\n", MAX_MESSAGE_LENGTH);
      if (breakPoint < MAX_MESSAGE_LENGTH * 0.5) breakPoint = remaining.lastIndexOf(" ", MAX_MESSAGE_LENGTH);
      if (breakPoint < MAX_MESSAGE_LENGTH * 0.5) breakPoint = MAX_MESSAGE_LENGTH;
      await telegramCall("sendMessage", {
        chat_id: chatId,
        text: remaining.slice(0, breakPoint),
        parse_mode: "Markdown",
      });
      remaining = remaining.slice(breakPoint).trimStart();
    }
  }

  async function sendTelegramPhoto(chatId: string, imagePath: string, caption?: string): Promise<void> {
    const absolutePath = resolve(imagePath);
    const imageData = await readFile(absolutePath);

    const ext = absolutePath.split(".").pop()?.toLowerCase() ?? "png";
    const mimeTypes: Record<string, string> = {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      gif: "image/gif",
      webp: "image/webp",
    };
    const mimeType = mimeTypes[ext] ?? "image/png";

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

  server.registerTool(
    "rondel_send_telegram",
    {
      description:
        "Send a text message to a Telegram chat. Use this to proactively send messages, notifications, or follow-ups.",
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
}
