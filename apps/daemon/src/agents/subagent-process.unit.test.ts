/**
 * SubagentProcess teardown contract.
 *
 * Mocks `node:child_process` at the edge (per docs/TESTING.md §7 — Node
 * primitives are legitimate mock targets). Asserts the lifecycle contract
 * that the orphan-process leak required: after `done` resolves, the child's
 * stdin has been closed and the daemon will not be left holding an idle
 * `claude -p` process forever.
 *
 * Specifically guards against the regression that produced 67 lingering
 * scheduled-task processes in production:
 *  - the spawn-time `stdin.end()` that signals EOF to `claude -p`
 *  - the SIGTERM/SIGKILL escalation in `tearDownChild()` for CLI versions
 *    that ignore stdin EOF
 *  - idempotency under double-kill / kill-after-finish
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import type { Writable } from "node:stream";

// --- Fake child wired into the spawn mock ----------------------------------

interface FakeChild extends EventEmitter {
  stdin: FakeWritable;
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
  killSignals: string[];
  /** Test helper: emit a single stream-json line on stdout. */
  emitLine(line: string): void;
  /** Test helper: drive the readline 'line' callback directly. */
  emitExit(code: number | null, signal: string | null): void;
}

interface FakeWritable {
  write: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  endCalls: number;
  // Streams referenced by the source via optional chaining (`stdin?.end`)
  // need at least these two members to satisfy the call sites.
}

let fakeChildren: FakeChild[] = [];
let pendingLineHandler: ((line: string) => void) | null = null;

function makeFakeChild(): FakeChild {
  const ee = new EventEmitter() as FakeChild;
  const stdin: FakeWritable = {
    write: vi.fn(),
    end: vi.fn(),
    endCalls: 0,
  };
  // Counter wrapper so we can read `endCalls` without poking into mock.calls
  const realEnd = stdin.end;
  stdin.end = vi.fn((...args: unknown[]) => {
    stdin.endCalls += 1;
    return realEnd(...args);
  });

  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  ee.stdin = stdin;
  ee.stdout = stdout;
  ee.stderr = stderr;
  ee.killSignals = [];
  ee.kill = vi.fn((signal: string) => {
    ee.killSignals.push(signal);
    return true;
  });
  ee.emitLine = (line: string) => {
    if (pendingLineHandler) pendingLineHandler(line);
  };
  ee.emitExit = (code, signal) => {
    ee.emit("exit", code, signal);
  };
  return ee;
}

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => {
    const child = makeFakeChild();
    fakeChildren.push(child);
    return child;
  }),
}));

// `createInterface` reads stdout line-by-line in the source. We capture the
// 'line' handler so test code can drive it via `child.emitLine()`.
vi.mock("node:readline", () => ({
  createInterface: vi.fn(() => {
    const rl = new EventEmitter() as EventEmitter & { on: EventEmitter["on"] };
    const realOn = rl.on.bind(rl);
    rl.on = (event: string, listener: (...a: unknown[]) => void) => {
      if (event === "line") {
        pendingLineHandler = listener as (line: string) => void;
      }
      return realOn(event, listener);
    };
    return rl;
  }),
}));

// Avoid disk writes for the MCP config side-channel.
vi.mock("node:fs", () => ({
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

// Skip the framework-skills resolver — irrelevant to this test.
vi.mock("../shared/paths.js", () => ({
  resolveFrameworkSkillsDir: () => "/tmp/framework-skills",
}));

// Avoid pulling the transcript machinery (it has its own real fs touches).
vi.mock("../shared/transcript.js", () => ({
  appendTranscriptEntry: vi.fn(),
}));

// `agent-process.ts` exports `FRAMEWORK_DISALLOWED_TOOLS`. Stub it so we
// don't drag the full module (and its imports) into this unit test.
vi.mock("./agent-process.js", () => ({
  FRAMEWORK_DISALLOWED_TOOLS: [] as readonly string[],
}));

// Imported AFTER all mocks so the source picks up the fakes.
import { SubagentProcess, type SubagentOptions } from "./subagent-process.js";

// --- Tiny inline Logger (no Rondel helpers needed) -------------------------

function noopLogger(): import("../shared/logger.js").Logger {
  const fn = (..._args: unknown[]) => {};
  const logger = {
    debug: fn, info: fn, warn: fn, error: fn,
    child: (_: string) => logger,
  };
  return logger as unknown as import("../shared/logger.js").Logger;
}

// --- Fixture factory --------------------------------------------------------

function makeOptions(overrides: Partial<SubagentOptions> = {}): SubagentOptions {
  return {
    id: "test-subagent",
    task: "do the thing",
    systemPrompt: "you are a test",
    model: "sonnet",
    timeoutMs: 60_000,
    ...overrides,
  };
}

function emitResult(child: FakeChild, opts: { isError?: boolean; cost?: number; text?: string } = {}): void {
  // Mirror what `claude -p` emits in stream-json mode: an `assistant` text
  // event followed by a `result` terminator.
  child.emitLine(JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text: opts.text ?? "ok" }] },
  }));
  child.emitLine(JSON.stringify({
    type: "result",
    is_error: opts.isError === true,
    total_cost_usd: opts.cost,
  }));
}

// --- Tests ------------------------------------------------------------------

describe("SubagentProcess.start", () => {
  beforeEach(() => {
    fakeChildren = [];
    pendingLineHandler = null;
    vi.useFakeTimers();
  });

  it("closes the child's stdin immediately after sending the task (signals EOF to claude -p)", () => {
    const sub = new SubagentProcess(makeOptions(), noopLogger());
    sub.start();

    expect(fakeChildren).toHaveLength(1);
    const child = fakeChildren[0];

    // Both sides of the contract: the user message was written, AND
    // stdin was ended. Without the `end()`, the CLI blocks on its read
    // loop forever after emitting the result frame.
    expect(child.stdin.write).toHaveBeenCalledTimes(1);
    expect(child.stdin.endCalls).toBeGreaterThanOrEqual(1);

    sub.kill(); // cleanup pending timeout
  });
});

describe("SubagentProcess.done resolution → teardown", () => {
  beforeEach(() => {
    fakeChildren = [];
    pendingLineHandler = null;
    vi.useFakeTimers();
  });

  it("after done resolves with a result, the child is escalated to SIGTERM if it doesn't exit on its own", async () => {
    const sub = new SubagentProcess(makeOptions(), noopLogger());
    sub.start();
    const child = fakeChildren[0];

    emitResult(child, { cost: 0.0042 });

    const result = await sub.done;
    expect(result.state).toBe("completed");

    // `done` resolved — but the child has not emitted 'exit' yet.
    // tearDownChild() must be racing a SIGTERM grace timer.
    expect(child.killSignals).toEqual([]); // not yet — grace period

    // Advance past the grace window. SIGTERM should now fire.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(child.killSignals).toContain("SIGTERM");

    // Still no exit → SIGKILL escalates after the second timer.
    await vi.advanceTimersByTimeAsync(3_000);
    expect(child.killSignals).toContain("SIGKILL");
  });

  it("if the child exits cleanly during the grace window, no signal is ever sent", async () => {
    const sub = new SubagentProcess(makeOptions(), noopLogger());
    sub.start();
    const child = fakeChildren[0];

    emitResult(child);
    await sub.done;

    // Child exits on its own (the happy path — stdin EOF was enough).
    child.emitExit(0, null);

    // Even if we let both timers' worth of time pass, no signal goes out
    // because the 'exit' listener cancelled them.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(child.killSignals).toEqual([]);
  });

  it("on a result with is_error: true, finish() still tears the child down", async () => {
    const sub = new SubagentProcess(makeOptions(), noopLogger());
    sub.start();
    const child = fakeChildren[0];

    emitResult(child, { isError: true, text: "bang" });
    const result = await sub.done;
    expect(result.state).toBe("failed");

    await vi.advanceTimersByTimeAsync(2_000);
    expect(child.killSignals).toContain("SIGTERM");
  });
});

describe("SubagentProcess.kill / timeout", () => {
  beforeEach(() => {
    fakeChildren = [];
    pendingLineHandler = null;
    vi.useFakeTimers();
  });

  it("explicit kill() before any result resolves done with the killed state and tears the child down", async () => {
    const sub = new SubagentProcess(makeOptions(), noopLogger());
    sub.start();
    const child = fakeChildren[0];

    sub.kill();

    const result = await sub.done;
    expect(result.state).toBe("killed");

    await vi.advanceTimersByTimeAsync(2_000);
    expect(child.killSignals).toContain("SIGTERM");
  });

  it("the configured timeoutMs forces a kill if the CLI never produces a result frame", async () => {
    const sub = new SubagentProcess(makeOptions({ timeoutMs: 1_000 }), noopLogger());
    sub.start();
    const child = fakeChildren[0];

    // Advance past the timeout — start() registered a setTimeout that will
    // call kill("timeout") → finish("timeout", …) → tearDownChild().
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await sub.done;
    expect(result.state).toBe("timeout");

    // And the child's still hanging around → SIGTERM gets it.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(child.killSignals).toContain("SIGTERM");
  });

  it("kill() after finish() is idempotent — does not double-resolve and does not double-fire signals", async () => {
    const sub = new SubagentProcess(makeOptions(), noopLogger());
    sub.start();
    const child = fakeChildren[0];

    emitResult(child);
    await sub.done;

    // Drain the SIGTERM timer so we have a known signal count.
    await vi.advanceTimersByTimeAsync(2_000);
    const sigtermsBefore = child.killSignals.filter((s) => s === "SIGTERM").length;
    expect(sigtermsBefore).toBe(1);

    // Second kill() after finish — must not crash, must not fire SIGTERM
    // again (the process reference was cleared by the first teardown).
    sub.kill();
    await vi.advanceTimersByTimeAsync(2_000);
    const sigtermsAfter = child.killSignals.filter((s) => s === "SIGTERM").length;
    expect(sigtermsAfter).toBe(1);
  });
});
