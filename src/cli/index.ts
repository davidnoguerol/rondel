#!/usr/bin/env node

/**
 * FlowClaw CLI entry point.
 *
 * Commands:
 *   flowclaw init                     — First-time setup
 *   flowclaw add agent [name]         — Add a new agent
 *   flowclaw stop                     — Stop the running orchestrator
 *   flowclaw restart                  — Restart the OS service
 *   flowclaw logs [-f] [-n N]         — View orchestrator logs
 *   flowclaw status                   — Show running instance status
 *   flowclaw doctor                   — Validate installation
 *   flowclaw service [install|uninstall|status] — Manage OS service
 */

const HELP = `
FlowClaw — Multi-agent orchestration framework

Usage:
  flowclaw init                          Set up FlowClaw for the first time
  flowclaw add agent [name]              Add a new agent to your installation
  flowclaw stop                          Stop the running orchestrator
  flowclaw restart                       Restart the OS service
  flowclaw logs [-f] [-n N]              View orchestrator logs
  flowclaw status                        Show status of running instance
  flowclaw doctor                        Validate your FlowClaw installation
  flowclaw service install               Install as OS service (auto-start on login)
  flowclaw service uninstall             Remove OS service
  flowclaw service status                Show OS service status
  flowclaw help                          Show this help message

Environment:
  FLOWCLAW_HOME                          Override home directory (default: ~/.flowclaw)
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

    case "stop": {
      const { runStop } = await import("./stop.js");
      await runStop();
      break;
    }

    case "restart": {
      const { runRestart } = await import("./restart.js");
      await runRestart();
      break;
    }

    case "logs": {
      const follow = args.includes("--follow") || args.includes("-f");
      let lines: number | undefined;
      const nIdx = args.indexOf("-n");
      if (nIdx !== -1 && args[nIdx + 1]) {
        lines = parseInt(args[nIdx + 1], 10);
      }
      const linesIdx = args.indexOf("--lines");
      if (linesIdx !== -1 && args[linesIdx + 1]) {
        lines = parseInt(args[linesIdx + 1], 10);
      }
      const { runLogs } = await import("./logs.js");
      await runLogs({ follow, lines });
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

    case "service": {
      const subcommand = args[1];
      const { runService } = await import("./service.js");
      await runService(subcommand);
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
