/**
 * rondel_write_file — first-class file write with staleness, secret-scan,
 * safe-zone, and file-history backup.
 *
 * Replaces the Phase 2 inline `rondel_write_file` that lived in
 * mcp-server.ts. Runs in the per-agent MCP server process, so the actual
 * fs.writeFile is Node calling the OS — outside Claude Code's protected-
 * path gate.
 *
 * Safety layers (all consult the shared daemon state via HTTP):
 *  1. Path validation: absolute, no UNC, no null bytes.
 *  2. Staleness: if the file exists, rondel_read_file must have been called
 *     on it in the same session AND the on-disk hash must match the recorded
 *     read hash. If not, escalate as `write_without_read`.
 *  3. Secret scanner: escalate as `potential_secret_in_content` if the
 *     content looks like a credential (AWS key, GitHub token, etc.).
 *  4. Safe-zone classification: escalate as `write_outside_safezone` if
 *     the target isn't under the agent dir, rondel home, or /tmp.
 *  5. Backup: capture the pre-image in the daemon's FileHistoryStore
 *     before overwriting. Never skipped.
 *  6. Atomic write: fs.writeFile via atomicWriteFile semantics.
 *
 * Successful writes register a new read-state record so subsequent writes
 * in the same session don't trigger write_without_read against what's
 * effectively the agent's own most-recent content.
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
  "Write a UTF-8 text file. Safe-by-default: before overwriting an existing file, " +
  "rondel_read_file must have been called on it in the same session. Paths outside " +
  "safe zones (your agent dir, Rondel home, /tmp), content that looks like a leaked " +
  "credential, and any drift since the recorded read all escalate to human approval. " +
  "Successful overwrites always create a pre-image backup first (state/file-history/). " +
  "New files may be created without a prior read. Prefer this over the native Write " +
  "tool — Write will be disallowed in a future Rondel release.";

function safeZoneCtx(agentDir: string | undefined): { agentDir?: string; rondelHome: string } {
  const rondelHome = process.env.RONDEL_HOME
    ? pathResolve(process.env.RONDEL_HOME, "workspaces")
    : pathResolve(homedir(), ".rondel", "workspaces");
  return agentDir ? { agentDir, rondelHome } : { rondelHome };
}

export function registerWriteFileTool(server: McpServer): void {
  server.registerTool(
    "rondel_write_file",
    {
      description: DESCRIPTION,
      inputSchema: {
        path: z.string().describe("Absolute path to write to"),
        content: z.string().describe("Full content to write (replaces existing content)"),
      },
    },
    async ({ path, content }) => {
      const ctxResult = resolveFilesystemContext(process.env);
      if (!ctxResult.ok) return toolError(ctxResult.error);
      const ctx = ctxResult.ctx;

      const pathCheck = validateAbsolutePath(path);
      if (!pathCheck.ok) return toolError(pathCheck.error);
      const absPath = pathCheck.path;

      const startMs = Date.now();
      const toolInput = { path: absPath, content };

      try {
        // 1. Does the file exist?
        let existedBefore = false;
        let oldContent: string | undefined;
        let oldContentHash: string | undefined;
        try {
          const s = await stat(absPath);
          if (!s.isFile()) {
            return toolError(`Path exists but is not a regular file: ${absPath}`);
          }
          existedBefore = true;
          oldContent = await readFile(absPath, "utf-8");
          oldContentHash = contentHash(oldContent);
        } catch {
          // File doesn't exist — creating new, skip staleness check.
        }

        // 2. Staleness check (only if file exists).
        //    First escalation reason we encounter wins; later checks layer
        //    on top only if allowed through.
        let escalationReason:
          | "write_without_read"
          | "potential_secret_in_content"
          | "write_outside_safezone"
          | undefined;

        if (existedBefore && oldContent !== undefined && oldContentHash !== undefined) {
          const record = await readFileStateGet(ctx, absPath);
          if (!record) {
            escalationReason = "write_without_read";
          } else {
            if (record.contentHash !== oldContentHash) {
              escalationReason = "write_without_read";
            }
          }
        }

        // 3. Secret scan.
        if (!escalationReason && scanForSecrets(content).length > 0) {
          escalationReason = "potential_secret_in_content";
        }

        // 4. Safe-zone check — rondel_write_file has its own tool
        //    identity, not one of Claude's native names.
        if (!escalationReason) {
          const safeZone = safeZoneCtx(process.env.RONDEL_AGENT_DIR);
          if (!isPathInSafeZone(absPath, safeZone)) {
            escalationReason = "write_outside_safezone";
          }
        }

        // 5. Approval if any escalation raised.
        if (escalationReason) {
          const approval = await requestApprovalAndWait(
            ctx,
            "rondel_write_file",
            // Send a bounded preview to the operator — full content
            // is huge in the common case.
            { path: absPath, content_preview: content.slice(0, 500), content_bytes: content.length },
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

          // 5a. TOCTOU guard — approval waits can be up to 30 min. If the
          //     file on disk changed during that window, the backup we'd
          //     create is stale and we'd silently clobber a concurrent edit.
          //     Re-read and require a match against the pre-approval hash.
          //     Only relevant when the file existed at approval time — for
          //     fresh creates there's nothing to protect.
          if (existedBefore && oldContentHash !== undefined) {
            let postApprovalContent: string;
            try {
              postApprovalContent = await readFile(absPath, "utf-8");
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              const errMsg = `File disappeared after approval was granted: ${message}. Call rondel_read_file again and retry.`;
              await emitToolCall(ctx, {
                toolName: "rondel_write_file",
                toolInput,
                summary: summarizeToolUse("rondel_write_file", toolInput),
                outcome: "error",
                durationMs: Date.now() - startMs,
                error: errMsg,
              });
              return toolError(errMsg);
            }
            if (contentHash(postApprovalContent) !== oldContentHash) {
              const errMsg =
                "File changed after approval was granted. Call rondel_read_file again and retry.";
              await emitToolCall(ctx, {
                toolName: "rondel_write_file",
                toolInput,
                summary: summarizeToolUse("rondel_write_file", toolInput),
                outcome: "error",
                durationMs: Date.now() - startMs,
                error: errMsg,
              });
              return toolError(errMsg);
            }
          }
        }

        // 6. Backup before overwrite (route through daemon so it owns on-disk layout).
        let backupId: string | null = null;
        if (existedBefore && oldContent !== undefined) {
          try {
            backupId = await createBackup(ctx, absPath, oldContent);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            await emitToolCall(ctx, {
              toolName: "rondel_write_file",
              toolInput,
              summary: summarizeToolUse("rondel_write_file", toolInput),
              outcome: "error",
              durationMs: Date.now() - startMs,
              error: `backup failed: ${message}`,
            });
            return toolError(`Backup failed before write — not touching the file: ${message}`);
          }
        }

        // 7. Atomic write.
        await atomicWriteFile(absPath, content);

        // 8. Register the post-write content as the new read-state. Keeps
        //    the staleness invariant consistent for subsequent writes in
        //    the same session.
        await readFileStateRecord(ctx, absPath, contentHash(content));

        const operation = existedBefore ? "update" : "create";
        await emitToolCall(ctx, {
          toolName: "rondel_write_file",
          toolInput,
          summary: summarizeToolUse("rondel_write_file", toolInput),
          outcome: "success",
          durationMs: Date.now() - startMs,
        });

        return toolJson({
          operation,
          path: absPath,
          backupId,
          bytesWritten: Buffer.byteLength(content, "utf-8"),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await emitToolCall(ctx, {
          toolName: "rondel_write_file",
          toolInput,
          summary: summarizeToolUse("rondel_write_file", toolInput),
          outcome: "error",
          durationMs: Date.now() - startMs,
          error: message,
        });
        return toolError(message);
      }
    },
  );
}
