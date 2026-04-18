import { describe, it, expect } from "vitest";
import { clampTimeoutMs } from "./bash.js";
import { resolveBridgeContext } from "./_common.js";
import { classifyBash } from "../shared/safety/index.js";

/**
 * Pure-function tests for rondel_bash helpers. No spawn, no bridge, no
 * network. The handler-level tests that exercise the MCP wiring live in
 * bash.integration.test.ts.
 */

describe("clampTimeoutMs", () => {
  it("returns the default when input is undefined", () => {
    expect(clampTimeoutMs(undefined)).toBe(120_000);
  });

  it("clamps below-min to MIN_TIMEOUT_MS (1000)", () => {
    expect(clampTimeoutMs(0)).toBe(1_000);
    expect(clampTimeoutMs(100)).toBe(1_000);
    expect(clampTimeoutMs(999)).toBe(1_000);
  });

  it("clamps negatives to min", () => {
    expect(clampTimeoutMs(-500)).toBe(1_000);
  });

  it("clamps above-max to MAX_TIMEOUT_MS (600000)", () => {
    expect(clampTimeoutMs(600_001)).toBe(600_000);
    expect(clampTimeoutMs(10_000_000)).toBe(600_000);
  });

  it("passes in-range values through unchanged", () => {
    expect(clampTimeoutMs(5_000)).toBe(5_000);
    expect(clampTimeoutMs(60_000)).toBe(60_000);
  });

  it("floors fractional values", () => {
    expect(clampTimeoutMs(5_000.9)).toBe(5_000);
  });

  it("falls back to default for non-finite inputs", () => {
    expect(clampTimeoutMs(Number.NaN)).toBe(120_000);
    expect(clampTimeoutMs(Number.POSITIVE_INFINITY)).toBe(120_000);
  });
});

describe("resolveBridgeContext (shared via _common.ts)", () => {
  it("returns undefined when RONDEL_BRIDGE_URL is missing", () => {
    const ctx = resolveBridgeContext({
      RONDEL_PARENT_AGENT: "bot1",
      RONDEL_PARENT_CHAT_ID: "123",
    });
    expect(ctx).toBeUndefined();
  });

  it("returns undefined when RONDEL_PARENT_AGENT is missing", () => {
    const ctx = resolveBridgeContext({
      RONDEL_BRIDGE_URL: "http://127.0.0.1:9999",
      RONDEL_PARENT_CHAT_ID: "123",
    });
    expect(ctx).toBeUndefined();
  });

  it("returns undefined when RONDEL_PARENT_CHAT_ID is missing", () => {
    const ctx = resolveBridgeContext({
      RONDEL_BRIDGE_URL: "http://127.0.0.1:9999",
      RONDEL_PARENT_AGENT: "bot1",
    });
    expect(ctx).toBeUndefined();
  });

  it("defaults channelType to 'internal' when unset", () => {
    const ctx = resolveBridgeContext({
      RONDEL_BRIDGE_URL: "http://127.0.0.1:9999",
      RONDEL_PARENT_AGENT: "bot1",
      RONDEL_PARENT_CHAT_ID: "123",
    });
    expect(ctx).toBeDefined();
    expect(ctx!.channelType).toBe("internal");
  });

  it("uses provided channelType when set", () => {
    const ctx = resolveBridgeContext({
      RONDEL_BRIDGE_URL: "http://127.0.0.1:9999",
      RONDEL_PARENT_AGENT: "bot1",
      RONDEL_PARENT_CHANNEL_TYPE: "telegram",
      RONDEL_PARENT_CHAT_ID: "123",
    });
    expect(ctx?.channelType).toBe("telegram");
  });

  it("returns the full context when all required vars are set", () => {
    const ctx = resolveBridgeContext({
      RONDEL_BRIDGE_URL: "http://127.0.0.1:9999",
      RONDEL_PARENT_AGENT: "alice",
      RONDEL_PARENT_CHANNEL_TYPE: "web",
      RONDEL_PARENT_CHAT_ID: "web-42",
    });
    expect(ctx).toEqual({
      bridgeUrl: "http://127.0.0.1:9999",
      agent: "alice",
      channelType: "web",
      chatId: "web-42",
      sessionId: "",
    });
  });
});

describe("rondel_bash consumes classifyBash from shared/safety", () => {
  // Sanity check: the classification outcomes we rely on in bash.ts
  // actually come out of the shared safety module. Guards against a
  // future safety refactor accidentally dropping one of these cases.

  it("allows a safe command", () => {
    expect(classifyBash("ls -la /tmp").classification).toBe("allow");
  });

  it("escalates rm -rf /", () => {
    const result = classifyBash("rm -rf /");
    expect(result.classification).toBe("escalate");
    expect(result.reason).toBe("dangerous_bash");
  });

  it("escalates chained dangerous commands", () => {
    const result = classifyBash("echo hi && rm -rf /");
    expect(result.classification).toBe("escalate");
  });

  it("escalates dd", () => {
    // `dd` is a dedicated pattern that survives the pipe-split gap.
    const result = classifyBash("dd if=/dev/zero of=/dev/sda");
    expect(result.classification).toBe("escalate");
    expect(result.reason).toBe("dangerous_bash");
  });

  it("escalates writes to /etc", () => {
    const result = classifyBash("echo x > /etc/hosts");
    expect(result.classification).toBe("escalate");
    expect(result.reason).toBe("bash_system_write");
  });
});
