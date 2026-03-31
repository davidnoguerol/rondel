/**
 * Zod schemas for bridge admin endpoint validation.
 *
 * Validates request bodies at the HTTP boundary before they reach
 * AdminApi business logic. Replaces manual property checks with
 * structured validation that produces clear error messages.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Reusable field validators
// ---------------------------------------------------------------------------

const agentName = z.string().regex(
  /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/,
  "Must start with a letter/number and contain only letters, numbers, hyphens, underscores",
);

const botToken = z.string().regex(
  /^\d+:.+$/,
  "Expected Telegram bot token format (e.g., 123456:ABC...)",
);

const envKey = z.string().regex(
  /^[A-Z_][A-Z0-9_]*$/,
  "Must be uppercase letters, digits, and underscores (e.g., BOT_TOKEN)",
);

// ---------------------------------------------------------------------------
// Admin endpoint schemas
// ---------------------------------------------------------------------------

/** POST /admin/agents */
export const AddAgentSchema = z.object({
  agent_name: agentName,
  bot_token: botToken,
  model: z.string().optional(),
  location: z.string().optional(),
  working_directory: z.string().optional(),
});
export type AddAgentInput = z.infer<typeof AddAgentSchema>;

/** PATCH /admin/agents/:name */
export const UpdateAgentSchema = z.object({
  model: z.string().optional(),
  enabled: z.boolean().optional(),
  admin: z.boolean().optional(),
  workingDirectory: z.string().nullable().optional(),
});
export type UpdateAgentInput = z.infer<typeof UpdateAgentSchema>;

/** POST /admin/orgs */
export const AddOrgSchema = z.object({
  org_name: agentName,
  display_name: z.string().optional(),
});
export type AddOrgInput = z.infer<typeof AddOrgSchema>;

/** PUT /admin/env */
export const SetEnvSchema = z.object({
  key: envKey,
  value: z.string(),
});
export type SetEnvInput = z.infer<typeof SetEnvSchema>;

// ---------------------------------------------------------------------------
// Inter-agent messaging schemas
// ---------------------------------------------------------------------------

/** POST /messages/send */
export const SendMessageSchema = z.object({
  from: agentName,
  to: agentName,
  content: z.string().min(1, "Message content must not be empty"),
  reply_to_chat_id: z.string().min(1),
});
export type SendMessageInput = z.infer<typeof SendMessageSchema>;

// ---------------------------------------------------------------------------
// Validation helper
// ---------------------------------------------------------------------------

/**
 * Parse a request body against a schema.
 * Returns { success: true, data } or { success: false, error } with
 * a formatted error message suitable for HTTP 400 responses.
 */
export function validateBody<T>(schema: z.ZodType<T>, body: unknown): { success: true; data: T } | { success: false; error: string } {
  const result = schema.safeParse(body);
  if (result.success) {
    return { success: true, data: result.data };
  }

  // Format Zod issues into a human-readable string
  const issues = result.error.issues.map((issue) => {
    const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
    return `${path}${issue.message}`;
  });

  return { success: false, error: issues.join("; ") };
}
