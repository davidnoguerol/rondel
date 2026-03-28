import { readFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolveFlowclawHome, flowclawPaths } from "../config/config.js";
import { readInstanceLock } from "../system/instance-lock.js";
import { error } from "./prompt.js";

/**
 * flowclaw logs — view the orchestrator's log output.
 *
 * --follow / -f:  tail the log in real-time
 * --lines N / -n N: number of lines to show (default: 50)
 */
export async function runLogs(flags: { follow?: boolean; lines?: number }): Promise<void> {
  const flowclawHome = resolveFlowclawHome();
  const paths = flowclawPaths(flowclawHome);

  // Get log path from lockfile or fall back to default
  const lock = readInstanceLock(paths.state);
  const logPath = (lock?.logPath) || paths.log;

  if (!existsSync(logPath)) {
    error("No log file found. Is FlowClaw running in daemon mode?");
    process.exit(1);
  }

  const lines = flags.lines ?? 50;

  if (flags.follow) {
    // Stream logs in real-time using tail -f
    const tail = spawn("tail", ["-n", String(lines), "-f", logPath], {
      stdio: "inherit",
    });
    tail.on("exit", (code) => process.exit(code ?? 0));

    // Forward signals to tail
    process.on("SIGINT", () => tail.kill("SIGINT"));
    process.on("SIGTERM", () => tail.kill("SIGTERM"));
    return;
  }

  // Read last N lines
  const content = readFileSync(logPath, "utf-8");
  const allLines = content.split("\n").filter((l) => l.length > 0);
  const slice = allLines.slice(-lines);

  for (const line of slice) {
    console.log(line);
  }
}
