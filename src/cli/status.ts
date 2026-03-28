import { resolveFlowclawHome, flowclawPaths } from "../config/config.js";
import { readInstanceLock } from "../system/instance-lock.js";
import { getServiceBackend } from "../system/service.js";
import { header, info, warn, error, success } from "./prompt.js";

/**
 * flowclaw status — query the running FlowClaw instance via the HTTP bridge.
 *
 * Shows service status, PID, uptime, and agent conversation states.
 */
export async function runStatus(): Promise<void> {
  const flowclawHome = resolveFlowclawHome();
  const paths = flowclawPaths(flowclawHome);

  header("FlowClaw Status");

  // Service status
  const backend = getServiceBackend();
  if (backend) {
    const serviceStatus = await backend.status();
    if (!serviceStatus.installed) {
      info("Service: not installed");
    } else if (serviceStatus.running) {
      success(`Service: running (${backend.platform})`);
    } else {
      warn(`Service: installed (${backend.platform}) but not running`);
    }
  }

  // Read lock file
  const lockData = readInstanceLock(paths.state);
  if (!lockData) {
    error("FlowClaw is not running.");
    info("Start it with: flowclaw start");
    process.exit(1);
  }

  info(`PID: ${lockData.pid}`);
  info(`Started: ${new Date(lockData.startedAt).toISOString()}`);
  info(`Uptime: ${formatUptime(Date.now() - lockData.startedAt)}`);
  if (lockData.logPath) {
    info(`Logs: ${lockData.logPath}`);
  }

  // Try to reach the bridge
  if (!lockData.bridgeUrl) {
    warn("Bridge URL not recorded in lock file. Cannot query agent status.");
    info("The orchestrator is running but status details are unavailable.");
    return;
  }

  try {
    const res = await fetch(`${lockData.bridgeUrl}/agents`);
    if (!res.ok) {
      warn(`Bridge returned status ${res.status}`);
      return;
    }

    const data = await res.json() as {
      agents: Array<{
        name: string;
        activeConversations: number;
        conversations: Array<{ chatId: string; state: string; sessionId: string }>;
      }>;
    };

    console.log("");
    info(`Agents: ${data.agents.length}`);
    console.log("");

    for (const agent of data.agents) {
      console.log(`  \x1b[1m${agent.name}\x1b[0m — ${agent.activeConversations} active conversation(s)`);
      for (const conv of agent.conversations) {
        const stateColor = conv.state === "idle" ? "\x1b[32m" : conv.state === "busy" ? "\x1b[33m" : "\x1b[31m";
        console.log(`    chat ${conv.chatId}: ${stateColor}${conv.state}\x1b[0m (session: ${conv.sessionId.slice(0, 8)}...)`);
      }
    }
    console.log("");
  } catch {
    warn(`Could not reach bridge at ${lockData.bridgeUrl}`);
    info("The orchestrator may still be starting up.");
  }
}

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}
