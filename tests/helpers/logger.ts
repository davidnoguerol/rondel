/**
 * Capturing Logger for tests.
 *
 * Implements the full `Logger` interface and pushes every call into a
 * `records` array so tests can inspect what was logged without polluting
 * stdout. Child loggers share the same `records` array so nested components
 * log into the same place.
 *
 * Tests should NOT assert on log message text (logs are not a contract).
 * This helper exists so tests can pass a `Logger` to source code without
 * side effects, not so tests can peek at log output.
 */

import type { Logger } from "../../apps/daemon/src/shared/logger.js";

export interface CapturingLogger extends Logger {
  readonly records: Array<{ level: "debug" | "info" | "warn" | "error"; component: string; msg: string; args: readonly unknown[] }>;
}

export function createCapturingLogger(component = "test"): CapturingLogger {
  const records: CapturingLogger["records"] = [];

  const make = (childComponent: string): CapturingLogger => {
    const push = (level: "debug" | "info" | "warn" | "error") =>
      (msg: string, ...args: unknown[]): void => {
        records.push({ level, component: childComponent, msg, args });
      };

    const logger: CapturingLogger = {
      records,
      debug: push("debug"),
      info: push("info"),
      warn: push("warn"),
      error: push("error"),
      child: (sub: string) => make(`${childComponent}:${sub}`),
    };
    return logger;
  };

  return make(component);
}
