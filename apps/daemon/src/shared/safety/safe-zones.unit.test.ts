import { describe, it, expect } from "vitest";
import { isPathInSafeZone } from "./safe-zones.js";

const AGENT_DIR = "/home/user/.rondel/workspaces/global/agents/kai";
const RONDEL_HOME = "/home/user/.rondel/workspaces";

describe("isPathInSafeZone — safe zones", () => {
  it("treats a file under agentDir as safe", () => {
    const ok = isPathInSafeZone(`${AGENT_DIR}/notes/foo.md`, {
      agentDir: AGENT_DIR,
      rondelHome: RONDEL_HOME,
    });
    expect(ok).toBe(true);
  });

  it("treats the agentDir itself as safe", () => {
    const ok = isPathInSafeZone(AGENT_DIR, {
      agentDir: AGENT_DIR,
      rondelHome: RONDEL_HOME,
    });
    expect(ok).toBe(true);
  });

  it("treats a file under rondelHome (different agent) as safe", () => {
    const ok = isPathInSafeZone(`${RONDEL_HOME}/global/agents/other/MEMORY.md`, {
      agentDir: AGENT_DIR,
      rondelHome: RONDEL_HOME,
    });
    expect(ok).toBe(true);
  });

  it("treats /tmp exactly as safe", () => {
    expect(
      isPathInSafeZone("/tmp", { agentDir: AGENT_DIR, rondelHome: RONDEL_HOME }),
    ).toBe(true);
  });

  it("treats /tmp/foo as safe", () => {
    expect(
      isPathInSafeZone("/tmp/foo", { agentDir: AGENT_DIR, rondelHome: RONDEL_HOME }),
    ).toBe(true);
  });

  it("does NOT treat /tmpwhatever as safe (prefix-only match must respect separator)", () => {
    expect(
      isPathInSafeZone("/tmpwhatever", { agentDir: AGENT_DIR, rondelHome: RONDEL_HOME }),
    ).toBe(false);
  });
});

describe("isPathInSafeZone — unsafe zones", () => {
  it("rejects /etc/hosts", () => {
    expect(
      isPathInSafeZone("/etc/hosts", { agentDir: AGENT_DIR, rondelHome: RONDEL_HOME }),
    ).toBe(false);
  });

  it("rejects /usr/local/bin/foo", () => {
    expect(
      isPathInSafeZone("/usr/local/bin/foo", { agentDir: AGENT_DIR, rondelHome: RONDEL_HOME }),
    ).toBe(false);
  });

  it("rejects $HOME but not under .rondel/workspaces", () => {
    expect(
      isPathInSafeZone("/home/user/Documents/diary.md", {
        agentDir: AGENT_DIR,
        rondelHome: RONDEL_HOME,
      }),
    ).toBe(false);
  });

  it("rejects /home/user/.rondel/state (framework plumbing)", () => {
    expect(
      isPathInSafeZone("/home/user/.rondel/state/sessions.json", {
        agentDir: AGENT_DIR,
        rondelHome: RONDEL_HOME,
      }),
    ).toBe(false);
  });
});

describe("isPathInSafeZone — context optionality", () => {
  it("works without agentDir — rondelHome + /tmp still apply", () => {
    expect(
      isPathInSafeZone(`${RONDEL_HOME}/global/agents/x/MEMORY.md`, {
        rondelHome: RONDEL_HOME,
      }),
    ).toBe(true);
    expect(
      isPathInSafeZone("/tmp/scratch", { rondelHome: RONDEL_HOME }),
    ).toBe(true);
    expect(
      isPathInSafeZone("/etc/foo", { rondelHome: RONDEL_HOME }),
    ).toBe(false);
  });
});

describe("isPathInSafeZone — path normalization", () => {
  it("handles trailing slash on rondelHome", () => {
    expect(
      isPathInSafeZone(`${RONDEL_HOME}/global/agents/x/MEMORY.md`, {
        rondelHome: RONDEL_HOME + "/",
      }),
    ).toBe(true);
  });

  it("handles trailing slash on agentDir", () => {
    expect(
      isPathInSafeZone(`${AGENT_DIR}/notes.md`, {
        agentDir: AGENT_DIR + "/",
        rondelHome: RONDEL_HOME,
      }),
    ).toBe(true);
  });

  it("flags /tmp/../etc/foo as unsafe (resolve normalises `..`)", () => {
    expect(
      isPathInSafeZone("/tmp/../etc/foo", {
        agentDir: AGENT_DIR,
        rondelHome: RONDEL_HOME,
      }),
    ).toBe(false);
  });

  it("flags /home/user/.rondel/workspaces/../state/foo as unsafe", () => {
    // `resolve` collapses `..` so this resolves to /home/user/.rondel/state/foo
    // which is outside every safe zone.
    expect(
      isPathInSafeZone(`${RONDEL_HOME}/../state/foo`, {
        agentDir: AGENT_DIR,
        rondelHome: RONDEL_HOME,
      }),
    ).toBe(false);
  });
});
