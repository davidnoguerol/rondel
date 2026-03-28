import { access } from "node:fs/promises";
import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveFlowclawHome, flowclawPaths } from "../config/config.js";
import { readInstanceLock } from "../system/instance-lock.js";
import { info, success, error } from "./prompt.js";

/**
 * flowclaw start — run the orchestrator.
 *
 * Default: daemon mode (fork to background, return immediately).
 * --foreground: run in the foreground (for development/debugging).
 */
export async function runStart(flags: { foreground?: boolean } = {}): Promise<void> {
  const flowclawHome = resolveFlowclawHome();
  const paths = flowclawPaths(flowclawHome);

  // Verify FlowClaw is initialized
  try {
    await access(paths.config);
  } catch {
    error("FlowClaw is not initialized. Run 'flowclaw init' first.");
    process.exit(1);
  }

  // Check if already running
  const existing = readInstanceLock(paths.state);
  if (existing) {
    error(`FlowClaw is already running (PID ${existing.pid}).`);
    info("Use 'flowclaw stop' to stop it, or 'flowclaw restart' to restart.");
    process.exit(1);
  }

  if (flags.foreground) {
    // Foreground mode — import and run directly
    const { startOrchestrator } = await import("../index.js");
    await startOrchestrator(flowclawHome);
    return;
  }

  // Daemon mode — fork a detached child process
  const entryPoint = join(dirname(fileURLToPath(import.meta.url)), "..", "index.js");

  // Open log file for the child's stdout/stderr
  const logFd = openSync(paths.log, "a");

  const child = spawn(process.execPath, [entryPoint], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: {
      ...process.env,
      FLOWCLAW_HOME: flowclawHome,
      FLOWCLAW_DAEMON: "1",
    },
  });

  child.unref();
  const childPid = child.pid;

  if (!childPid) {
    error("Failed to start daemon process.");
    process.exit(1);
  }

  // Wait for the lockfile to appear (confirms the child started successfully)
  const started = await waitForLock(paths.state, childPid, 5000);
  if (started) {
    success(`FlowClaw started (PID ${childPid})`);
    info(`Logs: ${paths.log}`);
    info("Use 'flowclaw status' to check, 'flowclaw stop' to stop.");
  } else {
    error(`Daemon process started (PID ${childPid}) but did not acquire lock within 5 seconds.`);
    info(`Check logs: ${paths.log}`);
    process.exit(1);
  }
}

/**
 * Wait for the lockfile to appear with the expected PID.
 * Polls every 200ms up to timeoutMs.
 */
async function waitForLock(stateDir: string, expectedPid: number, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const lock = readInstanceLock(stateDir);
    if (lock && lock.pid === expectedPid) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}
