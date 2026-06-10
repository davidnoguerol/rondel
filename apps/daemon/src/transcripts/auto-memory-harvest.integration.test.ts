import { describe, it, expect } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { harvestCliAutoMemory } from "./auto-memory-harvest.js";
import { withTmpRondel } from "../../../../tests/helpers/tmp.js";
import { createCapturingLogger } from "../../../../tests/helpers/logger.js";

describe("harvestCliAutoMemory", () => {
  it("copies a non-empty CLI auto-memory dir into the agent workspace once", async () => {
    const tmp = withTmpRondel();
    const agentDir = tmp.mkAgent("kai", { "AGENT.md": "agent" });
    const cliProjects = join(tmp.rondelHome, "fake-projects");
    const memDir = join(cliProjects, "mangled-cwd", "memory");
    await mkdir(memDir, { recursive: true });
    await writeFile(join(memDir, "MEMORY.md"), "- learned fact\n", "utf-8");

    const markerDir = join(tmp.stateDir, "transcripts");
    const args = {
      agents: [{ agentName: "kai", agentDir, cwd: "/whatever" }],
      markerDir,
      log: createCapturingLogger(),
      resolveCliProjectDir: () => join(cliProjects, "mangled-cwd"),
    };

    await harvestCliAutoMemory(args);
    const imported = await readFile(join(agentDir, "memory", "imported-cli-auto-memory", "MEMORY.md"), "utf-8");
    expect(imported).toBe("- learned fact\n");

    const marker = JSON.parse(await readFile(join(markerDir, ".auto-memory-harvested.json"), "utf-8")) as Record<string, string>;
    expect(marker.kai).toBeTruthy();

    // Second run: marker prevents re-harvest even if the source changes.
    await writeFile(join(memDir, "MEMORY.md"), "- changed\n", "utf-8");
    await harvestCliAutoMemory(args);
    expect(await readFile(join(agentDir, "memory", "imported-cli-auto-memory", "MEMORY.md"), "utf-8")).toBe("- learned fact\n");
  });

  it("marks agents without auto-memory as done without creating anything", async () => {
    const tmp = withTmpRondel();
    const agentDir = tmp.mkAgent("kai", { "AGENT.md": "agent" });
    const markerDir = join(tmp.stateDir, "transcripts");

    await harvestCliAutoMemory({
      agents: [{ agentName: "kai", agentDir, cwd: "/whatever" }],
      markerDir,
      log: createCapturingLogger(),
      resolveCliProjectDir: () => join(tmp.rondelHome, "does-not-exist"),
    });

    const marker = JSON.parse(await readFile(join(markerDir, ".auto-memory-harvested.json"), "utf-8")) as Record<string, string>;
    expect(marker.kai).toBeTruthy();
  });

  it("never overwrites an existing import dir", async () => {
    const tmp = withTmpRondel();
    const agentDir = tmp.mkAgent("kai", { "AGENT.md": "agent" });
    const cliProjects = join(tmp.rondelHome, "fake-projects", "mangled");
    await mkdir(join(cliProjects, "memory"), { recursive: true });
    await writeFile(join(cliProjects, "memory", "MEMORY.md"), "new content\n", "utf-8");

    const importDir = join(agentDir, "memory", "imported-cli-auto-memory");
    await mkdir(importDir, { recursive: true });
    await writeFile(join(importDir, "MEMORY.md"), "user-reviewed content\n", "utf-8");

    await harvestCliAutoMemory({
      agents: [{ agentName: "kai", agentDir, cwd: "/whatever" }],
      markerDir: join(tmp.stateDir, "transcripts"),
      log: createCapturingLogger(),
      resolveCliProjectDir: () => cliProjects,
    });

    expect(await readFile(join(importDir, "MEMORY.md"), "utf-8")).toBe("user-reviewed content\n");
  });
});
