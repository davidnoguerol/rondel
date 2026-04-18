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

/**
 * Minimal spy adapter capturing `sendInteractive` calls. We don't need the
 * full ChannelAdapter surface — only the bits ApprovalService touches.
 */
function makeSpyAdapter(): { adapter: ChannelAdapter; sent: Array<{ accountId: string; chatId: string; text: string; buttons: readonly { label: string; callbackData: string }[] }> } {
  const sent: Array<{ accountId: string; chatId: string; text: string; buttons: readonly { label: string; callbackData: string }[] }> = [];
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
      sent.push({ accountId, chatId, text, buttons });
    }),
    onInteractiveCallback: vi.fn(),
  };
  return { adapter, sent };
}

function makeRegistry(adapter: ChannelAdapter): ChannelRegistry {
  // Minimal surrogate — ApprovalService only calls `channels.get(channelType)`
  // and inspects `supportsInteractive` + `sendInteractive`.
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

describe("ApprovalService", () => {
  it("init creates the pending and resolved directories", async () => {
    const tmp = withTmpRondel();
    const { adapter } = makeSpyAdapter();
    const { service } = makeService(tmp.stateDir, adapter);
    await service.init();

    const p = paths(tmp.stateDir);
    const list = await listPending(p);
    expect(list).toEqual([]);
  });

  it("requestToolUse persists a pending record and routes to the channel", async () => {
    const tmp = withTmpRondel();
    const { adapter, sent } = makeSpyAdapter();
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

    expect(requestId).toMatch(/^appr_\d+_[a-f0-9]+$/);
    // Let the async fan-out run
    await new Promise((r) => setImmediate(r));

    // Pending record persisted
    const pending = await listPending(paths(tmp.stateDir));
    expect(pending).toHaveLength(1);
    expect(pending[0].requestId).toBe(requestId);
    expect(pending[0].toolName).toBe("Bash");
    expect(pending[0].reason).toBe("dangerous_bash");

    // Interactive message sent to the right account+chat
    expect(sent).toHaveLength(1);
    expect(sent[0].accountId).toBe("bot1");
    expect(sent[0].chatId).toBe("123");
    expect(sent[0].buttons.map((b) => b.callbackData)).toEqual([
      `rondel_appr_allow_${requestId}`,
      `rondel_appr_deny_${requestId}`,
    ]);
  });

  it("resolve flips pending → resolved and unblocks the in-process promise", async () => {
    const tmp = withTmpRondel();
    const { adapter } = makeSpyAdapter();
    const { service } = makeService(tmp.stateDir, adapter);
    await service.init();

    const { requestId, decision } = await service.requestToolUse({
      agentName: "bot1",
      channelType: "telegram",
      chatId: "123",
      toolName: "Write",
      toolInput: { file_path: "/etc/passwd", content: "x" },
      reason: "write_outside_safezone",
    });

    await service.resolve(requestId, "allow", "telegram:42");
    await expect(decision).resolves.toBe("allow");

    const pending = await listPending(paths(tmp.stateDir));
    expect(pending).toHaveLength(0);

    const resolved = await listResolved(paths(tmp.stateDir));
    expect(resolved).toHaveLength(1);
    expect(resolved[0].decision).toBe("allow");
    expect(resolved[0].resolvedBy).toBe("telegram:42");
  });

  it("emits approval:requested and approval:resolved hooks", async () => {
    const tmp = withTmpRondel();
    const { adapter } = makeSpyAdapter();
    const { service, hooks } = makeService(tmp.stateDir, adapter);
    await service.init();

    const requested = vi.fn();
    const resolved = vi.fn();
    hooks.on("approval:requested", requested);
    hooks.on("approval:resolved", resolved);

    const { requestId } = await service.requestToolUse({
      agentName: "bot1",
      channelType: "telegram",
      chatId: "123",
      toolName: "Bash",
      toolInput: { command: "dd if=/dev/zero of=/dev/sda" },
      reason: "dangerous_bash",
    });
    await new Promise((r) => setImmediate(r));
    expect(requested).toHaveBeenCalledTimes(1);
    expect(requested.mock.calls[0][0].record.requestId).toBe(requestId);

    await service.resolve(requestId, "deny", "timeout");
    expect(resolved).toHaveBeenCalledTimes(1);
    expect(resolved.mock.calls[0][0].record.decision).toBe("deny");
  });

  it("recoverPending auto-denies orphan records from a previous run", async () => {
    const tmp = withTmpRondel();
    const { adapter } = makeSpyAdapter();
    const { service } = makeService(tmp.stateDir, adapter);
    await service.init();

    // Simulate two orphan pending records written by a previous daemon run.
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

    // Fresh service over the same state dir simulates a restart.
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

  it("auto-denies on timeout", async () => {
    // Force a very short timeout for this test
    const prev = process.env.RONDEL_APPROVAL_TIMEOUT_MS;
    process.env.RONDEL_APPROVAL_TIMEOUT_MS = "50";
    try {
      const tmp = withTmpRondel();
      const { adapter } = makeSpyAdapter();
      const { service } = makeService(tmp.stateDir, adapter);
      await service.init();

      const { decision } = await service.requestToolUse({
        agentName: "bot1",
        channelType: "telegram",
        chatId: "123",
        toolName: "Bash",
        toolInput: { command: "rm -rf /" },
        reason: "dangerous_bash",
      });

      await expect(decision).resolves.toBe("deny");
      const resolvedList = await listResolved(paths(tmp.stateDir));
      expect(resolvedList).toHaveLength(1);
      expect(resolvedList[0].resolvedBy).toBe("timeout");
    } finally {
      if (prev === undefined) delete process.env.RONDEL_APPROVAL_TIMEOUT_MS;
      else process.env.RONDEL_APPROVAL_TIMEOUT_MS = prev;
    }
  });

  it("falls back to web-UI-only path when channel has no interactive support", async () => {
    const tmp = withTmpRondel();
    const { adapter, sent } = makeSpyAdapter();
    (adapter as { supportsInteractive: boolean }).supportsInteractive = false;
    const { service } = makeService(tmp.stateDir, adapter);
    await service.init();

    await service.requestToolUse({
      agentName: "bot1",
      channelType: "telegram",
      chatId: "123",
      toolName: "Bash",
      toolInput: { command: "dd if=/dev/zero" },
      reason: "dangerous_bash",
    });

    expect(sent).toHaveLength(0); // no fan-out
    // But the record is still persisted and visible to the web UI
    const pending = await listPending(paths(tmp.stateDir));
    expect(pending).toHaveLength(1);
  });

  it("getById returns pending records", async () => {
    const tmp = withTmpRondel();
    const { adapter } = makeSpyAdapter();
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
    await new Promise((r) => setImmediate(r));

    const record = await service.getById(requestId);
    expect(record).toBeDefined();
    expect(record?.status).toBe("pending");
  });
});
