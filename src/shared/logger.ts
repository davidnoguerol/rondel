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

export interface Logger {
  debug(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
  child(component: string): Logger;
}

export function createLogger(component: string, minLevel: LogLevel = "info"): Logger {
  const minPriority = LEVEL_PRIORITY[minLevel];

  function log(level: LogLevel, msg: string, args: unknown[]): void {
    if (LEVEL_PRIORITY[level] < minPriority) return;

    const timestamp = new Date().toISOString().slice(11, 23); // HH:mm:ss.SSS
    const color = LEVEL_COLOR[level];
    const prefix = `${color}${timestamp} [${level.toUpperCase().padEnd(5)}]${RESET} [${component}]`;

    if (args.length > 0) {
      console.log(prefix, msg, ...args);
    } else {
      console.log(prefix, msg);
    }
  }

  return {
    debug: (msg, ...args) => log("debug", msg, args),
    info: (msg, ...args) => log("info", msg, args),
    warn: (msg, ...args) => log("warn", msg, args),
    error: (msg, ...args) => log("error", msg, args),
    child: (childComponent) => createLogger(`${component}:${childComponent}`, minLevel),
  };
}
