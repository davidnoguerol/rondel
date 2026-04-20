import { access, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { resolveRondelHome, rondelPaths, loadRondelConfig, discoverAll, discoverAgents } from "../config/config.js";
import { resolveFrameworkSkillsDir } from "../shared/paths.js";
import { header, success, warn, error, info } from "./prompt.js";

/**
 * rondel doctor — validate the Rondel installation.
 *
 * Runs a series of diagnostic checks and reports results.
 * Expandable: add new checker functions to the `checkers` array.
 */

interface CheckResult {
  readonly name: string;
  readonly status: "pass" | "warn" | "fail";
  readonly message: string;
}

type Checker = () => Promise<CheckResult>;

export async function runDoctor(): Promise<void> {
  const rondelHome = resolveRondelHome();

  header("Rondel Doctor");
  info(`Home: ${rondelHome}\n`);

  const checkers: Checker[] = [
    () => checkInitialized(rondelHome),
    () => checkConfig(rondelHome),
    () => checkClaudeCli(),
    () => checkOrgDiscovery(rondelHome),
    () => checkAgentDiscovery(rondelHome),
    () => checkAgentConfigs(rondelHome),
    () => checkBotTokens(rondelHome),
    () => checkStateDir(rondelHome),
    () => checkService(),
    () => checkFrameworkSkills(),
  ];

  let failures = 0;
  let warnings = 0;

  for (const checker of checkers) {
    const result = await checker();
    switch (result.status) {
      case "pass":
        success(`${result.name}: ${result.message}`);
        break;
      case "warn":
        warn(`${result.name}: ${result.message}`);
        warnings++;
        break;
      case "fail":
        error(`${result.name}: ${result.message}`);
        failures++;
        break;
    }
  }

  console.log("");
  if (failures > 0) {
    error(`${failures} check(s) failed, ${warnings} warning(s).`);
    process.exit(1);
  } else if (warnings > 0) {
    warn(`All checks passed with ${warnings} warning(s).`);
  } else {
    success("All checks passed.");
  }
}

// ---------------------------------------------------------------------------
// Checkers — each returns a single CheckResult
// ---------------------------------------------------------------------------

async function checkInitialized(rondelHome: string): Promise<CheckResult> {
  const paths = rondelPaths(rondelHome);
  try {
    await access(paths.config);
    return { name: "Initialized", status: "pass", message: `Config found at ${paths.config}` };
  } catch {
    return { name: "Initialized", status: "fail", message: "Rondel is not initialized. Run 'rondel init'." };
  }
}

async function checkConfig(rondelHome: string): Promise<CheckResult> {
  try {
    const config = await loadRondelConfig(rondelHome);
    if (config.allowedUsers.length === 0) {
      return { name: "Config", status: "fail", message: "No allowed users configured." };
    }
    return { name: "Config", status: "pass", message: `Valid (${config.allowedUsers.length} allowed user(s))` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { name: "Config", status: "fail", message: msg };
  }
}

async function checkClaudeCli(): Promise<CheckResult> {
  return new Promise((resolve) => {
    execFile("claude", ["--version"], { timeout: 5000 }, (err, stdout) => {
      if (err) {
        resolve({
          name: "Claude CLI",
          status: "fail",
          message: "Claude CLI not found. Install it: https://docs.anthropic.com/en/docs/claude-code",
        });
      } else {
        const version = stdout.trim().split("\n")[0] || "unknown";
        resolve({ name: "Claude CLI", status: "pass", message: version });
      }
    });
  });
}

async function checkOrgDiscovery(rondelHome: string): Promise<CheckResult> {
  try {
    const { orgs, agents } = await discoverAll(rondelHome);
    if (orgs.length === 0) {
      return { name: "Organizations", status: "pass", message: "None configured (optional)" };
    }
    const orgSummary = orgs.map((o) => {
      const agentCount = agents.filter((a) => a.orgName === o.orgName).length;
      return `${o.orgName} (${agentCount} agent${agentCount !== 1 ? "s" : ""})`;
    }).join(", ");
    return { name: "Organizations", status: "pass", message: `Found ${orgs.length}: ${orgSummary}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { name: "Organizations", status: "fail", message: msg };
  }
}

async function checkAgentDiscovery(rondelHome: string): Promise<CheckResult> {
  try {
    const agents = await discoverAgents(rondelHome);
    if (agents.length === 0) {
      return {
        name: "Agents",
        status: "warn",
        message: "No agents found in workspaces/. Run 'rondel add agent' to create one.",
      };
    }
    const names = agents.map((a) => a.agentName).join(", ");
    return { name: "Agents", status: "pass", message: `Found ${agents.length}: ${names}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { name: "Agents", status: "fail", message: msg };
  }
}

async function checkAgentConfigs(rondelHome: string): Promise<CheckResult> {
  const paths = rondelPaths(rondelHome);
  const issues: string[] = [];

  // Recursively find all agent.json files and validate them
  try {
    const agents = await discoverAgents(rondelHome);
    for (const agent of agents) {
      // AGENT.md is the personality/operating manual file. Framework-critical
      // rules are emitted by the prompt pipeline, so a missing AGENT.md
      // produces a framework-only prompt with no personality — degraded but
      // functional. Still warn so users notice.
      const hasAgent = await fileExists(join(agent.agentDir, "AGENT.md"));
      if (!hasAgent) {
        issues.push(`${agent.agentName}: missing AGENT.md`);
      }
    }
  } catch {
    // Discovery errors are caught by checkAgentDiscovery
  }

  if (issues.length > 0) {
    return { name: "Agent configs", status: "warn", message: issues.join("; ") };
  }
  return { name: "Agent configs", status: "pass", message: "All agents have context files" };
}

async function checkBotTokens(rondelHome: string): Promise<CheckResult> {
  let agents;
  try {
    agents = await discoverAgents(rondelHome);
  } catch {
    return { name: "Bot tokens", status: "warn", message: "Could not discover agents" };
  }

  if (agents.length === 0) {
    return { name: "Bot tokens", status: "warn", message: "No agents to check" };
  }

  const results: string[] = [];
  let allOk = true;

  for (const agent of agents) {
    const telegramBinding = agent.config.channels.find((b) => b.channelType === "telegram");
    const token = telegramBinding ? process.env[telegramBinding.credentialEnvVar] : undefined;
    if (!token) {
      results.push(`${agent.agentName}: no telegram token (env var: ${telegramBinding?.credentialEnvVar ?? "none"})`);
      allOk = false;
      continue;
    }

    // Test the token with Telegram getMe API
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const data = await res.json() as { result: { username: string } };
        results.push(`${agent.agentName}: @${data.result.username}`);
      } else {
        results.push(`${agent.agentName}: invalid token (HTTP ${res.status})`);
        allOk = false;
      }
    } catch {
      results.push(`${agent.agentName}: could not reach Telegram API`);
      allOk = false;
    }
  }

  return {
    name: "Bot tokens",
    status: allOk ? "pass" : "warn",
    message: results.join(", "),
  };
}

async function checkStateDir(rondelHome: string): Promise<CheckResult> {
  const paths = rondelPaths(rondelHome);
  try {
    await access(paths.state);
    return { name: "State directory", status: "pass", message: paths.state };
  } catch {
    return { name: "State directory", status: "warn", message: `${paths.state} does not exist (will be created on start)` };
  }
}

async function checkService(): Promise<CheckResult> {
  const { getServiceBackend } = await import("../system/service.js");
  const backend = getServiceBackend();

  if (!backend) {
    return { name: "Service", status: "warn", message: `Platform ${process.platform} does not support OS service integration` };
  }

  const status = await backend.status();
  if (!status.installed) {
    return { name: "Service", status: "warn", message: "Not installed — run 'rondel service install' for auto-start on login" };
  }

  if (status.running) {
    return { name: "Service", status: "pass", message: `Running via ${backend.platform}${status.pid ? ` (PID ${status.pid})` : ""}` };
  }

  return { name: "Service", status: "warn", message: `Installed (${backend.platform}) but not running` };
}

async function checkFrameworkSkills(): Promise<CheckResult> {
  const skillsDir = join(resolveFrameworkSkillsDir(), ".claude", "skills");
  const expected = ["rondel-create-agent", "rondel-delegation", "rondel-manage-config"];

  try {
    const entries = await readdir(skillsDir);
    const missing = expected.filter((s) => !entries.includes(s));
    if (missing.length > 0) {
      return { name: "Framework skills", status: "warn", message: `Missing: ${missing.join(", ")}` };
    }
    return { name: "Framework skills", status: "pass", message: `${expected.length} skills at ${skillsDir}` };
  } catch {
    return { name: "Framework skills", status: "fail", message: `Skills directory not found: ${skillsDir}` };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
