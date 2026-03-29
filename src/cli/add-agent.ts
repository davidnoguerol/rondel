import { access } from "node:fs/promises";
import { join } from "node:path";
import { resolveRondelHome, rondelPaths } from "../config/config.js";
import { scaffoldAgent } from "./scaffold.js";
import { ask, header, success, info, error, warn } from "./prompt.js";

/**
 * rondel add agent <name> — scaffold a new agent.
 *
 * Prompts for bot token and location, then creates the agent directory
 * with config + context files + BOOTSTRAP.md.
 */
export async function runAddAgent(agentName?: string): Promise<void> {
  const rondelHome = resolveRondelHome();
  const paths = rondelPaths(rondelHome);

  // Verify Rondel is initialized
  if (!(await exists(paths.config))) {
    error("Rondel is not initialized. Run 'rondel init' first.");
    process.exit(1);
  }

  header("Add Agent");

  // Get agent name
  if (!agentName) {
    agentName = await ask("Agent name");
  }
  if (!agentName) {
    error("Agent name is required.");
    process.exit(1);
  }

  // Validate name
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(agentName)) {
    error("Agent name must start with a letter/number and contain only letters, numbers, hyphens, and underscores.");
    process.exit(1);
  }

  // Ask for location within workspaces
  const location = await ask("Location within workspaces/", "global/agents");
  const agentDir = join(paths.workspaces, location, agentName);

  // Check if agent dir already exists
  if (await exists(agentDir)) {
    warn(`Directory already exists: ${agentDir}`);
    error("An agent directory already exists at this location.");
    process.exit(1);
  }

  // Get bot token
  const botToken = await ask("Telegram bot token (from @BotFather)");
  if (!botToken) {
    error("Bot token is required. Get one from @BotFather on Telegram.");
    process.exit(1);
  }

  // Get model
  const model = await ask("Model", "sonnet");

  // Scaffold the agent
  await scaffoldAgent({
    agentDir,
    agentName,
    botToken,
    model,
  });

  success(`Created agent "${agentName}" at ${agentDir}`);
  console.log("");
  info("The agent will run its first-time bootstrap ritual on the first message.");
  info("Restart Rondel to pick up the new agent (or it will be discovered on next start).");
  console.log("");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
