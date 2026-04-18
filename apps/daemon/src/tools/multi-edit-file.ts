/**
 * rondel_multi_edit_file — atomic multi-edit. All edits succeed or none
 * are written. Same prior-read requirement, safety layers, and backup
 * behaviour as rondel_edit_file.
 *
 * Each edit applies against the in-memory buffer produced by the prior
 * edits, not against the original file content. If any edit's validation
 * fails (zero matches, too-many matches on replace_all=false), the whole
 * operation errors with the failing edit's index — nothing is written.
 *
 * Exactly one backup is captured (of the pre-edit on-disk content) and
 * one tool_call event is emitted for the entire operation.
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
  "Apply multiple string replacements to a file atomically. REQUIRES rondel_read_file " +
  "on the same path earlier in this session. Each edit applies against the result of " +
  "prior edits (in order). If ANY edit fails validation (wrong number of matches), " +
  "nothing is written and the index of the failing edit is reported. Safety layers " +
  "(staleness, safe-zone, secret scan) apply to the combined post-edit content. One " +
  "pre-image backup is captured for the whole operation.";

function safeZoneCtx(agentDir: string | undefined): { agentDir?: string; rondelHome: string } {
  const rondelHome = process.env.RONDEL_HOME
    ? pathResolve(process.env.RONDEL_HOME, "workspaces")
    : pathResolve(homedir(), ".rondel", "workspaces");
  return agentDir ? { agentDir, rondelHome } : { rondelHome };
}

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

export function registerMultiEditFileTool(server: McpServer): void {
  server.registerTool(
    "rondel_multi_edit_file",
    {
      description: DESCRIPTION,
      inputSchema: {
        path: z.string().describe("Absolute path of the file to edit"),
        edits: z
          .array(
            z.object({
              old_string: z.string().min(1),
              new_string: z.string(),
              replace_all: z.boolean().optional(),
            }),
          )
          .min(1)
          .describe("Edits to apply in order. Each is evaluated against the result of prior edits."),
      },
    },
    async ({ path, edits }) => {
      const ctxResult = resolveFilesystemContext(process.env);
      if (!ctxResult.ok) return toolError(ctxResult.error);
      const ctx = ctxResult.ctx;

      const pathCheck = validateAbsolutePath(path);
      if (!pathCheck.ok) return toolError(pathCheck.error);
      const absPath = pathCheck.path;

      const startMs = Date.now();
      const toolInput = { path: absPath, edits };

      try {
        // 1. File must exist.
        let fileStat;
        try {
          fileStat = await stat(absPath);
        } catch {
          return toolError(`File does not exist: ${absPath}. Use rondel_write_file to create.`);
        }
        if (!fileStat.isFile()) {
          return toolError(`Path is not a regular file: ${absPath}`);
        }

        // 2. Prior-read required.
        const record = await readFileStateGet(ctx, absPath);
        if (!record) {
          return toolError(
            `File has not been read in this session: ${absPath}. Call rondel_read_file first.`,
          );
        }

        // 3. Read content and check staleness.
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

        // 4. Apply edits in order against an in-memory buffer. Validate
        //    each; bail with the failing index on first failure.
        let buffer = oldContent;
        let totalReplacements = 0;
        for (let i = 0; i < edits.length; i++) {
          const e = edits[i];
          const occurrences = countOccurrences(buffer, e.old_string);
          if (e.replace_all === true) {
            if (occurrences < 1) {
              return toolError(
                `Edit #${i} failed: old_string not found after prior edits ` +
                  `(replace_all=true requires at least 1 match).`,
              );
            }
            buffer = buffer.split(e.old_string).join(e.new_string);
            totalReplacements += occurrences;
          } else {
            if (occurrences === 0) {
              return toolError(`Edit #${i} failed: old_string not found after prior edits.`);
            }
            if (occurrences > 1) {
              return toolError(
                `Edit #${i} failed: old_string matches ${occurrences} locations. ` +
                  `Make it more specific, or set replace_all=true for this edit.`,
              );
            }
            // split/join to treat new_string as a literal; replace() would
            // interpret `$&`, `$1`, etc. as pattern references.
            buffer = buffer.split(e.old_string).join(e.new_string);
            totalReplacements += 1;
          }
        }

        // 5. Secret scan on combined result.
        if (!escalationReason && scanForSecrets(buffer).length > 0) {
          escalationReason = "potential_secret_in_content";
        }

        // 6. Safe-zone check.
        if (!escalationReason) {
          const safeZone = safeZoneCtx(process.env.RONDEL_AGENT_DIR);
          if (!isPathInSafeZone(absPath, safeZone)) {
            escalationReason = "write_outside_safezone";
          }
        }

        // 7. Approval.
        if (escalationReason) {
          const approval = await requestApprovalAndWait(
            ctx,
            "rondel_multi_edit_file",
            { path: absPath, edit_count: edits.length },
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

          // 7a. TOCTOU guard — re-read after the approval wait. If the on-
          //     disk content drifted while we were waiting, the edits we
          //     computed in-memory against `oldContent` are no longer valid.
          let postApprovalContent: string;
          try {
            postApprovalContent = await readFile(absPath, "utf-8");
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            const errMsg = `File disappeared after approval was granted: ${message}. Call rondel_read_file again and retry.`;
            await emitToolCall(ctx, {
              toolName: "rondel_multi_edit_file",
              toolInput,
              summary: summarizeToolUse("rondel_multi_edit_file", toolInput),
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
              toolName: "rondel_multi_edit_file",
              toolInput,
              summary: summarizeToolUse("rondel_multi_edit_file", toolInput),
              outcome: "error",
              durationMs: Date.now() - startMs,
              error: errMsg,
            });
            return toolError(errMsg);
          }
        }

        // 8. Backup.
        let backupId: string;
        try {
          backupId = await createBackup(ctx, absPath, oldContent);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await emitToolCall(ctx, {
            toolName: "rondel_multi_edit_file",
            toolInput,
            summary: summarizeToolUse("rondel_multi_edit_file", toolInput),
            outcome: "error",
            durationMs: Date.now() - startMs,
            error: `backup failed: ${message}`,
          });
          return toolError(`Backup failed before write — not touching the file: ${message}`);
        }

        // 9. Write + register read-state.
        await atomicWriteFile(absPath, buffer);
        await readFileStateRecord(ctx, absPath, contentHash(buffer));

        await emitToolCall(ctx, {
          toolName: "rondel_multi_edit_file",
          toolInput,
          summary: summarizeToolUse("rondel_multi_edit_file", toolInput),
          outcome: "success",
          durationMs: Date.now() - startMs,
        });

        return toolJson({
          path: absPath,
          editCount: edits.length,
          totalReplacements,
          backupId,
          bytesWritten: Buffer.byteLength(buffer, "utf-8"),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await emitToolCall(ctx, {
          toolName: "rondel_multi_edit_file",
          toolInput,
          summary: summarizeToolUse("rondel_multi_edit_file", toolInput),
          outcome: "error",
          durationMs: Date.now() - startMs,
          error: message,
        });
        return toolError(message);
      }
    },
  );
}
