import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createCapturingLogger } from "../../../../../../tests/helpers/logger.js";
import { withTmpRondel } from "../../../../../../tests/helpers/tmp.js";
import { loadBootstrapFiles } from "../bootstrap.js";

/**
 * Focused coverage for the USER.md fallback chain in `loadBootstrapFiles`.
 *
 * The chain (per bootstrap.ts):
 *   agent's own USER.md  →  <orgDir>/shared/USER.md  →  <globalContextDir>/USER.md
 *
 * The `assemble.integration.test.ts` file covers the org-fallback branch
 * indirectly. These tests isolate each branch so a regression in the
 * fallback resolution surfaces here rather than via a misleading assertion
 * in a higher-level test.
 */
describe("loadBootstrapFiles — USER.md fallback chain", () => {
  it("prefers the agent's own USER.md when present (agent > org > global)", async () => {
    const tmp = withTmpRondel();
    tmp.writeGlobalFile("USER.md", "global-user");
    const { agentDir, orgDir } = tmp.mkOrgAgent("acme", "kai", {
      "USER.md": "agent-user",
    });
    tmp.writeOrgSharedFile("acme", "USER.md", "org-user");

    const out = await loadBootstrapFiles({
      agentDir,
      orgDir,
      globalContextDir: tmp.globalDir,
      log: createCapturingLogger(),
    });
    expect(out.user).toBe("agent-user");
  });

  it("falls back to <orgDir>/shared/USER.md when the agent has none", async () => {
    const tmp = withTmpRondel();
    tmp.writeGlobalFile("USER.md", "global-user");
    const { agentDir, orgDir } = tmp.mkOrgAgent("acme", "kai", {});
    tmp.writeOrgSharedFile("acme", "USER.md", "org-user");

    const out = await loadBootstrapFiles({
      agentDir,
      orgDir,
      globalContextDir: tmp.globalDir,
      log: createCapturingLogger(),
    });
    expect(out.user).toBe("org-user");
  });

  it("falls through to <globalContextDir>/USER.md when neither agent nor org has one", async () => {
    const tmp = withTmpRondel();
    tmp.writeGlobalFile("USER.md", "global-user");
    // Org exists but has no USER.md; agent has none either.
    const { agentDir, orgDir } = tmp.mkOrgAgent("acme", "kai", {});

    const out = await loadBootstrapFiles({
      agentDir,
      orgDir,
      globalContextDir: tmp.globalDir,
      log: createCapturingLogger(),
    });
    expect(out.user).toBe("global-user");
  });

  it("skips the org branch for a global agent (no orgDir provided)", async () => {
    const tmp = withTmpRondel();
    tmp.writeGlobalFile("USER.md", "global-user");
    const agentDir = tmp.mkAgent("kai", {});

    const out = await loadBootstrapFiles({
      agentDir,
      // orgDir deliberately omitted — global agent
      globalContextDir: tmp.globalDir,
      log: createCapturingLogger(),
    });
    expect(out.user).toBe("global-user");
  });

  it("returns undefined when no USER.md exists anywhere on the chain", async () => {
    const tmp = withTmpRondel();
    const { agentDir, orgDir } = tmp.mkOrgAgent("acme", "kai", {});

    const out = await loadBootstrapFiles({
      agentDir,
      orgDir,
      globalContextDir: tmp.globalDir,
      log: createCapturingLogger(),
    });
    expect(out.user).toBeUndefined();
  });

  it("treats a whitespace-only USER.md at every level as absent (falls through)", async () => {
    const tmp = withTmpRondel();
    // Agent's USER.md is whitespace-only → collapsed to undefined
    const { agentDir, orgDir } = tmp.mkOrgAgent("acme", "kai", {
      "USER.md": "   \n\n  \n",
    });
    // Org shared USER.md is whitespace-only too → also collapsed
    tmp.writeOrgSharedFile("acme", "USER.md", "   ");
    // Global has real content
    tmp.writeGlobalFile("USER.md", "global-user");

    const out = await loadBootstrapFiles({
      agentDir,
      orgDir,
      globalContextDir: tmp.globalDir,
      log: createCapturingLogger(),
    });
    expect(out.user).toBe("global-user");
  });
});

describe("loadBootstrapFiles — other bootstrap fields", () => {
  it("reads AGENT.md, SOUL.md, IDENTITY.md, MEMORY.md, BOOTSTRAP.md from the agent's own dir", async () => {
    const tmp = withTmpRondel();
    const agentDir = tmp.mkAgent("kai", {
      "AGENT.md": "agent-body",
      "SOUL.md": "soul-body",
      "IDENTITY.md": "identity-body",
      "MEMORY.md": "memory-body",
      "BOOTSTRAP.md": "bootstrap-body",
    });

    const out = await loadBootstrapFiles({
      agentDir,
      log: createCapturingLogger(),
    });
    expect(out.agent).toBe("agent-body");
    expect(out.soul).toBe("soul-body");
    expect(out.identity).toBe("identity-body");
    expect(out.memory).toBe("memory-body");
    expect(out.bootstrapRitual).toBe("bootstrap-body");
  });

  it("returns undefined for every field when the agent dir has no bootstrap files", async () => {
    const tmp = withTmpRondel();
    const agentDir = tmp.mkAgent("kai", {});

    const out = await loadBootstrapFiles({
      agentDir,
      log: createCapturingLogger(),
    });
    expect(out.agent).toBeUndefined();
    expect(out.soul).toBeUndefined();
    expect(out.identity).toBeUndefined();
    expect(out.user).toBeUndefined();
    expect(out.memory).toBeUndefined();
    expect(out.bootstrapRitual).toBeUndefined();
  });

  it("does NOT fall back to global/org for AGENT.md, SOUL.md, IDENTITY.md (no fallback chain for those)", async () => {
    const tmp = withTmpRondel();
    // Only global has an AGENT.md at the global level — agent dir is empty.
    // The fallback chain only applies to USER.md; AGENT.md must come from
    // the agent dir or be undefined.
    writeFileSync(join(tmp.globalDir, "AGENT.md"), "global-agent-body");
    const { agentDir, orgDir } = tmp.mkOrgAgent("acme", "kai", {});

    const out = await loadBootstrapFiles({
      agentDir,
      orgDir,
      globalContextDir: tmp.globalDir,
      log: createCapturingLogger(),
    });
    expect(out.agent).toBeUndefined();
  });
});
