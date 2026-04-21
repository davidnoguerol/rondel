import { spawn } from "node:child_process";
import { resolveRondelHome, rondelPaths } from "../config/config.js";
import { readInstanceLock } from "../system/instance-lock.js";
import { getServiceBackend, buildServiceConfig } from "../system/service.js";
import { error, info, success, warn } from "./prompt.js";

/**
 * rondel start — ensure the Rondel daemon is running.
 *
 * This is the canonical entry point. The design: Rondel runs as a
 * supervised service (launchd / systemd / Task Scheduler). `rondel
 * start` makes that true idempotently — if nothing is installed, it
 * installs the service; if the service is installed but stopped, it
 * (re)bootstraps it; if something is already running, it reports
 * status and exits 0.
 *
 * On platforms without a supported service backend, `rondel start`
 * falls back to running the daemon in the foreground (equivalent to
 * `node dist/index.js`). That's a degraded mode — the user is the
 * supervisor — and we say so loudly.
 *
 * Related: `pnpm start` from the workspace root is the dev-only
 * foreground path; it bypasses the service manager on purpose so
 * developers can iterate on the daemon code without reinstalling.
 */
export async function runStart(): Promise<void> {
  const rondelHome = resolveRondelHome();
  const paths = rondelPaths(rondelHome);

  // 1. Already running? Respect the existing process — don't stomp it.
  const lock = readInstanceLock(paths.state);
  if (lock) {
    success(`Rondel is already running (PID ${lock.pid}).`);
    if (lock.bridgeUrl) info(`Bridge: ${lock.bridgeUrl}`);
    if (lock.logPath) info(`Logs:   ${lock.logPath}`);
    return;
  }

  const backend = getServiceBackend();

  // 2. No service backend for this platform → foreground fallback.
  if (!backend) {
    warn(
      `Platform ${process.platform} has no supported service manager.`,
    );
    info("Starting Rondel in the foreground — this process IS the daemon.");
    info("Stop with Ctrl+C. Rondel will NOT auto-restart on crash.");
    console.log("");
    await runForeground();
    return;
  }

  // 3. Service backend available — make sure the service is installed
  //    and bootstrapped. `install()` is designed to be idempotent
  //    (bootout-then-bootstrap), so calling it also safely cycles a
  //    stopped-but-installed service.
  const config = buildServiceConfig();
  if (!config.claudePath) {
    warn("Could not find 'claude' CLI in PATH. Agents will fail to spawn.");
    info("Install the Claude CLI, then run 'rondel start' again.");
  }

  const installed = await backend.isInstalled();
  info(
    installed
      ? `Bootstrapping Rondel service (${backend.platform})...`
      : `Installing Rondel service (${backend.platform})...`,
  );

  try {
    await backend.install(config);
  } catch (err) {
    error(`Failed to start service: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  // 4. Wait briefly for the daemon to write its lockfile — confirmation
  //    that the supervisor actually brought it up, not just that the
  //    service manager accepted our request.
  const ok = await waitForLock(paths.state, 10_000);
  if (!ok) {
    warn("Service was installed but the daemon has not written a lockfile yet.");
    info("Check logs: rondel logs -f");
    process.exit(1);
  }

  console.log("");
  success("Rondel is running.");
  info(`Auto-start:   on login`);
  info(`Auto-restart: on crash (5s delay)`);
  info(`Logs:         ${paths.log}`);
  console.log("");
  info("Check status with: rondel status");
}

/**
 * Spawn the orchestrator in the foreground (same semantics as
 * `node dist/index.js` — foreground mode, console logging). We `exec`
 * by replacing the CLI process with the daemon so Ctrl+C goes to the
 * daemon directly.
 */
async function runForeground(): Promise<void> {
  // Resolve daemon entry point relative to this compiled file.
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");
  const thisFile = fileURLToPath(import.meta.url);
  const entryPoint = join(dirname(thisFile), "..", "index.js");

  const child = spawn(process.execPath, [entryPoint], {
    stdio: "inherit",
    env: { ...process.env },
  });

  // Forward signals so Ctrl+C in the CLI cleanly stops the daemon.
  const forward = (sig: NodeJS.Signals) => () => {
    try { child.kill(sig); } catch { /* already dead */ }
  };
  process.on("SIGINT", forward("SIGINT"));
  process.on("SIGTERM", forward("SIGTERM"));

  await new Promise<void>((resolve) => {
    child.on("exit", (code) => {
      process.exit(code ?? 0);
      resolve();
    });
  });
}

/**
 * Poll for the daemon's instance lockfile to appear. Returns true
 * once the lockfile points at a live PID, false on timeout.
 */
async function waitForLock(stateDir: string, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const lock = readInstanceLock(stateDir);
    if (lock) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}
