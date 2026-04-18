import { describe, it, expect, vi } from "vitest";
import { join } from "node:path";
import { ApprovalService } from "./approval-service.js";
import { listPending, listResolved, type ApprovalPaths } from "./approval-store.js";
import { createHooks } from "../shared/hooks.js";
import { createLogger } from "../shared/logger.js";
import { withTmpRondel } from "../../tests/helpers/tmp.js";
import type { ChannelRegistry } from "../channels/core/registry.js";
import type { ChannelAdapter } from "../channels/core/channel.js";

function paths(stateDir: string): ApprovalPaths {
  return {
    pendingDir: join(stateDir, "approvals", "pending"),
    resolvedDir: join(stateDir, "approvals", "resolved"),
  };
}

function makeSpyAdapter(opts?: { throwOnSend?: boolean }): { adapter: ChannelAdapter; sent: unknown[] } {
  const sent: unknown[] = [];
  const adapter: ChannelAdapter = {
    id: "telegram",
    supportsInteractive: true,
    addAccount: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    startAccount: vi.fn(),
    removeAccount: vi.fn(),
    onMessage: vi.fn(),
    sendText: vi.fn(),
    startTypingIndicator: vi.fn(),
    stopTypingIndicator: vi.fn(),
    sendInteractive: vi.fn(async (accountId, chatId, text, buttons) => {
      if (opts?.throwOnSend) throw new Error("Telegram API error");
      sent.push({ accountId, chatId, text, buttons });
    }),
    onInteractiveCallback: vi.fn(),
  };
  return { adapter, sent };
}

function makeRegistry(adapter: ChannelAdapter): ChannelRegistry {
  return {
    get: (channelType: string) => (channelType === "telegram" ? adapter : undefined),
  } as unknown as ChannelRegistry;
}

function makeService(tmpStateDir: string, adapter: ChannelAdapter) {
  const hooks = createHooks();
  const service = new ApprovalService({
    paths: paths(tmpStateDir),
    hooks,
    channels: makeRegistry(adapter),
    resolveAccountId: (_agent, channelType) => (channelType === "telegram" ? "bot1" : undefined),
    log: createLogger("test"),
  });
  return { service, hooks };
}

describe("ApprovalService.resolve — concurrency guard", () => {
  it("emits approval:resolved exactly once when two resolve() calls race", async () => {
    const tmp = withTmpRondel();
    const { adapter } = makeSpyAdapter();
    const { service, hooks } = makeService(tmp.stateDir, adapter);
    await service.init();

    const resolvedFn = vi.fn();
    hooks.on("approval:resolved", resolvedFn);

    const { requestId, decision } = await service.requestToolUse({
      agentName: "bot1",
      channelType: "telegram",
      chatId: "123",
      toolName: "Bash",
      toolInput: { command: "rm -rf /" },
      reason: "dangerous_bash",
    });

    // Fire both resolves in the same microtask — both observe
    // resolving.has(id) === false synchronously, but only one passes
    // the add guard.
    const a = service.resolve(requestId, "allow", "user-a");
    const b = service.resolve(requestId, "deny", "user-b");
    await Promise.all([a, b]);

    // Exactly one event, exactly one resolved record, exactly one
    // in-process decision.
    expect(resolvedFn).toHaveBeenCalledTimes(1);
    const resolved = await listResolved(paths(tmp.stateDir));
    expect(resolved).toHaveLength(1);

    // The in-process decision Promise resolves to whichever call won
    // the race — assert it's one of the two we submitted.
    await expect(decision).resolves.toMatch(/^(allow|deny)$/);
  });

  it("suppresses the timeout auto-deny when a real decision races it", async () => {
    // Force a tiny timeout so the timer fires fast. Then resolve(allow)
    // synchronously before awaiting — the decision wins.
    const savedTimeout = process.env.RONDEL_APPROVAL_TIMEOUT_MS;
    process.env.RONDEL_APPROVAL_TIMEOUT_MS = "60";
    try {
      const tmp = withTmpRondel();
      const { adapter } = makeSpyAdapter();
      const { service, hooks } = makeService(tmp.stateDir, adapter);
      await service.init();

      const resolvedFn = vi.fn();
      hooks.on("approval:resolved", resolvedFn);

      const { requestId } = await service.requestToolUse({
        agentName: "bot1",
        channelType: "telegram",
        chatId: "123",
        toolName: "Bash",
        toolInput: { command: "rm -rf /" },
        reason: "dangerous_bash",
      });

      // Resolve from the user path immediately — beats the 60ms timer.
      await service.resolve(requestId, "allow", "user-a");

      // Let the timer fire.
      await new Promise((r) => setTimeout(r, 120));

      expect(resolvedFn).toHaveBeenCalledTimes(1);
      const resolved = await listResolved(paths(tmp.stateDir));
      expect(resolved).toHaveLength(1);
      expect(resolved[0].decision).toBe("allow");
      expect(resolved[0].resolvedBy).toBe("user-a");
    } finally {
      if (savedTimeout === undefined) delete process.env.RONDEL_APPROVAL_TIMEOUT_MS;
      else process.env.RONDEL_APPROVAL_TIMEOUT_MS = savedTimeout;
    }
  });
});

describe("ApprovalService.resolve — edge cases", () => {
  it("is idempotent — second resolve on same id is a no-op", async () => {
    const tmp = withTmpRondel();
    const { adapter } = makeSpyAdapter();
    const { service, hooks } = makeService(tmp.stateDir, adapter);
    await service.init();

    const resolvedFn = vi.fn();
    hooks.on("approval:resolved", resolvedFn);

    const { requestId } = await service.requestToolUse({
      agentName: "bot1",
      channelType: "telegram",
      chatId: "123",
      toolName: "Bash",
      toolInput: { command: "rm -rf /" },
      reason: "dangerous_bash",
    });

    await service.resolve(requestId, "allow", "user1");
    await service.resolve(requestId, "deny", "user2"); // second call — no-op

    expect(resolvedFn).toHaveBeenCalledTimes(1);
    const resolved = await listResolved(paths(tmp.stateDir));
    expect(resolved).toHaveLength(1);
    expect(resolved[0].decision).toBe("allow"); // first decision wins
  });

  it("no-ops when resolving a nonexistent requestId", async () => {
    const tmp = withTmpRondel();
    const { adapter } = makeSpyAdapter();
    const { service } = makeService(tmp.stateDir, adapter);
    await service.init();

    // Should not throw — uses a valid format but nonexistent id
    await expect(service.resolve("appr_9999999_deadbeef", "allow", "user1")).resolves.toBeUndefined();
  });
});

describe("ApprovalService.getById — resolved records", () => {
  it("returns resolved records after resolution", async () => {
    const tmp = withTmpRondel();
    const { adapter } = makeSpyAdapter();
    const { service } = makeService(tmp.stateDir, adapter);
    await service.init();

    const { requestId } = await service.requestToolUse({
      agentName: "bot1",
      channelType: "telegram",
      chatId: "123",
      toolName: "Write",
      toolInput: { file_path: "/etc/passwd", content: "x" },
      reason: "write_outside_safezone",
    });

    await service.resolve(requestId, "deny", "user1");

    const record = await service.getById(requestId);
    expect(record).toBeDefined();
    expect(record?.status).toBe("resolved");
    expect(record?.decision).toBe("deny");
    expect(record?.resolvedBy).toBe("user1");
  });

  it("returns undefined for unknown requestId", async () => {
    const tmp = withTmpRondel();
    const { adapter } = makeSpyAdapter();
    const { service } = makeService(tmp.stateDir, adapter);
    await service.init();

    const record = await service.getById("appr_9999999_deadbeef");
    expect(record).toBeUndefined();
  });
});

describe("ApprovalService.list", () => {
  it("returns both pending and resolved records", async () => {
    const tmp = withTmpRondel();
    const { adapter } = makeSpyAdapter();
    const { service } = makeService(tmp.stateDir, adapter);
    await service.init();

    const { requestId: id1 } = await service.requestToolUse({
      agentName: "bot1",
      channelType: "telegram",
      chatId: "123",
      toolName: "Bash",
      toolInput: { command: "rm -rf /" },
      reason: "dangerous_bash",
    });
    const { requestId: _id2 } = await service.requestToolUse({
      agentName: "bot1",
      channelType: "telegram",
      chatId: "123",
      toolName: "Write",
      toolInput: { file_path: "/etc/hosts", content: "x" },
      reason: "write_outside_safezone",
    });

    // Resolve one, leave one pending
    await service.resolve(id1, "allow", "user1");

    const { pending, resolved } = await service.list();
    expect(pending).toHaveLength(1);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].requestId).toBe(id1);
  });

  it("respects the resolvedLimit parameter", async () => {
    const tmp = withTmpRondel();
    const { adapter } = makeSpyAdapter();
    const { service } = makeService(tmp.stateDir, adapter);
    await service.init();

    // Create and resolve 3 records
    for (let i = 0; i < 3; i++) {
      const { requestId } = await service.requestToolUse({
        agentName: "bot1",
        channelType: "telegram",
        chatId: "123",
        toolName: "Bash",
        toolInput: { command: `cmd${i}` },
        reason: "dangerous_bash",
      });
      await service.resolve(requestId, "allow", "user1");
    }

    const { resolved } = await service.list(2);
    expect(resolved).toHaveLength(2);
  });
});

describe("ApprovalService — dispatch failure handling", () => {
  it("still persists the record when sendInteractive throws", async () => {
    const tmp = withTmpRondel();
    const { adapter } = makeSpyAdapter({ throwOnSend: true });
    const { service } = makeService(tmp.stateDir, adapter);
    await service.init();

    const { requestId } = await service.requestToolUse({
      agentName: "bot1",
      channelType: "telegram",
      chatId: "123",
      toolName: "Bash",
      toolInput: { command: "rm -rf /" },
      reason: "dangerous_bash",
    });

    // Let the fire-and-forget dispatch run (and fail)
    await new Promise((r) => setImmediate(r));

    // Record should still be persisted despite dispatch failure
    const pending = await listPending(paths(tmp.stateDir));
    expect(pending).toHaveLength(1);
    expect(pending[0].requestId).toBe(requestId);
  });
});

describe("ApprovalService — channel routing fallbacks", () => {
  it("skips dispatch when no channelType is provided (web-UI only)", async () => {
    const tmp = withTmpRondel();
    const { adapter, sent } = makeSpyAdapter();
    const { service } = makeService(tmp.stateDir, adapter);
    await service.init();

    await service.requestToolUse({
      agentName: "bot1",
      // No channelType or chatId
      toolName: "Bash",
      toolInput: { command: "rm -rf /" },
      reason: "dangerous_bash",
    });
    await new Promise((r) => setImmediate(r));

    expect(sent).toHaveLength(0);
    // Record still exists for web UI
    const pending = await listPending(paths(tmp.stateDir));
    expect(pending).toHaveLength(1);
  });

  it("skips dispatch when adapter is not found for the channel type", async () => {
    const tmp = withTmpRondel();
    const { adapter, sent } = makeSpyAdapter();
    const { service } = makeService(tmp.stateDir, adapter);
    await service.init();

    await service.requestToolUse({
      agentName: "bot1",
      channelType: "slack", // not registered in our mock registry
      chatId: "C123",
      toolName: "Bash",
      toolInput: { command: "rm -rf /" },
      reason: "dangerous_bash",
    });
    await new Promise((r) => setImmediate(r));

    expect(sent).toHaveLength(0);
    const pending = await listPending(paths(tmp.stateDir));
    expect(pending).toHaveLength(1);
  });

  it("skips dispatch when resolveAccountId returns undefined", async () => {
    const tmp = withTmpRondel();
    const { adapter, sent } = makeSpyAdapter();
    const hooks = createHooks();
    const service = new ApprovalService({
      paths: paths(tmp.stateDir),
      hooks,
      channels: makeRegistry(adapter),
      resolveAccountId: () => undefined, // always undefined
      log: createLogger("test"),
    });
    await service.init();

    await service.requestToolUse({
      agentName: "bot1",
      channelType: "telegram",
      chatId: "123",
      toolName: "Bash",
      toolInput: { command: "rm -rf /" },
      reason: "dangerous_bash",
    });
    await new Promise((r) => setImmediate(r));

    expect(sent).toHaveLength(0);
    const pending = await listPending(paths(tmp.stateDir));
    expect(pending).toHaveLength(1);
  });
});

describe("ApprovalService.recoverPending", () => {
  it("auto-denies every orphan tool-use record", async () => {
    const tmp = withTmpRondel();
    const { adapter } = makeSpyAdapter();
    const { service } = makeService(tmp.stateDir, adapter);
    await service.init();

    // Create two pending records, then simulate a daemon restart.
    await service.requestToolUse({
      agentName: "bot1",
      channelType: "telegram",
      chatId: "123",
      toolName: "Bash",
      toolInput: { command: "rm -rf /" },
      reason: "dangerous_bash",
    });
    await service.requestToolUse({
      agentName: "bot1",
      channelType: "telegram",
      chatId: "123",
      toolName: "Write",
      toolInput: { file_path: "/etc/hosts", content: "x" },
      reason: "write_outside_safezone",
    });

    const { adapter: adapter2 } = makeSpyAdapter();
    const { service: service2 } = makeService(tmp.stateDir, adapter2);
    await service2.init();
    await service2.recoverPending();

    const pending = await listPending(paths(tmp.stateDir));
    expect(pending).toHaveLength(0);

    const resolved = await listResolved(paths(tmp.stateDir));
    expect(resolved).toHaveLength(2);
    for (const r of resolved) {
      expect(r.decision).toBe("deny");
      expect(r.resolvedBy).toBe("daemon-restart");
    }
  });

  it("is a no-op when there are no pending records", async () => {
    const tmp = withTmpRondel();
    const { adapter } = makeSpyAdapter();
    const { service } = makeService(tmp.stateDir, adapter);
    await service.init();

    // recoverPending with nothing pending
    await expect(service.recoverPending()).resolves.toBeUndefined();
    const resolved = await listResolved(paths(tmp.stateDir));
    expect(resolved).toHaveLength(0);
  });
});

describe("ApprovalService — summary generation in records", () => {
  it("generates a human-readable summary for Bash tool-use records", async () => {
    const tmp = withTmpRondel();
    const { adapter } = makeSpyAdapter();
    const { service } = makeService(tmp.stateDir, adapter);
    await service.init();

    await service.requestToolUse({
      agentName: "bot1",
      channelType: "telegram",
      chatId: "123",
      toolName: "Bash",
      toolInput: { command: "rm -rf /important" },
      reason: "dangerous_bash",
    });

    const pending = await listPending(paths(tmp.stateDir));
    expect(pending).toHaveLength(1);
    expect(pending[0].summary).toBe("Bash: rm -rf /important");
  });

  it("generates a summary for Write tool-use records with path and size", async () => {
    const tmp = withTmpRondel();
    const { adapter } = makeSpyAdapter();
    const { service } = makeService(tmp.stateDir, adapter);
    await service.init();

    await service.requestToolUse({
      agentName: "bot1",
      channelType: "telegram",
      chatId: "123",
      toolName: "Write",
      toolInput: { file_path: "/etc/passwd", content: "malicious" },
      reason: "write_outside_safezone",
    });

    const pending = await listPending(paths(tmp.stateDir));
    expect(pending[0].summary).toBe("Write /etc/passwd (9B)");
  });
});
