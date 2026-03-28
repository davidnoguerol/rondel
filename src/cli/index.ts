#!/usr/bin/env node

/**
 * FlowClaw CLI entry point.
 *
 * Commands:
 *   flowclaw init              — First-time setup
 *   flowclaw add agent [name]  — Add a new agent
 *   flowclaw start             — Run the orchestrator
 *   flowclaw status            — Show running instance status
 *   flowclaw doctor            — Validate installation
 */

const HELP = `
FlowClaw — Multi-agent orchestration framework

Usage:
  flowclaw init              Set up FlowClaw for the first time
  flowclaw add agent [name]  Add a new agent to your installation
  flowclaw start             Start the orchestrator (foreground)
  flowclaw status            Show status of running instance
  flowclaw doctor            Validate your FlowClaw installation
  flowclaw help              Show this help message

Environment:
  FLOWCLAW_HOME              Override home directory (default: ~/.flowclaw)
`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "help" || args[0] === "--help" || args[0] === "-h") {
    console.log(HELP);
    return;
  }

  const command = args[0];

  switch (command) {
    case "init": {
      const { runInit } = await import("./init.js");
      await runInit();
      break;
    }

    case "add": {
      const subcommand = args[1];
      if (subcommand !== "agent") {
        console.error(`Unknown subcommand: flowclaw add ${subcommand ?? ""}`);
        console.error("Usage: flowclaw add agent [name]");
        process.exit(1);
      }
      const agentName = args[2]; // optional — will prompt if missing
      const { runAddAgent } = await import("./add-agent.js");
      await runAddAgent(agentName);
      break;
    }

    case "start": {
      const { runStart } = await import("./start.js");
      await runStart();
      break;
    }

    case "status": {
      const { runStatus } = await import("./status.js");
      await runStatus();
      break;
    }

    case "doctor": {
      const { runDoctor } = await import("./doctor.js");
      await runDoctor();
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      console.log(HELP);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
