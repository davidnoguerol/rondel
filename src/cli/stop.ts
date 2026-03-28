import { resolveFlowclawHome, flowclawPaths } from "../config/config.js";
import { readInstanceLock } from "../system/instance-lock.js";
import { getServiceBackend } from "../system/service.js";
import { info, success, error } from "./prompt.js";

/**
 * flowclaw stop — stop the running orchestrator.
 *
 * Service-aware: if an OS service manages FlowClaw, uses the service manager
 * to stop it (otherwise the supervisor would restart it immediately).
 */
export async function runStop(): Promise<void> {
  const flowclawHome = resolveFlowclawHome();
  const paths = flowclawPaths(flowclawHome);

  const lock = readInstanceLock(paths.state);
  if (!lock) {
    info("FlowClaw is not running.");
    return;
  }

  // If an OS service is installed, use the service manager to stop
  const backend = getServiceBackend();
  if (backend) {
    const installed = await backend.isInstalled();
    if (installed) {
      info(`Stopping via ${backend.platform}...`);
      try {
        await backend.stop();
        // Wait for the process to actually exit
        await waitForExit(lock.pid, 10000);
        success("FlowClaw stopped.");
        return;
      } catch (err) {
        // Service stop failed — fall through to direct kill
        info("Service stop failed, sending SIGTERM directly...");
      }
    }
  }

  // Direct stop — send SIGTERM
  info(`Stopping FlowClaw (PID ${lock.pid})...`);
  try {
    process.kill(lock.pid, "SIGTERM");
  } catch {
    info("Process already exited.");
    return;
  }

  const exited = await waitForExit(lock.pid, 5000);
  if (exited) {
    success("FlowClaw stopped.");
  } else {
    // Force kill
    info("Process did not stop gracefully, sending SIGKILL...");
    try {
      process.kill(lock.pid, "SIGKILL");
    } catch {
      // Already dead
    }
    success("FlowClaw force-stopped.");
  }
}

/**
 * Wait for a process to exit by polling PID liveness.
 */
async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      process.kill(pid, 0);
      // Still alive — wait
      await new Promise((r) => setTimeout(r, 100));
    } catch {
      return true; // PID is gone
    }
  }
  return false;
}
