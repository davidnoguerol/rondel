/**
 * Platform-aware OS service management.
 *
 * Installs Rondel as a system service that auto-starts on login
 * and auto-restarts on crash. Supports:
 *   - macOS: launchd (LaunchAgent plist)
 *   - Linux: systemd (user unit)
 *   - Windows: Task Scheduler (schtasks) with PowerShell restart wrapper
 *
 * The service runs the orchestrator in foreground mode from the service
 * manager's perspective. RONDEL_DAEMON=1 tells the orchestrator to
 * use file logging — the service manager IS the supervisor.
 */

import { execSync } from "node:child_process";
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { resolveRondelHome, rondelPaths } from "../config/config.js";

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface ServiceConfig {
  rondelHome: string;
  nodePath: string;
  entryPoint: string;
  envFilePath: string;
  logPath: string;
  claudePath: string;
}

export type ServiceStatus =
  | { installed: false }
  | { installed: true; running: boolean; pid?: number };

export interface ServiceBackend {
  readonly platform: string;
  install(config: ServiceConfig): Promise<void>;
  uninstall(): Promise<void>;
  stop(): Promise<void>;
  status(): Promise<ServiceStatus>;
  isInstalled(): Promise<boolean>;
}

/**
 * Get the service backend for the current platform.
 * Returns null on unsupported platforms (instead of throwing).
 */
export function getServiceBackend(): ServiceBackend | null {
  switch (process.platform) {
    case "darwin":
      return new LaunchdBackend();
    case "linux":
      return new SystemdBackend();
    case "win32":
      return new WindowsTaskSchedulerBackend();
    default:
      return null;
  }
}

/**
 * Build a ServiceConfig from the current environment.
 * Resolves all paths needed for service installation.
 */
export function buildServiceConfig(): ServiceConfig {
  const rondelHome = resolveRondelHome();
  const paths = rondelPaths(rondelHome);

  // Resolve the orchestrator entry point
  const thisFile = fileURLToPath(import.meta.url);
  const entryPoint = join(dirname(thisFile), "..", "index.js");

  // Discover claude CLI location
  let claudePath = "";
  try {
    const findCmd = process.platform === "win32" ? "where claude" : "which claude";
    claudePath = execSync(findCmd, { encoding: "utf-8" }).trim().split("\n")[0];
  } catch {
    // claude not found — will be flagged by doctor
  }

  return {
    rondelHome,
    nodePath: process.execPath,
    entryPoint,
    envFilePath: paths.env,
    logPath: paths.log,
    claudePath,
  };
}

// ---------------------------------------------------------------------------
// macOS launchd backend
// ---------------------------------------------------------------------------

const LAUNCHD_LABEL = "dev.rondel.orchestrator";
const PLIST_PATH = join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);

class LaunchdBackend implements ServiceBackend {
  readonly platform = "launchd";

  async install(config: ServiceConfig): Promise<void> {
    // Ensure LaunchAgents directory exists
    mkdirSync(dirname(PLIST_PATH), { recursive: true });

    // Build PATH that includes the directory containing `claude`
    const pathDirs = new Set<string>();
    pathDirs.add("/usr/local/bin");
    pathDirs.add("/usr/bin");
    pathDirs.add("/bin");
    pathDirs.add("/usr/sbin");
    pathDirs.add("/sbin");
    if (config.claudePath) {
      pathDirs.add(dirname(config.claudePath));
    }
    // Include node's directory
    pathDirs.add(dirname(config.nodePath));

    const pathValue = [...pathDirs].join(":");

    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(config.nodePath)}</string>
    <string>${escapeXml(config.entryPoint)}</string>
  </array>

  <key>EnvironmentVariables</key>
  <dict>
    <key>RONDEL_HOME</key>
    <string>${escapeXml(config.rondelHome)}</string>
    <key>RONDEL_DAEMON</key>
    <string>1</string>
    <key>PATH</key>
    <string>${escapeXml(pathValue)}</string>
  </dict>

  <key>WorkingDirectory</key>
  <string>${escapeXml(config.rondelHome)}</string>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>ThrottleInterval</key>
  <integer>5</integer>

  <key>StandardOutPath</key>
  <string>${escapeXml(config.logPath)}</string>

  <key>StandardErrorPath</key>
  <string>${escapeXml(config.logPath)}</string>
</dict>
</plist>
`;

    writeFileSync(PLIST_PATH, plist);

    // Bootstrap the service (load + start)
    const uid = execSync("id -u", { encoding: "utf-8" }).trim();
    try {
      // Bootout first in case it was previously loaded
      execSync(`launchctl bootout gui/${uid}/${LAUNCHD_LABEL} 2>/dev/null`, { encoding: "utf-8" });
    } catch {
      // Not loaded — fine
    }
    execSync(`launchctl bootstrap gui/${uid} ${PLIST_PATH}`);
  }

  async uninstall(): Promise<void> {
    const uid = execSync("id -u", { encoding: "utf-8" }).trim();
    try {
      execSync(`launchctl bootout gui/${uid}/${LAUNCHD_LABEL}`);
    } catch {
      // Not loaded — fine
    }
    if (existsSync(PLIST_PATH)) {
      unlinkSync(PLIST_PATH);
    }
  }

  async stop(): Promise<void> {
    const uid = execSync("id -u", { encoding: "utf-8" }).trim();
    // kickstart with -k kills the running job; launchd won't restart until we re-enable
    // Actually, we need to bootout to stop + prevent restart
    try {
      execSync(`launchctl bootout gui/${uid}/${LAUNCHD_LABEL}`);
    } catch {
      // Not loaded
    }
    // Re-load the plist but don't start (so it's still installed but stopped)
    // Actually, launchd with KeepAlive will restart. For a clean stop we bootout
    // and re-bootstrap when starting. The plist file remains on disk.
  }

  async status(): Promise<ServiceStatus> {
    if (!existsSync(PLIST_PATH)) {
      return { installed: false };
    }

    const uid = execSync("id -u", { encoding: "utf-8" }).trim();
    try {
      const output = execSync(`launchctl print gui/${uid}/${LAUNCHD_LABEL} 2>&1`, { encoding: "utf-8" });
      // Look for "pid = " in the output
      const pidMatch = output.match(/pid\s*=\s*(\d+)/);
      const pid = pidMatch ? parseInt(pidMatch[1], 10) : undefined;
      const running = pid !== undefined && pid > 0;
      return { installed: true, running, pid: running ? pid : undefined };
    } catch {
      // Not loaded but plist exists
      return { installed: true, running: false };
    }
  }

  async isInstalled(): Promise<boolean> {
    return existsSync(PLIST_PATH);
  }
}

// ---------------------------------------------------------------------------
// Linux systemd backend
// ---------------------------------------------------------------------------

const SYSTEMD_UNIT = "rondel.service";
const SYSTEMD_UNIT_PATH = join(homedir(), ".config", "systemd", "user", SYSTEMD_UNIT);

class SystemdBackend implements ServiceBackend {
  readonly platform = "systemd";

  async install(config: ServiceConfig): Promise<void> {
    // Ensure directory exists
    mkdirSync(dirname(SYSTEMD_UNIT_PATH), { recursive: true });

    // Build PATH
    const pathDirs: string[] = ["/usr/local/bin", "/usr/bin", "/bin"];
    if (config.claudePath) {
      pathDirs.push(dirname(config.claudePath));
    }
    pathDirs.push(dirname(config.nodePath));
    const pathValue = [...new Set(pathDirs)].join(":");

    const unit = `[Unit]
Description=Rondel Multi-Agent Orchestrator
After=network.target

[Service]
Type=simple
ExecStart=${config.nodePath} ${config.entryPoint}
WorkingDirectory=${config.rondelHome}
Environment=RONDEL_HOME=${config.rondelHome}
Environment=RONDEL_DAEMON=1
Environment=PATH=${pathValue}
EnvironmentFile=-${config.envFilePath}
Restart=always
RestartSec=5
StandardOutput=append:${config.logPath}
StandardError=append:${config.logPath}

[Install]
WantedBy=default.target
`;

    writeFileSync(SYSTEMD_UNIT_PATH, unit);

    execSync("systemctl --user daemon-reload");
    execSync("systemctl --user enable --now rondel.service");

    // Check if linger is enabled
    try {
      const user = execSync("whoami", { encoding: "utf-8" }).trim();
      const linger = execSync(`loginctl show-user ${user} -p Linger --value 2>/dev/null`, { encoding: "utf-8" }).trim();
      if (linger !== "yes") {
        console.log("");
        console.log("  \x1b[33mNote:\x1b[0m For Rondel to run without a login session,");
        console.log("  enable lingering with: sudo loginctl enable-linger $USER");
      }
    } catch {
      // Can't check linger — skip the hint
    }
  }

  async uninstall(): Promise<void> {
    try {
      execSync("systemctl --user disable --now rondel.service 2>/dev/null");
    } catch {
      // Not enabled
    }
    if (existsSync(SYSTEMD_UNIT_PATH)) {
      unlinkSync(SYSTEMD_UNIT_PATH);
    }
    try {
      execSync("systemctl --user daemon-reload");
    } catch {
      // Best effort
    }
  }

  async stop(): Promise<void> {
    execSync("systemctl --user stop rondel.service");
  }

  async status(): Promise<ServiceStatus> {
    if (!existsSync(SYSTEMD_UNIT_PATH)) {
      return { installed: false };
    }

    try {
      const active = execSync("systemctl --user is-active rondel.service 2>/dev/null", { encoding: "utf-8" }).trim();
      const running = active === "active";

      let pid: number | undefined;
      if (running) {
        try {
          const pidStr = execSync("systemctl --user show rondel.service -p MainPID --value 2>/dev/null", { encoding: "utf-8" }).trim();
          pid = parseInt(pidStr, 10) || undefined;
        } catch {
          // Can't get PID
        }
      }

      return { installed: true, running, pid };
    } catch {
      return { installed: true, running: false };
    }
  }

  async isInstalled(): Promise<boolean> {
    return existsSync(SYSTEMD_UNIT_PATH);
  }
}

// ---------------------------------------------------------------------------
// Windows Task Scheduler backend
// ---------------------------------------------------------------------------

const SCHTASKS_NAME = "Rondel";
const RUNNER_SCRIPT_NAME = "rondel-runner.ps1";

class WindowsTaskSchedulerBackend implements ServiceBackend {
  readonly platform = "Task Scheduler";

  private runnerPath(config: ServiceConfig): string {
    return join(dirname(config.logPath), RUNNER_SCRIPT_NAME);
  }

  async install(config: ServiceConfig): Promise<void> {
    // Build PATH
    const pathDirs: string[] = [];
    if (config.claudePath) {
      pathDirs.push(dirname(config.claudePath));
    }
    pathDirs.push(dirname(config.nodePath));
    const pathAdditions = pathDirs.map((d) => `$env:PATH = "${d};$env:PATH"`).join("\n");

    // Write a PowerShell restart wrapper — provides crash recovery
    // Clean exit (code 0) breaks the loop; non-zero restarts after 5s
    const runnerPath = this.runnerPath(config);
    const script = `# Rondel restart wrapper (auto-generated — do not edit)
$env:RONDEL_HOME = "${config.rondelHome}"
$env:RONDEL_DAEMON = "1"
${pathAdditions}

while ($true) {
    $proc = Start-Process -NoNewWindow -Wait -PassThru -FilePath "${config.nodePath}" -ArgumentList "${config.entryPoint}" -RedirectStandardOutput "${config.logPath}" -RedirectStandardError "${config.logPath}"
    if ($proc.ExitCode -eq 0) { break }
    Start-Sleep -Seconds 5
}
`;
    writeFileSync(runnerPath, script);

    // Create scheduled task — runs at logon, hidden window
    const taskCmd = [
      "schtasks", "/Create",
      "/TN", `"${SCHTASKS_NAME}"`,
      "/TR", `"powershell -WindowStyle Hidden -ExecutionPolicy Bypass -File \\"${runnerPath}\\""`,
      "/SC", "ONLOGON",
      "/RL", "HIGHEST",
      "/F",
    ].join(" ");

    execSync(taskCmd);

    // Start the task immediately
    execSync(`schtasks /Run /TN "${SCHTASKS_NAME}"`);
  }

  async uninstall(): Promise<void> {
    // Stop first
    try {
      await this.stop();
    } catch {
      // May not be running
    }

    // Delete the scheduled task
    try {
      execSync(`schtasks /Delete /TN "${SCHTASKS_NAME}" /F`);
    } catch {
      // Task doesn't exist
    }

    // Clean up runner script
    const rondelHome = resolveRondelHome();
    const paths = rondelPaths(rondelHome);
    const runnerPath = join(paths.state, RUNNER_SCRIPT_NAME);
    if (existsSync(runnerPath)) {
      unlinkSync(runnerPath);
    }
  }

  async stop(): Promise<void> {
    // Read PID from lockfile and kill the node process
    // The PowerShell wrapper will see exit code non-zero, but since we also
    // kill the wrapper via taskkill /T (tree kill), the whole chain stops
    const rondelHome = resolveRondelHome();
    const paths = rondelPaths(rondelHome);
    const { readInstanceLock } = await import("./instance-lock.js");
    const lock = readInstanceLock(paths.state);
    if (lock) {
      try {
        // Tree kill — kills the PowerShell wrapper + node process
        execSync(`taskkill /PID ${lock.pid} /T /F 2>nul`, { encoding: "utf-8" });
      } catch {
        // Already dead
      }
    }
  }

  async status(): Promise<ServiceStatus> {
    try {
      const output = execSync(`schtasks /Query /TN "${SCHTASKS_NAME}" /FO CSV /NH 2>nul`, { encoding: "utf-8" }).trim();
      if (!output) return { installed: false };

      // CSV format: "TaskName","Next Run Time","Status"
      const running = output.toLowerCase().includes("running");

      // Get PID from lockfile if running
      let pid: number | undefined;
      if (running) {
        const rondelHome = resolveRondelHome();
        const paths = rondelPaths(rondelHome);
        const { readInstanceLock } = await import("./instance-lock.js");
        const lock = readInstanceLock(paths.state);
        pid = lock?.pid;
      }

      return { installed: true, running, pid };
    } catch {
      return { installed: false };
    }
  }

  async isInstalled(): Promise<boolean> {
    try {
      execSync(`schtasks /Query /TN "${SCHTASKS_NAME}" /FO CSV /NH 2>nul`, { encoding: "utf-8" });
      return true;
    } catch {
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
