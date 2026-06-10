import { describe, it, expect } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { KbIndexer, InlineIndexerHost, type KbIndexerHost } from "./kb-indexer.js";
import { openKbRead, searchEntries, toMatchExpression, agentDbPath } from "./kb-store.js";
import type { RebuildJob, RebuildStats } from "./kb-rebuild.js";
import { withTmpRondel } from "../../../../tests/helpers/tmp.js";
import { createCapturingLogger } from "../../../../tests/helpers/logger.js";
import { createRecordingHooks } from "../../../../tests/helpers/hooks.js";

async function makeIndexer(tmp: ReturnType<typeof withTmpRondel>, host?: KbIndexerHost) {
  const agentDir = tmp.mkAgent("kai", { "AGENT.md": "agent", "MEMORY.md": "## Facts\nuser likes espresso\n" });
  const knowledgeDir = join(tmp.stateDir, "knowledge");
  const transcriptsDir = join(tmp.stateDir, "transcripts");
  await mkdir(join(transcriptsDir, "kai"), { recursive: true });
  const sessionsJsonPath = join(tmp.stateDir, "sessions.json");
  await writeFile(sessionsJsonPath, "{}", "utf-8");
  const { hooks } = createRecordingHooks();
  const indexer = new KbIndexer({
    knowledgeDir,
    transcriptsDir,
    sessionsJsonPath,
    hooks,
    resolveAgentDir: (a) => (a === "kai" ? agentDir : undefined),
    listAgents: () => ["kai"],
    listOrgs: () => [],
    log: createCapturingLogger(),
    host: host ?? new InlineIndexerHost(),
    debounceMs: 15,
  });
  return { indexer, hooks, knowledgeDir, transcriptsDir, agentDir };
}

describe("KbIndexer", () => {
  it("rebuilds on init and reaches ready status", async () => {
    const tmp = withTmpRondel();
    const { indexer, knowledgeDir } = await makeIndexer(tmp);
    await indexer.init();
    await indexer.whenIdle();

    expect(indexer.statusFor({ agent: "kai" }).state).toBe("ready");
    const db = openKbRead(agentDbPath(knowledgeDir, "kai"));
    const hits = searchEntries(db, { match: toMatchExpression("espresso"), limit: 5 });
    expect(hits).toHaveLength(1);
    db.close();
    await indexer.dispose();
  });

  it("coalesces a burst of dirty signals into bounded rebuilds", async () => {
    const tmp = withTmpRondel();
    let rebuilds = 0;
    const counting: KbIndexerHost = {
      async runRebuild(job: RebuildJob): Promise<RebuildStats> {
        rebuilds++;
        return new InlineIndexerHost().runRebuild(job);
      },
      async dispose() {},
    };
    const { indexer, hooks } = await makeIndexer(tmp, counting);
    await indexer.init();
    await indexer.whenIdle();
    const after = rebuilds;

    for (let i = 0; i < 25; i++) {
      hooks.emit("transcript:appended", { agentName: "kai", sessionId: "s", mode: "main", kind: "user" });
    }
    await indexer.whenIdle();
    // 25 signals → at most 2 rebuilds (one debounced + one dirty-again pass).
    expect(rebuilds - after).toBeLessThanOrEqual(2);
    expect(rebuilds - after).toBeGreaterThanOrEqual(1);
    await indexer.dispose();
  });

  it("recovers from a failed rebuild on the next dirty signal", async () => {
    const tmp = withTmpRondel();
    let failNext = true;
    const flaky: KbIndexerHost = {
      async runRebuild(job: RebuildJob): Promise<RebuildStats> {
        if (failNext) {
          failNext = false;
          throw new Error("disk hiccup");
        }
        return new InlineIndexerHost().runRebuild(job);
      },
      async dispose() {},
    };
    const { indexer, hooks } = await makeIndexer(tmp, flaky);
    await indexer.init();
    await indexer.whenIdle();
    expect(indexer.statusFor({ agent: "kai" }).state).toBe("error");

    hooks.emit("memory:saved", { agentName: "kai", path: "/x/MEMORY.md" });
    await indexer.whenIdle();
    expect(indexer.statusFor({ agent: "kai" }).state).toBe("ready");
    await indexer.dispose();
  });
});
