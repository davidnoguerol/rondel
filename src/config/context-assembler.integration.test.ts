import { describe, it, expect } from "vitest";
import { assembleContext } from "./context-assembler.js";
import { withTmpRondel } from "../../tests/helpers/tmp.js";
import { createCapturingLogger } from "../../tests/helpers/logger.js";

describe("assembleContext (no context files)", () => {
  it("throws when neither bootstrap files nor SYSTEM.md exist", async () => {
    const tmp = withTmpRondel();
    const agentDir = tmp.mkAgent("empty");
    const log = createCapturingLogger();
    await expect(assembleContext(agentDir, log)).rejects.toThrow(
      /No context files found/,
    );
  });
});

describe("assembleContext (legacy SYSTEM.md fallback)", () => {
  it("loads legacy SYSTEM.md when no new-style bootstrap files exist", async () => {
    const tmp = withTmpRondel();
    const agentDir = tmp.mkAgent("legacy", {
      "SYSTEM.md": "legacy system prompt",
    });
    const log = createCapturingLogger();
    const result = await assembleContext(agentDir, log);
    expect(result).toContain("legacy system prompt");
  });
});

describe("assembleContext (agent bootstrap files)", () => {
  it("loads AGENT.md alone", async () => {
    const tmp = withTmpRondel();
    const agentDir = tmp.mkAgent("kai", { "AGENT.md": "be helpful" });
    const result = await assembleContext(agentDir, createCapturingLogger());
    expect(result).toContain("# AGENT.md");
    expect(result).toContain("be helpful");
  });

  it("loads AGENT.md + SOUL.md in documented order with --- separator", async () => {
    const tmp = withTmpRondel();
    const agentDir = tmp.mkAgent("kai", {
      "AGENT.md": "agent-body",
      "SOUL.md": "soul-body",
    });
    const result = await assembleContext(agentDir, createCapturingLogger());
    const agentIdx = result.indexOf("# AGENT.md");
    const soulIdx = result.indexOf("# SOUL.md");
    expect(agentIdx).toBeGreaterThanOrEqual(0);
    expect(soulIdx).toBeGreaterThan(agentIdx);
    expect(result).toContain("\n\n---\n\n");
  });

  it("prefixes each file with a '# filename' heading", async () => {
    const tmp = withTmpRondel();
    const agentDir = tmp.mkAgent("kai", {
      "AGENT.md": "body",
      "IDENTITY.md": "id",
    });
    const result = await assembleContext(agentDir, createCapturingLogger());
    expect(result).toContain("# AGENT.md\n\nbody");
    expect(result).toContain("# IDENTITY.md\n\nid");
  });

  it("treats an empty file as missing (not emitted as a layer)", async () => {
    const tmp = withTmpRondel();
    const agentDir = tmp.mkAgent("kai", {
      "AGENT.md": "body",
      "SOUL.md": "   \n  ",
    });
    const result = await assembleContext(agentDir, createCapturingLogger());
    expect(result).toContain("# AGENT.md");
    expect(result).not.toContain("# SOUL.md");
  });
});

describe("assembleContext (global and org layering)", () => {
  // Use distinctive sentinels that cannot appear in other layers by
  // accident — if a refactor picks overlapping strings elsewhere, the
  // indexOf ordering checks would silently stop asserting anything.
  const GLOBAL_SENTINEL = "SENTINEL_GLOBAL_CTX_8J3K";
  const ORG_SENTINEL = "SENTINEL_ORG_CTX_2M7Q";
  const AGENT_SENTINEL = "SENTINEL_AGENT_BODY_9R4T";

  it("prepends global CONTEXT.md when globalContextDir is provided", async () => {
    const tmp = withTmpRondel();
    tmp.writeGlobalFile("CONTEXT.md", GLOBAL_SENTINEL);
    const agentDir = tmp.mkAgent("kai", { "AGENT.md": AGENT_SENTINEL });
    const result = await assembleContext(agentDir, createCapturingLogger(), {
      globalContextDir: tmp.globalDir,
    });
    const globalIdx = result.indexOf(GLOBAL_SENTINEL);
    const agentIdx = result.indexOf(AGENT_SENTINEL);
    expect(globalIdx).toBeGreaterThanOrEqual(0);
    expect(agentIdx).toBeGreaterThan(globalIdx);
  });

  it("inserts org CONTEXT.md between global and agent layers", async () => {
    const tmp = withTmpRondel();
    tmp.writeGlobalFile("CONTEXT.md", GLOBAL_SENTINEL);
    const { agentDir, orgDir } = tmp.mkOrgAgent("acme", "kai", {
      "AGENT.md": AGENT_SENTINEL,
    });
    tmp.writeOrgSharedFile("acme", "CONTEXT.md", ORG_SENTINEL);

    const result = await assembleContext(agentDir, createCapturingLogger(), {
      globalContextDir: tmp.globalDir,
      orgDir,
    });

    const g = result.indexOf(GLOBAL_SENTINEL);
    const o = result.indexOf(ORG_SENTINEL);
    const a = result.indexOf(AGENT_SENTINEL);
    expect(g).toBeGreaterThanOrEqual(0);
    expect(o).toBeGreaterThan(g);
    expect(a).toBeGreaterThan(o);
  });
});

describe("assembleContext (USER.md fallback chain)", () => {
  it("prefers the agent's own USER.md over org/global fallbacks", async () => {
    const tmp = withTmpRondel();
    tmp.writeGlobalFile("USER.md", "global-user");
    const { agentDir, orgDir } = tmp.mkOrgAgent("acme", "kai", {
      "AGENT.md": "body",
      "USER.md": "agent-user",
    });
    tmp.writeOrgSharedFile("acme", "USER.md", "org-user");

    const result = await assembleContext(agentDir, createCapturingLogger(), {
      globalContextDir: tmp.globalDir,
      orgDir,
    });
    expect(result).toContain("agent-user");
    expect(result).not.toContain("org-user");
    expect(result).not.toContain("global-user");
  });

  it("falls back to orgDir/shared/USER.md when agent-local is missing", async () => {
    const tmp = withTmpRondel();
    tmp.writeGlobalFile("USER.md", "global-user");
    const { agentDir, orgDir } = tmp.mkOrgAgent("acme", "kai", {
      "AGENT.md": "body",
    });
    tmp.writeOrgSharedFile("acme", "USER.md", "org-user");

    const result = await assembleContext(agentDir, createCapturingLogger(), {
      globalContextDir: tmp.globalDir,
      orgDir,
    });
    expect(result).toContain("org-user");
    expect(result).not.toContain("global-user");
  });

  it("falls back to global USER.md when neither agent nor org has one", async () => {
    const tmp = withTmpRondel();
    tmp.writeGlobalFile("USER.md", "global-user");
    const { agentDir, orgDir } = tmp.mkOrgAgent("acme", "kai", {
      "AGENT.md": "body",
    });

    const result = await assembleContext(agentDir, createCapturingLogger(), {
      globalContextDir: tmp.globalDir,
      orgDir,
    });
    expect(result).toContain("global-user");
  });
});

describe("assembleContext (ephemeral mode)", () => {
  it("strips MEMORY.md, USER.md, and BOOTSTRAP.md even when all fallbacks exist", async () => {
    const tmp = withTmpRondel();
    tmp.writeGlobalFile("USER.md", "global-user");
    const { agentDir, orgDir } = tmp.mkOrgAgent("acme", "kai", {
      "AGENT.md": "body",
      "MEMORY.md": "remembered-things",
      "USER.md": "agent-user",
      "BOOTSTRAP.md": "first-run",
    });
    tmp.writeOrgSharedFile("acme", "USER.md", "org-user");

    const result = await assembleContext(agentDir, createCapturingLogger(), {
      globalContextDir: tmp.globalDir,
      orgDir,
      isEphemeral: true,
    });
    expect(result).toContain("# AGENT.md");
    expect(result).not.toContain("# MEMORY.md");
    expect(result).not.toContain("# USER.md");
    expect(result).not.toContain("# BOOTSTRAP.md");
    expect(result).not.toContain("agent-user");
    expect(result).not.toContain("org-user");
    expect(result).not.toContain("global-user");
  });

  it("still loads AGENT.md, SOUL.md, and IDENTITY.md in ephemeral mode", async () => {
    const tmp = withTmpRondel();
    const agentDir = tmp.mkAgent("kai", {
      "AGENT.md": "agent-body",
      "SOUL.md": "soul-body",
      "IDENTITY.md": "id-body",
      "MEMORY.md": "mem-body",
    });
    const result = await assembleContext(agentDir, createCapturingLogger(), {
      isEphemeral: true,
    });
    expect(result).toContain("# AGENT.md");
    expect(result).toContain("# SOUL.md");
    expect(result).toContain("# IDENTITY.md");
    expect(result).not.toContain("# MEMORY.md");
  });
});
