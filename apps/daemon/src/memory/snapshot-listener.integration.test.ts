import { describe, it, expect } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { registerMemorySnapshotListener } from "./snapshot-listener.js";
import { MemoryService } from "./memory-service.js";
import { FileHistoryStore } from "../filesystem/index.js";
import { withTmpRondel } from "../../../../tests/helpers/tmp.js";
import { createCapturingLogger } from "../../../../tests/helpers/logger.js";
import { createRecordingHooks } from "../../../../tests/helpers/hooks.js";

const FIXED_NOW = new Date("2026-06-10T15:00:00");

async function setup(tmp: ReturnType<typeof withTmpRondel>) {
  const agentDir = tmp.mkAgent("kai", { "AGENT.md": "agent" });
  const transcriptsDir = join(tmp.stateDir, "transcripts");
  await mkdir(join(transcriptsDir, "kai"), { recursive: true });
  const { hooks } = createRecordingHooks();
  const service = new MemoryService({
    getAgentDir: () => agentDir,
    isKnownAgent: () => true,
    fileHistory: new FileHistoryStore(tmp.stateDir, createCapturingLogger()),
    hooks,
    log: createCapturingLogger(),
    now: () => FIXED_NOW,
  });
  const dispose = registerMemorySnapshotListener({ hooks, service, transcriptsDir, log: createCapturingLogger(), now: () => FIXED_NOW });
  return { agentDir, transcriptsDir, hooks, dispose };
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 15));
  }
}

describe("memory snapshot listener", () => {
  it("session:reset with priorSessionId appends a mechanical daily snapshot", async () => {
    const tmp = withTmpRondel();
    const { agentDir, transcriptsDir, hooks, dispose } = await setup(tmp);
    const lines = [
      JSON.stringify({ type: "session_start", version: 2, sessionId: "sess-1", agentName: "kai", mode: "main", timestamp: "2026-06-10T09:00:00Z" }),
      JSON.stringify({ type: "user", text: "let's plan the week", timestamp: "2026-06-10T09:00:01Z" }),
      JSON.stringify({ type: "tool_use", id: "toolu_1", name: "rondel_task_create", input: {}, timestamp: "2026-06-10T09:00:02Z" }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "plan created" }] }, timestamp: "2026-06-10T09:00:03Z" }),
      JSON.stringify({ type: "user", text: "great, also book the flights", timestamp: "2026-06-10T09:10:00Z" }),
    ];
    await writeFile(join(transcriptsDir, "kai", "sess-1.jsonl"), lines.join("\n") + "\n", "utf-8");

    hooks.emit("session:reset", { agentName: "kai", channelType: "telegram", chatId: "42", priorSessionId: "sess-1" });

    const dailyPath = join(agentDir, "memory", "2026-06-10.md");
    await waitFor(async () => {
      try {
        return (await readFile(dailyPath, "utf-8")).includes("session snapshot");
      } catch {
        return false;
      }
    });
    const daily = await readFile(dailyPath, "utf-8");
    expect(daily).toContain("## 15:00 session snapshot — telegram:42 (sess sess-1");
    expect(daily).toContain("turns: 2 user / 1 assistant");
    expect(daily).toContain('first user: "let\'s plan the week"');
    expect(daily).toContain("tools: rondel_task_create");
    expect(daily).toContain("sess-1.jsonl");
    dispose();
  });

  it("skips agent-mail resets and resets without a priorSessionId; tolerates missing transcripts", async () => {
    const tmp = withTmpRondel();
    const { agentDir, hooks, dispose } = await setup(tmp);
    hooks.emit("session:reset", { agentName: "kai", channelType: "internal", chatId: "agent-mail", priorSessionId: "sess-mail" });
    hooks.emit("session:reset", { agentName: "kai", channelType: "telegram", chatId: "42" });
    hooks.emit("session:reset", { agentName: "kai", channelType: "telegram", chatId: "42", priorSessionId: "ghost-session" });
    await new Promise((r) => setTimeout(r, 100));
    await expect(readFile(join(agentDir, "memory", "2026-06-10.md"), "utf-8")).rejects.toThrow();
    dispose();
  });

  it("session:compacted appends a REFERENCE ONLY framed summary block (main mode only)", async () => {
    const tmp = withTmpRondel();
    const { agentDir, hooks, dispose } = await setup(tmp);
    hooks.emit("session:compacted", {
      agentName: "kai",
      sessionId: "sess-2",
      mode: "main",
      channelType: "telegram",
      chatId: "42",
      trigger: "auto",
      summaryLength: 20,
      summary: "we planned the week\nand booked flights",
    });
    hooks.emit("session:compacted", {
      agentName: "kai",
      sessionId: "cron_x",
      mode: "cron",
      trigger: "auto",
      summaryLength: 5,
      summary: "noise",
    });

    const dailyPath = join(agentDir, "memory", "2026-06-10.md");
    await waitFor(async () => {
      try {
        return (await readFile(dailyPath, "utf-8")).includes("compaction");
      } catch {
        return false;
      }
    });
    const daily = await readFile(dailyPath, "utf-8");
    expect(daily).toContain("REFERENCE ONLY — model-written compaction summary; the latest user message wins.");
    expect(daily).toContain("> we planned the week");
    expect(daily).not.toContain("noise");
    dispose();
  });
});
