import { getServiceBackend, buildServiceConfig } from "../system/service.js";
import { resolveFlowclawHome, flowclawPaths } from "../config/config.js";
import { header, info, success, warn, error } from "./prompt.js";

/**
 * flowclaw service — manage the OS service (launchd/systemd).
 *
 * Subcommands:
 *   install   — Register and start the service
 *   uninstall — Stop and remove the service
 *   status    — Show service status
 */
export async function runService(subcommand: string | undefined): Promise<void> {
  switch (subcommand) {
    case "install":
      return installService();
    case "uninstall":
      return uninstallService();
    case "status":
      return serviceStatus();
    default:
      console.error(`Unknown subcommand: flowclaw service ${subcommand ?? ""}`);
      console.error("Usage: flowclaw service [install|uninstall|status]");
      process.exit(1);
  }
}

export async function installService(): Promise<void> {
  const backend = getServiceBackend();
  if (!backend) {
    error(`Unsupported platform: ${process.platform}`);
    info("OS service integration requires macOS (launchd) or Linux (systemd).");
    info("You can still run FlowClaw with: flowclaw start");
    process.exit(1);
  }

  const installed = await backend.isInstalled();
  if (installed) {
    warn("FlowClaw service is already installed.");
    info("Use 'flowclaw service uninstall' to remove it first.");
    return;
  }

  const config = buildServiceConfig();
  const paths = flowclawPaths(config.flowclawHome);

  info(`Installing FlowClaw as ${backend.platform} service...`);

  if (!config.claudePath) {
    warn("Could not find 'claude' CLI in PATH. Agents will fail to spawn.");
    info("Install the Claude CLI and run 'flowclaw service install' again.");
  }

  await backend.install(config);

  console.log("");
  success("FlowClaw service installed and started.");
  console.log("");
  info(`  Platform:     ${backend.platform}`);
  info(`  Auto-start:   on login`);
  info(`  Auto-restart: on crash (5s delay)`);
  info(`  Logs:         ${paths.log}`);
  info(`  Node:         ${config.nodePath}`);
  if (config.claudePath) {
    info(`  Claude CLI:   ${config.claudePath}`);
  }
  console.log("");
  info("Use 'flowclaw status' to check, 'flowclaw logs -f' to follow output.");
}

async function uninstallService(): Promise<void> {
  const backend = getServiceBackend();
  if (!backend) {
    error(`Unsupported platform: ${process.platform}`);
    process.exit(1);
  }

  const installed = await backend.isInstalled();
  if (!installed) {
    info("FlowClaw service is not installed.");
    return;
  }

  info(`Removing FlowClaw ${backend.platform} service...`);
  await backend.uninstall();
  success("FlowClaw service uninstalled.");
  info("FlowClaw will no longer auto-start. Use 'flowclaw start' to run manually.");
}

async function serviceStatus(): Promise<void> {
  const backend = getServiceBackend();
  if (!backend) {
    info(`Platform ${process.platform} does not support OS service integration.`);
    return;
  }

  const status = await backend.status();
  header("FlowClaw Service");

  if (!status.installed) {
    info("Status: not installed");
    info("Install with: flowclaw service install");
    return;
  }

  if (status.running) {
    success(`Status: running${status.pid ? ` (PID ${status.pid})` : ""}`);
  } else {
    warn("Status: installed but not running");
    info("Start with: flowclaw start");
  }

  info(`Platform: ${backend.platform}`);
}
