/**
 * Pure message-shape helpers for the Rondel chat runtime.
 *
 * Extracted from rondel-runtime.tsx so they can be unit-tested without
 * mounting React. The runtime re-imports — one source of truth.
 */

import type { AppendMessage, ThreadMessageLike } from "@assistant-ui/react";

import type { DisplayMessage } from "./fold-frame";

/**
 * Map our internal `DisplayMessage` to assistant-ui's
 * `ThreadMessageLike`. Streaming assistant messages get `running`
 * status so the composer shows a cancel affordance; finished
 * assistant messages get `complete` / `stop`. User messages don't
 * carry status.
 */
export function convertMessage(m: DisplayMessage): ThreadMessageLike {
  if (m.role === "assistant") {
    return {
      id: m.id,
      role: "assistant",
      content: [{ type: "text", text: m.text }],
      createdAt: m.ts ? new Date(m.ts) : undefined,
      status: m.streaming
        ? { type: "running" }
        : { type: "complete", reason: "stop" },
    };
  }
  return {
    id: m.id,
    role: "user",
    content: [{ type: "text", text: m.text }],
    createdAt: m.ts ? new Date(m.ts) : undefined,
  };
}

/**
 * Collapse an `AppendMessage` payload down to a single string.
 * Handles both the shorthand (`content` is a raw string) and the
 * structured form (`content` is an array of `{ type, text }` parts).
 * Non-text parts are ignored; non-string `text` fields are skipped.
 */
export function extractText(message: AppendMessage): string {
  if (typeof message.content === "string") return message.content;
  const parts: string[] = [];
  for (const part of message.content) {
    if (part.type === "text" && typeof part.text === "string") {
      parts.push(part.text);
    }
  }
  return parts.join("");
}
