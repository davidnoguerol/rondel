import { runStop } from "./stop.js";
import { runStart } from "./start.js";

/**
 * flowclaw restart — stop the running orchestrator, then start it again.
 */
export async function runRestart(): Promise<void> {
  await runStop();

  // Brief delay for lock cleanup
  await new Promise((r) => setTimeout(r, 500));

  await runStart();
}
