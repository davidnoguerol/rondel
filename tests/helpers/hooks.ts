/**
 * Recording hooks for tests.
 *
 * Wraps a real `RondelHooks` instance and captures every `emit` call
 * into a `records` array so tests can assert on hook emissions without
 * wiring up real listeners.
 *
 * Use this whenever a test needs to pass a `RondelHooks` to source code
 * (e.g. scheduler constructor, ledger writer) or wants to verify that
 * a specific lifecycle event was emitted.
 */

import { RondelHooks } from "../../apps/daemon/src/shared/hooks.js";

export interface HookRecord {
  readonly event: string;
  readonly payload: unknown;
}

export interface RecordingHooks {
  readonly hooks: RondelHooks;
  readonly records: HookRecord[];
}

export function createRecordingHooks(): RecordingHooks {
  const hooks = new RondelHooks();
  const records: HookRecord[] = [];

  // Subscribe to all events by overriding emit before use.
  const originalEmit = hooks.emit.bind(hooks);
  hooks.emit = ((eventName: string, ...args: unknown[]) => {
    records.push({ event: eventName, payload: args[0] });
    return originalEmit(eventName as never, ...(args as never));
  }) as typeof hooks.emit;

  return { hooks, records };
}
