/**
 * rondel_read_file — first-class file read with staleness registration.
 *
 * Runs in the per-agent MCP server process (not Claude's code), so the
 * native fs calls here are outside Claude Code's hardcoded protected-path
 * gate. Every successful read registers a (agent, sessionId, path, sha256)
 * record with the daemon — rondel_write_file / rondel_edit_file /
 * rondel_multi_edit_file consult this record before overwriting to enforce
 * the "you must have read the current content in this session" invariant.
 *
 * No approval flow: reads don't write data. Observability via tool_call
 * ledger emit on every completion.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFile, stat } from "node:fs/promises";
import {
  contentHash,
  emitToolCall,
  readFileStateRecord,
  resolveFilesystemContext,
  toolError,
  toolJson,
  validateAbsolutePath,
} from "./_common.js";
import { summarizeToolUse } from "../approvals/tool-summary.js";

const DEFAULT_MAX_BYTES = 1_048_576; // 1 MB
const HARD_MAX_BYTES = 10_485_760; // 10 MB

const DESCRIPTION =
  "Read a UTF-8 text file. REQUIRED before rondel_write_file, rondel_edit_file, " +
  "or rondel_multi_edit_file on the same path — those tools verify you have read " +
  "the current content in the same session and will escalate (or error) otherwise. " +
  `Default size limit ${DEFAULT_MAX_BYTES} bytes (1 MB); larger files are truncated. ` +
  `Pass max_bytes to raise the limit up to ${HARD_MAX_BYTES} bytes (10 MB). ` +
  "Truncated reads do NOT register the staleness anchor — you must re-read with " +
  "a larger max_bytes before writing or editing a truncated file.";

export function registerReadFileTool(server: McpServer): void {
  server.registerTool(
    "rondel_read_file",
    {
      description: DESCRIPTION,
      inputSchema: {
        path: z.string().describe("Absolute path of the file to read"),
        max_bytes: z
          .number()
          .int()
          .min(1)
          .max(HARD_MAX_BYTES)
          .optional()
          .describe(
            `Max bytes to read (default ${DEFAULT_MAX_BYTES}, hard max ${HARD_MAX_BYTES}). ` +
              "Files exceeding the limit are truncated; truncated=true is returned.",
          ),
      },
    },
    async ({ path, max_bytes }) => {
      const ctxResult = resolveFilesystemContext(process.env);
      if (!ctxResult.ok) return toolError(ctxResult.error);
      const ctx = ctxResult.ctx;

      const pathCheck = validateAbsolutePath(path);
      if (!pathCheck.ok) return toolError(pathCheck.error);
      const absPath = pathCheck.path;

      const startMs = Date.now();
      const input = { path: absPath, max_bytes };

      try {
        const s = await stat(absPath);
        if (!s.isFile()) {
          const err = `Not a regular file: ${absPath}`;
          await emitToolCall(ctx, {
            toolName: "rondel_read_file",
            toolInput: input,
            summary: summarizeToolUse("rondel_read_file", input),
            outcome: "error",
            durationMs: Date.now() - startMs,
            error: err,
          });
          return toolError(err);
        }

        const limit = Math.min(max_bytes ?? DEFAULT_MAX_BYTES, HARD_MAX_BYTES);
        const truncated = s.size > limit;
        let content: string;
        if (truncated) {
          const buf = await readFile(absPath);
          content = buf.subarray(0, limit).toString("utf-8");
        } else {
          content = await readFile(absPath, "utf-8");
        }

        // Hash is of the returned content. On a full read, this matches the
        // file's on-disk hash exactly — write/edit staleness checks will pass.
        // On a truncated read we DO NOT register the read, because the agent
        // hasn't actually seen the full file; letting a later write/edit hash
        // the truncated-content would let it bypass staleness against the
        // real on-disk file. The agent must re-read with a larger max_bytes
        // before writing.
        const hash = contentHash(content);

        if (!truncated) {
          try {
            await readFileStateRecord(ctx, absPath, hash);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            await emitToolCall(ctx, {
              toolName: "rondel_read_file",
              toolInput: input,
              summary: summarizeToolUse("rondel_read_file", input),
              outcome: "error",
              durationMs: Date.now() - startMs,
              error: message,
            });
            return toolError(`Read succeeded but read-state registration failed: ${message}`);
          }
        }

        await emitToolCall(ctx, {
          toolName: "rondel_read_file",
          toolInput: input,
          summary: summarizeToolUse("rondel_read_file", input),
          outcome: "success",
          durationMs: Date.now() - startMs,
        });

        return toolJson({
          content,
          size: s.size,
          truncated,
          hash,
          path: absPath,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await emitToolCall(ctx, {
          toolName: "rondel_read_file",
          toolInput: input,
          summary: summarizeToolUse("rondel_read_file", input),
          outcome: "error",
          durationMs: Date.now() - startMs,
          error: message,
        });
        return toolError(message);
      }
    },
  );
}
