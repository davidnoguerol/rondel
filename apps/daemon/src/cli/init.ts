import { mkdir, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { resolveRondelHome, rondelPaths } from "../config/config.js";
import { scaffoldAgent } from "./scaffold.js";
import { validateBotToken, discoverUserViaTelegram } from "./telegram-discover.js";
import { ask, confirm, header, success, warn, info, error } from "./prompt.js";

/**
 * rondel init — first-time setup.
 *
 * Creates ~/.rondel/ structure, config.json, .env, and scaffolds
 * the first agent with BOOTSTRAP.md for onboarding.
 *
 * User discovery flow:
 * 1. Ask for agent name + bot token
 * 2. Validate bot token with Telegram API
 * 3. Ask user to message the bot — listen for incoming messages
 * 4. Auto-detect user ID from the message sender
 */
export async function runInit(): Promise<void> {
  const rondelHome = resolveRondelHome();
  const paths = rondelPaths(rondelHome);

  header("Rondel Setup");
  info(`Home directory: ${rondelHome}`);

  // Check if already initialized
  const alreadyExists = await exists(paths.config);
  if (alreadyExists) {
    warn("Rondel is already initialized at this location.");
    info(`Config: ${paths.config}`);
    info("Use 'rondel add agent' to add more agents.");
    process.exit(0);
  }

  // Create directory structure
  await mkdir(rondelHome, { recursive: true });
  await mkdir(paths.workspaces, { recursive: true });
  await mkdir(join(paths.workspaces, "global", "agents"), { recursive: true });
  await mkdir(paths.templates, { recursive: true });
  await mkdir(paths.state, { recursive: true });

  // --- Interactive: first agent setup ---

  console.log("");
  info("Let's set up your first agent.\n");

  const agentName = await ask("Agent name", "assistant");
  if (!agentName) {
    error("Agent name is required.");
    process.exit(1);
  }

  const botToken = await ask("Telegram bot token (from @BotFather)");
  if (!botToken) {
    error("Bot token is required. Get one from @BotFather on Telegram.");
    process.exit(1);
  }

  // Validate bot token
  info("Validating bot token...");
  const botInfo = await validateBotToken(botToken);
  if (!botInfo) {
    error("Invalid bot token. Check that you copied the full token from @BotFather.");
    process.exit(1);
  }
  success(`Bot verified: @${botInfo.username} (${botInfo.firstName})`);

  // Discover user ID by listening for messages
  const discoveredIds = await discoverUserViaTelegram(botToken, botInfo.username);

  let allowedUserIds: string[];

  if (discoveredIds) {
    allowedUserIds = discoveredIds.split(",");
  } else {
    // Fallback: ask manually
    warn("Could not detect your user ID automatically.");
    const manualId = await ask("Enter your Telegram user ID manually (from @userinfobot)");
    if (!manualId) {
      error("User ID is required for security — it prevents strangers from using your bot.");
      process.exit(1);
    }
    allowedUserIds = [manualId];
  }

  const model = await ask("Default model", "sonnet");

  // --- Write config.json ---
  const config = {
    defaultModel: model,
    allowedUsers: allowedUserIds,
  };
  await writeFile(paths.config, JSON.stringify(config, null, 2) + "\n");
  success(`Created ${paths.config}`);

  // --- Write .env ---
  const envContent = `# Rondel environment variables\n# Bot tokens and secrets go here\n\n${envVarName(agentName)}_BOT_TOKEN=${botToken}\n`;
  await writeFile(paths.env, envContent);
  success(`Created ${paths.env}`);

  // --- Write .gitignore for state dir ---
  await writeFile(join(rondelHome, ".gitignore"), "state/\n.env\n");
  success("Created .gitignore (excludes state/ and .env)");

  // --- Scaffold first agent ---
  const agentDir = join(paths.workspaces, "global", "agents", agentName);
  const credentialsEnvVar = `${envVarName(agentName)}_BOT_TOKEN`;
  await scaffoldAgent({
    agentDir,
    agentName,
    credentialsEnvVar,
    model,
    admin: true,
  });
  success(`Created agent "${agentName}" at ${agentDir}`);

  // --- Write global CONTEXT.md (starter) ---
  const globalContextDir = join(paths.workspaces, "global");
  await writeFile(
    join(globalContextDir, "CONTEXT.md"),
    GLOBAL_CONTEXT_MD,
  );
  success("Created global/CONTEXT.md");

  // --- Summary ---
  console.log("");
  header("Setup complete!");
  info(`Home:    ${rondelHome}`);
  info(`Agent:   ${agentName} (@${botInfo.username})`);
  info(`User(s): ${allowedUserIds.join(", ")}`);
  info(`Config:  ${paths.config}`);
  console.log("");

  // --- Offer OS service installation ---
  const { getServiceBackend } = await import("../system/service.js");
  const serviceBackend = getServiceBackend();

  if (serviceBackend) {
    const installIt = await confirm("Install as system service (auto-start on login)?");
    if (installIt) {
      const { installService } = await import("./service.js");
      await installService();
      console.log("");
      info("Send a message to your bot on Telegram — your agent is ready!");
      info("The agent will run its first-time bootstrap ritual on first contact.");
    } else {
      info("You can install the service later with: rondel service install");
    }
  } else {
    info(`Platform ${process.platform} does not support OS service integration.`);
    info("See README for manual setup instructions.");
  }

  console.log("");
  info("To add more agents: rondel add agent <name>");
  info("To check setup:     rondel doctor");
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

/** Convert an agent name to an env var prefix. e.g. "ops-bot" → "OPS_BOT" */
function envVarName(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

const GLOBAL_CONTEXT_MD = `# Global Context

This context is shared across all agents in this Rondel installation.

## Platform

You are an agent running inside Rondel — a multi-agent orchestration framework. You communicate with your human via Telegram.

Your tools are provided via MCP (Model Context Protocol) and discovered automatically at session start — check what's available rather than assuming specific tool names.

## Communication

- Format responses for Telegram (Markdown supported).
- Telegram has a 4096-character message limit — Rondel handles chunking, but be aware of it.
- Your typing indicator shows while you're working, including during tool calls.

## Session Commands

Your human can send these commands in Telegram:

- \`/status\` — show your current state
- \`/restart\` — restart your process
- \`/cancel\` — cancel the current turn
- \`/new\` — start a fresh session (history preserved on disk)
- \`/help\` — show available commands

## Capabilities

You have access to the host machine through Claude CLI tools (Bash, Read, Write, Edit, Glob, Grep, WebSearch, WebFetch) and Rondel tools (discovered via MCP). Use tools directly — don't tell the user how to do things manually.

### When to Act vs When to Ask

**Act freely (internal operations):**
- Read files, explore, organize, search the web
- Work within your workspace
- Send messages to the user via Telegram
- Check system status

**Confirm first (external/irreversible):**
- Creating new agents or modifying agent config
- Setting environment variables or secrets
- Installing packages or making system changes
- Anything destructive or hard to reverse
- Anything you're uncertain about
`;
