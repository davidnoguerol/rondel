import { openSync, writeSync, renameSync, statSync } from "node:fs";

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const LEVEL_COLOR: Record<LogLevel, string> = {
  debug: "\x1b[90m",  // gray
  info: "\x1b[36m",   // cyan
  warn: "\x1b[33m",   // yellow
  error: "\x1b[31m",  // red
};

const RESET = "\x1b[0m";

/** Max log file size before rotation (10 MB). */
const MAX_LOG_SIZE = 10 * 1024 * 1024;

/** Module-level file descriptor for daemon log output. */
let globalLogFd: number | undefined;

/**
 * Initialize the global log file for daemon mode.
 * Rotates the existing log if it exceeds MAX_LOG_SIZE.
 * All subsequent logger instances will write to this file.
 */
export function initLogFile(logPath: string): void {
  // Simple size-based rotation: if > 10MB, rename to .log.1
  try {
    const stat = statSync(logPath);
    if (stat.size > MAX_LOG_SIZE) {
      renameSync(logPath, logPath + ".1");
    }
  } catch {
    // File doesn't exist yet — fine
  }

  globalLogFd = openSync(logPath, "a");
}

export interface Logger {
  debug(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
  child(component: string): Logger;
}

export function createLogger(component: string, minLevel: LogLevel = "info"): Logger {
  const minPriority = LEVEL_PRIORITY[minLevel];
  const isTTY = process.stdout.isTTY === true;

  function log(level: LogLevel, msg: string, args: unknown[]): void {
    if (LEVEL_PRIORITY[level] < minPriority) return;

    const now = new Date();
    const levelTag = level.toUpperCase().padEnd(5);

    // Format args into the message
    const fullMsg = args.length > 0
      ? `${msg} ${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}`
      : msg;

    // Write to log file (plain text, no ANSI, full ISO timestamp)
    if (globalLogFd !== undefined) {
      const fileLine = `${now.toISOString()} [${levelTag}] [${component}] ${fullMsg}\n`;
      writeSync(globalLogFd, fileLine);
    }

    // Write to console
    if (isTTY) {
      // Colored output for interactive terminals
      const timestamp = now.toISOString().slice(11, 23);
      const color = LEVEL_COLOR[level];
      const prefix = `${color}${timestamp} [${levelTag}]${RESET} [${component}]`;
      console.log(prefix, fullMsg);
    } else if (globalLogFd === undefined) {
      // No file, no TTY — plain console output (e.g. piped to another process)
      const timestamp = now.toISOString().slice(11, 23);
      console.log(`${timestamp} [${levelTag}] [${component}] ${fullMsg}`);
    }
    // If globalLogFd is set and not TTY (daemon mode), file-only — no console output
  }

  return {
    debug: (msg, ...args) => log("debug", msg, args),
    info: (msg, ...args) => log("info", msg, args),
    warn: (msg, ...args) => log("warn", msg, args),
    error: (msg, ...args) => log("error", msg, args),
    child: (childComponent) => createLogger(`${component}:${childComponent}`, minLevel),
  };
}
