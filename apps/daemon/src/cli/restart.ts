import { resolveRondelHome, rondelPaths } from "../config/config.js";
import { readInstanceLock } from "../system/instance-lock.js";
import { buildServiceConfig, getServiceBackend } from "../system/service.js";
import { error, info, success, warn } from "./prompt.js";

/**
 * rondel restart — cycle the running daemon.
 *
 * Supervisor-aware. Four cases:
 *
 *   1. Service backend available + installed → `backend.restart()`
 *      (each platform's idiomatic restart primitive: `launchctl
 *      kickstart -k`, `systemctl restart`, `schtasks End+Run`). No
 *      plist/unit rewrite, no race.
 *   2. Service backend available but NOT installed → `backend.install()`.
 *      Same outcome as `rondel start` — we don't penalize the user
 *      for the word they chose.
 *   3. No service backend but a live foreground lockfile exists →
 *      SIGTERM the PID and tell the user how to bring it back up.
 *      We don't try to respawn a detached foreground daemon from the
 *      CLI — that's what `rondel service install` is for.
 *   4. Nothing is running and there's no service → tell the user to
 *      run `rondel start`.
 *
 * If the service definition itself needs refreshing (e.g. node path
 * changed), use `rondel service install` — it rewrites the
 * plist/unit and reloads. `restart` is just "bounce the running
 * process".
 */
export async function runRestart(): Promise<void> {
  const rondelHome = resolveRondelHome();
  const paths = rondelPaths(rondelHome);
  const backend = getServiceBackend();
  const lock = readInstanceLock(paths.state);

  // Path 1/2: platform has a service manager — let it own the restart.
  if (backend) {
    const installed = await backend.isInstalled();
    if (!installed) {
      info(`No Rondel service installed — installing and starting via ${backend.platform}...`);
      const config = buildServiceConfig();
      if (!config.claudePath) {
        warn("Could not find 'claude' CLI in PATH. Agents will fail to spawn.");
      }
      try {
        await backend.install(config);
      } catch (err) {
        error(`Failed to install service: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
      success("Rondel service installed and started.");
      info(`Auto-restart on crash is now active. Logs: ${paths.log}`);
      return;
    }

    info(`Restarting via ${backend.platform}...`);
    try {
      await backend.restart();
    } catch (err) {
      error(`Failed to restart service: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
    success("Rondel service restarted.");
    return;
  }

  // Path 3: foreground mode — best we can do is stop it cleanly.
  if (lock) {
    info(`Rondel is running in the foreground (PID ${lock.pid}). Stopping it...`);
    try {
      process.kill(lock.pid, "SIGTERM");
    } catch {
      info("Process already exited.");
    }
    console.log("");
    warn(
      `Platform ${process.platform} has no supported service manager.`,
    );
    info("Rondel will NOT auto-restart. Bring it back up with:");
    info("  rondel start");
    return;
  }

  // Path 4: nothing to restart.
  error("Rondel is not running and no service backend is available on this platform.");
  info("Start it manually with: rondel start");
  process.exit(1);
}
