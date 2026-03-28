import { access } from "node:fs/promises";
import { resolveFlowclawHome, flowclawPaths } from "../config/config.js";
import { startOrchestrator } from "../index.js";

/**
 * flowclaw start — run the orchestrator in the foreground.
 *
 * Thin wrapper around startOrchestrator() that checks for initialization first.
 */
export async function runStart(): Promise<void> {
  const flowclawHome = resolveFlowclawHome();
  const paths = flowclawPaths(flowclawHome);

  // Verify FlowClaw is initialized
  try {
    await access(paths.config);
  } catch {
    console.error("FlowClaw is not initialized. Run 'flowclaw init' first.");
    process.exit(1);
  }

  await startOrchestrator(flowclawHome);
}
