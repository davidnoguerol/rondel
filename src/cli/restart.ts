import { getServiceBackend } from "../system/service.js";
import { error, info, success } from "./prompt.js";

/**
 * rondel restart — restart the OS service.
 *
 * Requires an installed service. For foreground mode, just Ctrl+C and
 * run `rondel start` again.
 */
export async function runRestart(): Promise<void> {
  const backend = getServiceBackend();
  if (!backend) {
    error(`Platform ${process.platform} does not support OS service integration.`);
    info("Stop with Ctrl+C, then run 'rondel start' again.");
    process.exit(1);
  }

  const installed = await backend.isInstalled();
  if (!installed) {
    error("No Rondel service installed.");
    info("Install one with: rondel service install");
    info("Or stop with Ctrl+C and run 'rondel start' again.");
    process.exit(1);
  }

  info(`Restarting via ${backend.platform}...`);

  // Uninstall and reinstall to cycle — service managers don't all have a clean restart
  const { buildServiceConfig } = await import("../system/service.js");
  const config = buildServiceConfig();

  await backend.uninstall();
  // Brief pause for cleanup
  await new Promise((r) => setTimeout(r, 1000));
  await backend.install(config);

  success("Rondel service restarted.");
}
