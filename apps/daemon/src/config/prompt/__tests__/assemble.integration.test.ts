import { describe, expect, it } from "vitest";
import { withTmpRondel } from "../../../../../../tests/helpers/tmp.js";
import { createCapturingLogger } from "../../../../../../tests/helpers/logger.js";
import { makeAgentConfig } from "../../../../../../tests/helpers/fixtures.js";
import type { CronJob } from "../../../../shared/types/index.js";
import { loadPromptInputs } from "../assemble.js";

// Sentinels — distinctive strings that cannot collide with framework
// section text. Used to assert layer ordering via indexOf comparisons.
const AGENT_BODY = "SENTINEL_AGENT_BODY_BBB8CC3F";
const SOUL_BODY = "SENTINEL_SOUL_BODY_7D4E19A2";
const IDENTITY_BODY = "SENTINEL_IDENTITY_BODY_F912A6C0";
const USER_BODY = "SENTINEL_USER_BODY_A4E5217D";
const MEMORY_BODY = "SENTINEL_MEMORY_BODY_EF8B03C5";
const BOOTSTRAP_BODY = "SENTINEL_BOOTSTRAP_BODY_ABCDEF12";
const GLOBAL_CTX = "SENTINEL_GLOBAL_CTX_09ABE1F3";
const ORG_CTX = "SENTINEL_ORG_CTX_C4D2E7F8";

describe("buildPrompt + loadPromptInputs (main mode, global agent)", () => {
  it("includes all framework sections and bootstrap files in order", async () => {
    const tmp = withTmpRondel();
    tmp.writeGlobalFile("CONTEXT.md", GLOBAL_CTX);
    const agentDir = tmp.mkAgent("kai", {
      "AGENT.md": AGENT_BODY,
      "SOUL.md": SOUL_BODY,
      "IDENTITY.md": IDENTITY_BODY,
      "USER.md": USER_BODY,
      "MEMORY.md": MEMORY_BODY,
      "BOOTSTRAP.md": BOOTSTRAP_BODY,
    });
    const prompt = await loadPromptInputs({
      mode: "main",
      agentDir,
      agentConfig: makeAgentConfig({ agentName: "kai", model: "sonnet" }),
      globalContextDir: tmp.globalDir,
      timezone: "America/New_York",
      channelType: "telegram",
      log: createCapturingLogger(),
    });

    // All framework headings present
    expect(prompt).toContain("You are a personal assistant running inside Rondel.");
    expect(prompt).toContain("## Safety");
    expect(prompt).toContain("## Tool Call Style");
    expect(prompt).toContain("## Memory");
    expect(prompt).toContain("## Execution Bias");
    expect(prompt).toContain("## Tool invariants"); // from framework-context/TOOLS.md
    expect(prompt).toContain("## Rondel CLI Quick Reference");
    expect(prompt).toContain("## Current Date & Time");
    expect(prompt).toContain("## Workspace");
    expect(prompt).toContain("## Runtime");

    // Admin section is skipped for non-admin
    expect(prompt).not.toContain("## Admin Tool Guidance");

    // Shared context + bootstrap bodies present
    expect(prompt).toContain(GLOBAL_CTX);
    expect(prompt).toContain(AGENT_BODY);
    expect(prompt).toContain(SOUL_BODY);
    expect(prompt).toContain(IDENTITY_BODY);
    expect(prompt).toContain(USER_BODY);
    expect(prompt).toContain(MEMORY_BODY);
    expect(prompt).toContain(BOOTSTRAP_BODY);
  });

  it("orders blocks: framework → shared → bootstrap (agent/soul/identity/user/memory/bootstrap)", async () => {
    const tmp = withTmpRondel();
    tmp.writeGlobalFile("CONTEXT.md", GLOBAL_CTX);
    const agentDir = tmp.mkAgent("kai", {
      "AGENT.md": AGENT_BODY,
      "SOUL.md": SOUL_BODY,
      "IDENTITY.md": IDENTITY_BODY,
      "USER.md": USER_BODY,
      "MEMORY.md": MEMORY_BODY,
      "BOOTSTRAP.md": BOOTSTRAP_BODY,
    });
    const prompt = await loadPromptInputs({
      mode: "main",
      agentDir,
      agentConfig: makeAgentConfig({ agentName: "kai" }),
      globalContextDir: tmp.globalDir,
      log: createCapturingLogger(),
    });

    const idx = (s: string) => {
      const i = prompt.indexOf(s);
      expect(i, `missing sentinel: ${s}`).toBeGreaterThanOrEqual(0);
      return i;
    };
    const identityLine = idx("You are a personal assistant running inside Rondel.");
    const safety = idx("## Safety");
    const runtime = idx("## Runtime");
    const global = idx(GLOBAL_CTX);
    const agent = idx(AGENT_BODY);
    const soul = idx(SOUL_BODY);
    const identity = idx(IDENTITY_BODY);
    const user = idx(USER_BODY);
    const memory = idx(MEMORY_BODY);
    const bootstrap = idx(BOOTSTRAP_BODY);

    expect(identityLine).toBeLessThan(safety);
    expect(safety).toBeLessThan(runtime);
    expect(runtime).toBeLessThan(global);
    expect(global).toBeLessThan(agent);
    expect(agent).toBeLessThan(soul);
    expect(soul).toBeLessThan(identity);
    expect(identity).toBeLessThan(user);
    expect(user).toBeLessThan(memory);
    expect(memory).toBeLessThan(bootstrap);
  });

  it("uses \\n\\n as the only separator — no \\n\\n---\\n\\n horizontal rules", async () => {
    const tmp = withTmpRondel();
    const agentDir = tmp.mkAgent("kai", {
      "AGENT.md": AGENT_BODY,
      "SOUL.md": SOUL_BODY,
    });
    const prompt = await loadPromptInputs({
      mode: "main",
      agentDir,
      agentConfig: makeAgentConfig({ agentName: "kai" }),
      log: createCapturingLogger(),
    });
    expect(prompt).not.toContain("\n\n---\n\n");
  });

  it("does NOT prepend synthetic '# AGENT.md' / '# SOUL.md' headings (double-H1 regression)", async () => {
    const tmp = withTmpRondel();
    const agentDir = tmp.mkAgent("kai", {
      "AGENT.md": "# AGENT.md — Your Operating Manual\n\nbody",
      "SOUL.md": "# SOUL.md — Who You Are\n\nbody",
    });
    const prompt = await loadPromptInputs({
      mode: "main",
      agentDir,
      agentConfig: makeAgentConfig({ agentName: "kai" }),
      log: createCapturingLogger(),
    });
    // Bootstrap file content should appear exactly once — if we were
    // wrapping it in `# AGENT.md\n\n<content>` on top of content that
    // already starts with `# AGENT.md`, we'd see the heading twice.
    const matches = prompt.match(/# AGENT\.md/g) ?? [];
    expect(matches.length).toBe(1);
  });
});

describe("buildPrompt (admin agent)", () => {
  it("emits the Admin Tool Guidance section with all admin tool names", async () => {
    const tmp = withTmpRondel();
    const agentDir = tmp.mkAgent("kai", { "AGENT.md": AGENT_BODY });
    const prompt = await loadPromptInputs({
      mode: "main",
      agentDir,
      agentConfig: makeAgentConfig({ agentName: "kai", admin: true }),
      log: createCapturingLogger(),
    });
    expect(prompt).toContain("## Admin Tool Guidance");
    expect(prompt).toContain("rondel_add_agent");
    expect(prompt).toContain("rondel_update_agent");
    expect(prompt).toContain("rondel_delete_agent");
    expect(prompt).toContain("rondel_set_env");
    expect(prompt).toContain("rondel_reload");
    expect(prompt).toContain("rondel_create_org");
  });
});

describe("buildPrompt (cron mode — ephemeral shape)", () => {
  const ephemeralJob: CronJob = {
    id: "ephemeral-test",
    name: "ephemeral shape",
    schedule: { kind: "every", interval: "1h" },
    prompt: "do something",
  };

  it("strips Memory, Admin, CLI Quick Reference, USER/MEMORY/BOOTSTRAP bootstrap files", async () => {
    const tmp = withTmpRondel();
    const agentDir = tmp.mkAgent("kai", {
      "AGENT.md": AGENT_BODY,
      "SOUL.md": SOUL_BODY,
      "IDENTITY.md": IDENTITY_BODY,
      "USER.md": USER_BODY,
      "MEMORY.md": MEMORY_BODY,
      "BOOTSTRAP.md": BOOTSTRAP_BODY,
    });
    const prompt = await loadPromptInputs({
      mode: "cron",
      agentDir,
      agentConfig: makeAgentConfig({ agentName: "kai", admin: true }),
      cronJob: ephemeralJob,
      cronDelivery: null,
      log: createCapturingLogger(),
    });

    // Present in ephemeral: Identity, Safety, Tool Call Style, Execution Bias,
    // Tool Invariants, Workspace, Runtime.
    expect(prompt).toContain("## Safety");
    expect(prompt).toContain("## Tool Call Style");
    expect(prompt).toContain("## Execution Bias");
    expect(prompt).toContain("## Tool invariants");
    expect(prompt).toContain("## Workspace");
    expect(prompt).toContain("## Runtime");

    // Stripped: Memory, Admin, CLI Quick Reference, Current Date & Time (no tz passed).
    expect(prompt).not.toContain("## Memory");
    expect(prompt).not.toContain("## Admin Tool Guidance");
    expect(prompt).not.toContain("## Rondel CLI Quick Reference");

    // Bootstrap: AGENT, SOUL, IDENTITY kept; USER/MEMORY/BOOTSTRAP stripped.
    expect(prompt).toContain(AGENT_BODY);
    expect(prompt).toContain(SOUL_BODY);
    expect(prompt).toContain(IDENTITY_BODY);
    expect(prompt).not.toContain(USER_BODY);
    expect(prompt).not.toContain(MEMORY_BODY);
    expect(prompt).not.toContain(BOOTSTRAP_BODY);

    // Workspace section uses the ephemeral shape.
    expect(prompt).toContain("ephemeral process");
  });
});

describe("buildPrompt (cron mode — preamble)", () => {
  const job: CronJob = {
    id: "test-job-1",
    name: "morning greeting",
    schedule: { kind: "every", interval: "1h" },
    prompt: "say hi",
    owner: "alice",
  };

  it("prepends the scheduled-task preamble above everything else", async () => {
    const tmp = withTmpRondel();
    const agentDir = tmp.mkAgent("kai", {
      "AGENT.md": AGENT_BODY,
      "SOUL.md": SOUL_BODY,
      "IDENTITY.md": IDENTITY_BODY,
    });
    const prompt = await loadPromptInputs({
      mode: "cron",
      agentDir,
      agentConfig: makeAgentConfig({ agentName: "kai" }),
      cronJob: job,
      cronDelivery: null,
      log: createCapturingLogger(),
    });

    // Preamble header sits at the top
    expect(prompt.startsWith("# Scheduled task context")).toBe(true);
    expect(prompt).toContain(`- Schedule: "morning greeting" (test-job-1)`);
    expect(prompt).toContain("Registered by: alice");
    expect(prompt).toContain("NO automatic delivery");
    // Still contains the ephemeral framework layer below the preamble
    expect(prompt).toContain("## Safety");
    expect(prompt).toContain("## Workspace");
    expect(prompt).toContain("ephemeral process");
  });

  it("emits auto-delivery preamble when delivery is resolved", async () => {
    const tmp = withTmpRondel();
    const agentDir = tmp.mkAgent("kai", { "AGENT.md": AGENT_BODY });
    const prompt = await loadPromptInputs({
      mode: "cron",
      agentDir,
      agentConfig: makeAgentConfig({ agentName: "kai" }),
      cronJob: job,
      cronDelivery: {
        channelType: "telegram",
        accountId: "kai",
        chatId: "12345",
      },
      log: createCapturingLogger(),
    });
    expect(prompt).toContain("The scheduler");
    expect(prompt).toContain("AUTOMATICALLY deliver your final response text");
    expect(prompt).toContain("Auto-delivery target: telegram / account `kai` / chat `12345`");
  });
});

describe("buildPrompt (agent-mail mode)", () => {
  it("appends the AGENT-MAIL.md block below everything else", async () => {
    const tmp = withTmpRondel();
    const agentDir = tmp.mkAgent("kai", {
      "AGENT.md": AGENT_BODY,
      "SOUL.md": SOUL_BODY,
      "IDENTITY.md": IDENTITY_BODY,
      "MEMORY.md": MEMORY_BODY,
    });
    const prompt = await loadPromptInputs({
      mode: "agent-mail",
      agentDir,
      agentConfig: makeAgentConfig({ agentName: "kai" }),
      log: createCapturingLogger(),
    });
    // The shipped template starts with "# Agent-Mail Context"
    expect(prompt).toContain("# Agent-Mail Context");
    // Must appear AFTER the last bootstrap body (MEMORY)
    const memoryIdx = prompt.indexOf(MEMORY_BODY);
    const agentMailIdx = prompt.indexOf("# Agent-Mail Context");
    expect(memoryIdx).toBeGreaterThanOrEqual(0);
    expect(agentMailIdx).toBeGreaterThan(memoryIdx);
  });
});

describe("buildPrompt (USER.md fallback chain)", () => {
  it("falls back from agent → org → global", async () => {
    const tmp = withTmpRondel();
    tmp.writeGlobalFile("USER.md", "global-user");
    const { agentDir, orgDir } = tmp.mkOrgAgent("acme", "kai", {
      "AGENT.md": AGENT_BODY,
    });
    tmp.writeOrgSharedFile("acme", "USER.md", "org-user");

    const prompt = await loadPromptInputs({
      mode: "main",
      agentDir,
      agentConfig: makeAgentConfig({ agentName: "kai" }),
      orgName: "acme",
      orgDir,
      globalContextDir: tmp.globalDir,
      log: createCapturingLogger(),
    });
    expect(prompt).toContain("org-user");
    expect(prompt).not.toContain("global-user");
  });
});

describe("buildPrompt (org context insertion)", () => {
  it("inserts org CONTEXT.md between global CONTEXT.md and bootstrap layers", async () => {
    const tmp = withTmpRondel();
    tmp.writeGlobalFile("CONTEXT.md", GLOBAL_CTX);
    const { agentDir, orgDir } = tmp.mkOrgAgent("acme", "kai", {
      "AGENT.md": AGENT_BODY,
    });
    tmp.writeOrgSharedFile("acme", "CONTEXT.md", ORG_CTX);

    const prompt = await loadPromptInputs({
      mode: "main",
      agentDir,
      agentConfig: makeAgentConfig({ agentName: "kai" }),
      orgName: "acme",
      orgDir,
      globalContextDir: tmp.globalDir,
      log: createCapturingLogger(),
    });

    const g = prompt.indexOf(GLOBAL_CTX);
    const o = prompt.indexOf(ORG_CTX);
    const a = prompt.indexOf(AGENT_BODY);
    expect(g).toBeGreaterThanOrEqual(0);
    expect(o).toBeGreaterThan(g);
    expect(a).toBeGreaterThan(o);
  });
});
