#!/usr/bin/env node

/**
 * Rondel CLI entry point.
 *
 * Commands:
 *   rondel init                     — First-time setup
 *   rondel start                    — Ensure the daemon is running (service or foreground)
 *   rondel stop                     — Stop the running orchestrator
 *   rondel restart                  — Restart the daemon
 *   rondel add agent [name]         — Add a new agent
 *   rondel add org [name]           — Add a new organization
 *   rondel logs [-f] [-n N]         — View orchestrator logs
 *   rondel status                   — Show running instance status
 *   rondel doctor                   — Validate installation
 *   rondel service [install|uninstall|status] — Manage OS service
 */

const HELP = `
Rondel — Multi-agent orchestration framework

Usage:
  rondel init                          Set up Rondel for the first time
  rondel start                         Ensure the daemon is running (idempotent)
  rondel stop                          Stop the running orchestrator
  rondel restart                       Restart the daemon
  rondel add agent [name]              Add a new agent to your installation
  rondel add org [name]                Add a new organization
  rondel logs [-f] [-n N]              View orchestrator logs
  rondel status                        Show status of running instance
  rondel doctor                        Validate your Rondel installation
  rondel service install               Install as OS service (auto-start on login)
  rondel service uninstall             Remove OS service
  rondel service status                Show OS service status
  rondel help                          Show this help message

Environment:
  RONDEL_HOME                          Override home directory (default: ~/.rondel)
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
      if (subcommand === "agent") {
        const agentName = args[2]; // optional — will prompt if missing
        const { runAddAgent } = await import("./add-agent.js");
        await runAddAgent(agentName);
      } else if (subcommand === "org") {
        const orgName = args[2]; // optional — will prompt if missing
        const { runAddOrg } = await import("./add-org.js");
        await runAddOrg(orgName);
      } else {
        console.error(`Unknown subcommand: rondel add ${subcommand ?? ""}`);
        console.error("Usage: rondel add agent [name]  OR  rondel add org [name]");
        process.exit(1);
      }
      break;
    }

    case "start": {
      const { runStart } = await import("./start.js");
      await runStart();
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
