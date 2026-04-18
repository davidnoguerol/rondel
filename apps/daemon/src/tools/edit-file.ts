/**
 * rondel_edit_file — single-pattern string replacement with staleness +
 * backup. Differs from rondel_write_file in that it requires a prior read
 * (no escalation, tool_error) because editing a file you haven't read is
 * always a mistake, not a permissions question.
 *
 * Contract:
 *  - `replace_all=false` (default): old_string must occur exactly once.
 *  - `replace_all=true`: old_string must occur at least once, all replaced.
 *
 * Safety layers match rondel_write_file except for:
 *  - Prior-read requirement is hard — tool_error, not escalation.
 *  - Staleness drift (read recorded but file changed on disk) still
 *    escalates; it's the same class of operator-decision.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve as pathResolve } from "node:path";
import { atomicWriteFile } from "../shared/atomic-file.js";
import { isPathInSafeZone, scanForSecrets } from "../shared/safety/index.js";
import {
  contentHash,
  createBackup,
  emitToolCall,
  readFileStateGet,
  readFileStateRecord,
  requestApprovalAndWait,
  resolveFilesystemContext,
  toolError,
  toolJson,
  validateAbsolutePath,
} from "./_common.js";
import { summarizeToolUse } from "../approvals/tool-summary.js";

const DESCRIPTION =
  "Replace a string in an existing file. REQUIRES rondel_read_file on the same path " +
  "earlier in this session — editing without a prior read returns an error (no " +
  "escalation). If replace_all=false (default), old_string must occur exactly once; " +
  "otherwise the tool errors without writing. replace_all=true replaces every " +
  "occurrence. Drift since the recorded read, writes outside safe zones, and content " +
  "that looks like a leaked credential all escalate to human approval. Pre-image " +
  "backup always taken before overwrite. Cannot create new files — use " +
  "rondel_write_file for that.";

function safeZoneCtx(agentDir: string | undefined): { agentDir?: string; rondelHome: string } {
  const rondelHome = process.env.RONDEL_HOME
    ? pathResolve(process.env.RONDEL_HOME, "workspaces")
    : pathResolve(homedir(), ".rondel", "workspaces");
  return agentDir ? { agentDir, rondelHome } : { rondelHome };
}

/** Count non-overlapping occurrences of `needle` in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count++;
    idx += needle.length;
  }
  return count;
}

export function registerEditFileTool(server: McpServer): void {
  server.registerTool(
    "rondel_edit_file",
    {
      description: DESCRIPTION,
      inputSchema: {
        path: z.string().describe("Absolute path of the file to edit"),
        old_string: z.string().min(1).describe("Exact text to find and replace"),
        new_string: z.string().describe("Replacement text"),
        replace_all: z
          .boolean()
          .optional()
          .describe("If true, replace every occurrence. Default false (must match exactly once)."),
      },
    },
    async ({ path, old_string, new_string, replace_all }) => {
      const ctxResult = resolveFilesystemContext(process.env);
      if (!ctxResult.ok) return toolError(ctxResult.error);
      const ctx = ctxResult.ctx;

      const pathCheck = validateAbsolutePath(path);
      if (!pathCheck.ok) return toolError(pathCheck.error);
      const absPath = pathCheck.path;

      const startMs = Date.now();
      const toolInput = { path: absPath, old_string, new_string, replace_all };

      try {
        // 1. File must exist (edit never creates).
        let fileStat;
        try {
          fileStat = await stat(absPath);
        } catch {
          return toolError(`File does not exist: ${absPath}. Use rondel_write_file to create.`);
        }
        if (!fileStat.isFile()) {
          return toolError(`Path is not a regular file: ${absPath}`);
        }

        // 2. Prior-read required (hard error, not escalation).
        const record = await readFileStateGet(ctx, absPath);
        if (!record) {
          return toolError(
            `File has not been read in this session: ${absPath}. ` +
              `Call rondel_read_file first.`,
          );
        }

        // 3. Read current content and validate staleness.
        const oldContent = await readFile(absPath, "utf-8");
        const currentHash = contentHash(oldContent);
        let escalationReason:
          | "write_without_read"
          | "potential_secret_in_content"
          | "write_outside_safezone"
          | undefined;
        if (record.contentHash !== currentHash) {
          escalationReason = "write_without_read";
        }

        // 4. Count occurrences.
        const occurrences = countOccurrences(oldContent, old_string);
        if (replace_all === true) {
          if (occurrences < 1) {
            return toolError(
              `old_string not found in ${absPath} (replace_all=true requires at least 1 match).`,
            );
          }
        } else {
          if (occurrences === 0) {
            return toolError(`old_string not found in ${absPath}.`);
          }
          if (occurrences > 1) {
            return toolError(
              `old_string matches ${occurrences} locations in ${absPath}. ` +
                `Pass replace_all=true to replace all, or make old_string more specific.`,
            );
          }
        }

        // 5. Compute new content. split/join is used in both branches so
        //    `new_string` is always treated as a literal — String.prototype
        //    .replace interprets `$&`, `$1`, etc. as special patterns. The
        //    occurrence-count validation above guarantees correctness for
        //    both replace_all modes.
        const newContent = oldContent.split(old_string).join(new_string);

        // 6. Secret scan on the full post-edit content.
        if (!escalationReason && scanForSecrets(newContent).length > 0) {
          escalationReason = "potential_secret_in_content";
        }

        // 7. Safe-zone check.
        if (!escalationReason) {
          const safeZone = safeZoneCtx(process.env.RONDEL_AGENT_DIR);
          if (!isPathInSafeZone(absPath, safeZone)) {
            escalationReason = "write_outside_safezone";
          }
        }

        // 8. Approval if needed.
        if (escalationReason) {
          const approval = await requestApprovalAndWait(
            ctx,
            "rondel_edit_file",
            {
              path: absPath,
              old_string_preview: old_string.slice(0, 200),
              new_string_preview: new_string.slice(0, 200),
              replace_all: replace_all === true,
            },
            escalationReason,
          );
          if (approval.kind !== "allow") {
            const msg =
              approval.kind === "timeout"
                ? "Approval timed out after 30 min."
                : approval.kind === "deny"
                  ? `Denied by operator${approval.resolvedBy ? ` (${approval.resolvedBy})` : ""}.`
                  : approval.message;
            return toolError(`${msg} File not written.`);
          }

          // 8a. TOCTOU guard — approval waits can be 30 min long. An external
          //     process could have rewritten the file in the meantime, invalidating
          //     both the computed patch and the snapshot we'd back up. Re-read and
          //     abort if the content drifted.
          let postApprovalContent: string;
          try {
            postApprovalContent = await readFile(absPath, "utf-8");
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            const errMsg = `File disappeared after approval was granted: ${message}. Call rondel_read_file again and retry.`;
            await emitToolCall(ctx, {
              toolName: "rondel_edit_file",
              toolInput,
              summary: summarizeToolUse("rondel_edit_file", toolInput),
              outcome: "error",
              durationMs: Date.now() - startMs,
              error: errMsg,
            });
            return toolError(errMsg);
          }
          if (contentHash(postApprovalContent) !== currentHash) {
            const errMsg =
              "File changed after approval was granted. Call rondel_read_file again and retry.";
            await emitToolCall(ctx, {
              toolName: "rondel_edit_file",
              toolInput,
              summary: summarizeToolUse("rondel_edit_file", toolInput),
              outcome: "error",
              durationMs: Date.now() - startMs,
              error: errMsg,
            });
            return toolError(errMsg);
          }
        }

        // 9. Backup.
        let backupId: string;
        try {
          backupId = await createBackup(ctx, absPath, oldContent);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await emitToolCall(ctx, {
            toolName: "rondel_edit_file",
            toolInput,
            summary: summarizeToolUse("rondel_edit_file", toolInput),
            outcome: "error",
            durationMs: Date.now() - startMs,
            error: `backup failed: ${message}`,
          });
          return toolError(`Backup failed before write — not touching the file: ${message}`);
        }

        // 10. Write + update read-state.
        await atomicWriteFile(absPath, newContent);
        await readFileStateRecord(ctx, absPath, contentHash(newContent));

        const replacedCount = replace_all === true ? occurrences : 1;
        await emitToolCall(ctx, {
          toolName: "rondel_edit_file",
          toolInput,
          summary: summarizeToolUse("rondel_edit_file", toolInput),
          outcome: "success",
          durationMs: Date.now() - startMs,
        });

        return toolJson({
          path: absPath,
          replacedCount,
          backupId,
          bytesWritten: Buffer.byteLength(newContent, "utf-8"),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await emitToolCall(ctx, {
          toolName: "rondel_edit_file",
          toolInput,
          summary: summarizeToolUse("rondel_edit_file", toolInput),
          outcome: "error",
          durationMs: Date.now() - startMs,
          error: message,
        });
        return toolError(message);
      }
    },
  );
}
