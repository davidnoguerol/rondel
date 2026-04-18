/**
 * rondel_bash — Rondel's first-class shell tool.
 *
 * Runs in the per-agent MCP server process (spawned by Claude CLI, not
 * Claude's code), so `child_process.spawn("bash", ...)` here is just
 * Node — outside Claude Code's hardcoded protected-path / bash
 * validation surface. Safety routes through the shared
 * `shared/safety` classifier and the existing ApprovalService (HTTP
 * bridge POST /approvals/tool-use + polling), matching the existing
 * `rondel_write_file` pattern.
 *
 * Every completion (success AND error) emits a `tool_call` ledger
 * event via POST /ledger/tool-call — providing the observability
 * substrate that native Bash calls lack today.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { classifyBash } from "../shared/safety/index.js";
import { summarizeToolUse } from "../approvals/tool-summary.js";
import {
  emitToolCall,
  requestApprovalAndWait,
  resolveBridgeContext,
  toolError,
} from "./_common.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 120_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 600_000;

const OUTPUT_TRUNCATE_AT = 100_000;
const STDERR_FOR_ERROR_MAX = 500;

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/** Clamp a timeout value into the tool's supported range. */
export function clampTimeoutMs(requested: number | undefined): number {
  const base = typeof requested === "number" && Number.isFinite(requested)
    ? Math.floor(requested)
    : DEFAULT_TIMEOUT_MS;
  if (base < MIN_TIMEOUT_MS) return MIN_TIMEOUT_MS;
  if (base > MAX_TIMEOUT_MS) return MAX_TIMEOUT_MS;
  return base;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface BashInput {
  readonly command: string;
  readonly working_directory?: string;
  readonly timeout_ms?: number;
}

interface SpawnResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly truncated: boolean;
  readonly spawnError?: string;
  readonly timedOut: boolean;
  readonly durationMs: number;
}

/** Spawn bash -c and collect output with a hard timeout. */
function execBashWithTimeout(
  command: string,
  workingDirectory: string | undefined,
  timeoutMs: number,
): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;

    let child;
    try {
      child = spawn("bash", ["-c", command], {
        cwd: workingDirectory,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      resolve({
        stdout: "",
        stderr: "",
        exitCode: null,
        signal: null,
        truncated: false,
        spawnError: message,
        timedOut: false,
        durationMs: Date.now() - startedAt,
      });
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");

    child.stdout.on("data", (chunk: string) => {
      if (stdoutTruncated) return;
      if (stdout.length + chunk.length > OUTPUT_TRUNCATE_AT) {
        stdout += chunk.slice(0, OUTPUT_TRUNCATE_AT - stdout.length);
        stdoutTruncated = true;
      } else {
        stdout += chunk;
      }
    });
    child.stderr.on("data", (chunk: string) => {
      if (stderrTruncated) return;
      if (stderr.length + chunk.length > OUTPUT_TRUNCATE_AT) {
        stderr += chunk.slice(0, OUTPUT_TRUNCATE_AT - stderr.length);
        stderrTruncated = true;
      } else {
        stderr += chunk;
      }
    });

    child.on("error", (err: Error) => {
      clearTimeout(timer);
      resolve({
        stdout,
        stderr,
        exitCode: null,
        signal: null,
        truncated: stdoutTruncated || stderrTruncated,
        spawnError: err.message,
        timedOut,
        durationMs: Date.now() - startedAt,
      });
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        stdout,
        stderr,
        exitCode: code,
        signal,
        truncated: stdoutTruncated || stderrTruncated,
        timedOut,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

const BASH_DESCRIPTION =
  "Execute a shell command. Rondel's first-class shell tool with built-in safety " +
  "classification.\n\n" +
  "- Dangerous patterns (rm -rf /, dd, mkfs, curl|sh, etc.) escalate to human " +
  "approval via Telegram/web-UI before running.\n" +
  "- Writes into system paths (/etc, /usr, /bin, etc.) similarly escalate.\n" +
  "- Safe commands run immediately.\n\n" +
  "Always prefer this tool over native Bash — the native Bash tool will be " +
  "disallowed in a future Rondel release. Working directory and timeout are " +
  "configurable.";

export function registerBashTool(server: McpServer): void {
  server.registerTool(
    "rondel_bash",
    {
      description: BASH_DESCRIPTION,
      inputSchema: {
        command: z.string().min(1).describe("The shell command to execute (passed to bash -c)"),
        working_directory: z.string().optional().describe("Absolute path for cwd (must exist)"),
        timeout_ms: z.number().int().optional().describe("Timeout (default 120000, clamped to [1000, 600000])"),
      },
    },
    async ({ command, working_directory, timeout_ms }) => {
      const input: BashInput = {
        command,
        working_directory,
        timeout_ms,
      };

      // 1. Bridge context required — if absent the agent isn't running
      //    under a Rondel daemon and the tool can't route approvals or
      //    emit ledger events. Fail loudly.
      const ctx = resolveBridgeContext(process.env);
      if (!ctx) {
        return toolError(
          "rondel_bash requires bridge context. Is the agent running under Rondel?",
        );
      }

      // 2. Validate working_directory before anything else — cheap
      //    early rejection. No ledger emit here: the tool never attempted
      //    to execute.
      if (working_directory !== undefined) {
        if (!isAbsolute(working_directory)) {
          return toolError(
            `working_directory must be an absolute path, got: ${working_directory}`,
          );
        }
        if (!existsSync(working_directory)) {
          return toolError(
            `working_directory does not exist: ${working_directory}`,
          );
        }
      }

      // 3. Classify. `classifyBash` returns allow/escalate; there is no
      //    deny branch in the current safety module, but we guard
      //    defensively in case it's added later.
      const classification = classifyBash(command);

      if (classification.classification === "escalate") {
        const approval = await requestApprovalAndWait(
          ctx,
          "rondel_bash",
          input,
          classification.reason ?? "unknown_tool",
        );
        if (approval.kind !== "allow") {
          // No ledger emit: the tool did not execute. The
          // approval_request / approval_decision ledger events cover
          // visibility into the denial itself.
          const msg =
            approval.kind === "timeout"
              ? "Approval timed out after 30 min."
              : approval.kind === "deny"
                ? `Denied by operator${approval.resolvedBy ? ` (${approval.resolvedBy})` : ""}.`
                : approval.message;
          return toolError(`${msg} Command not executed.`);
        }
        // Allowed — fall through to execution.
      }
      // classification === "allow" also falls through here.

      // 4. Execute. timeout_ms is clamped here, not in the zod schema,
      //    so we accept "conservative" inputs and silently clamp
      //    extreme ones instead of rejecting.
      const clampedTimeout = clampTimeoutMs(timeout_ms);
      const result = await execBashWithTimeout(command, working_directory, clampedTimeout);

      const outcome: "success" | "error" =
        !result.spawnError && !result.timedOut && result.exitCode === 0
          ? "success"
          : "error";

      const summary = summarizeToolUse("rondel_bash", { command });

      // 5. Emit ledger event. Fire-and-forget from the ledger's perspective,
      //    but we still await it inside the tool to keep the flow linear —
      //    emitToolCall swallows all errors internally.
      const errorField =
        outcome === "error"
          ? (result.spawnError
            ?? (result.timedOut ? `timed out after ${clampedTimeout}ms` : undefined)
            ?? result.stderr.slice(0, STDERR_FOR_ERROR_MAX)
            ?? `exit ${result.exitCode ?? "unknown"}`)
          : undefined;

      await emitToolCall(ctx, {
        toolName: "rondel_bash",
        toolInput: input,
        summary,
        outcome,
        durationMs: result.durationMs,
        ...(result.exitCode !== null && result.exitCode !== undefined
          ? { exitCode: result.exitCode }
          : {}),
        ...(errorField !== undefined ? { error: errorField } : {}),
      });

      // 6. Return MCP response — always JSON-parseable.
      const payload: Record<string, unknown> = {
        stdout: result.stdout,
        stderr: result.stderr,
        exit_code: result.exitCode,
        duration_ms: result.durationMs,
        truncated: result.truncated,
      };
      if (outcome === "error") {
        if (result.spawnError) payload.error = result.spawnError;
        else if (result.timedOut) payload.error = `timed out after ${clampedTimeout}ms`;
        else if (result.signal) payload.signal = result.signal;
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify(payload) }],
        isError: outcome === "error",
      };
    },
  );
}
