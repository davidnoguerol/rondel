/**
 * Tmpdir helper for integration tests.
 *
 * Creates a temporary Rondel-like directory structure inside os.tmpdir()
 * and registers afterEach cleanup. Tests call `withTmpRondel()` inside a
 * describe block to get an isolated scratch space.
 *
 * Guarantees:
 * - Every test gets a fresh directory under os.tmpdir()/rondel-test-XXXXXX
 * - Directory is recursively removed after each test
 * - Tests never touch paths outside os.tmpdir()
 */

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";

export interface TmpRondelHandle {
  /** Absolute path to the tmp RONDEL_HOME root. */
  readonly rondelHome: string;
  /** Absolute path to state/ under rondelHome. */
  readonly stateDir: string;
  /** Absolute path to workspaces/ under rondelHome. */
  readonly workspacesDir: string;
  /** Absolute path to workspaces/global/ under rondelHome. */
  readonly globalDir: string;
  /**
   * Create a global agent directory at workspaces/global/agents/{name} and
   * seed it with the provided context files. Keys are filenames (e.g.
   * "AGENT.md"), values are file contents. Returns the absolute agent dir.
   */
  mkAgent(name: string, files?: Record<string, string>): string;
  /**
   * Create an org at workspaces/{orgName} and an agent inside it at
   * workspaces/{orgName}/agents/{name}. Returns { agentDir, orgDir }.
   */
  mkOrgAgent(
    orgName: string,
    name: string,
    files?: Record<string, string>,
  ): { agentDir: string; orgDir: string };
  /**
   * Write a file under workspaces/global/ (e.g. "CONTEXT.md" or "USER.md").
   * Returns the absolute path.
   */
  writeGlobalFile(relPath: string, content: string): string;
  /**
   * Write a file under workspaces/{orgName}/shared/ (e.g. "CONTEXT.md").
   * Returns the absolute path.
   */
  writeOrgSharedFile(orgName: string, relPath: string, content: string): string;
}

/**
 * Create an isolated tmp Rondel directory scoped to the current test.
 *
 * Call at the start of a test:
 *
 *     const tmp = withTmpRondel();
 *     const agentDir = tmp.mkAgent("kai", { "AGENT.md": "hello" });
 *
 * The directory is removed automatically after the test (via afterEach).
 */
export function withTmpRondel(): TmpRondelHandle {
  const rondelHome = mkdtempSync(join(tmpdir(), "rondel-test-"));
  const stateDir = join(rondelHome, "state");
  const workspacesDir = join(rondelHome, "workspaces");
  const globalDir = join(workspacesDir, "global");

  mkdirSync(stateDir, { recursive: true });
  mkdirSync(globalDir, { recursive: true });

  afterEach(async () => {
    await rm(rondelHome, { recursive: true, force: true });
  });

  const writeFiles = (dir: string, files?: Record<string, string>): void => {
    if (!files) return;
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(dir, name), content);
    }
  };

  return {
    rondelHome,
    stateDir,
    workspacesDir,
    globalDir,
    mkAgent(name, files) {
      const agentDir = join(globalDir, "agents", name);
      mkdirSync(agentDir, { recursive: true });
      writeFiles(agentDir, files);
      return agentDir;
    },
    mkOrgAgent(orgName, name, files) {
      const orgDir = join(workspacesDir, orgName);
      const agentDir = join(orgDir, "agents", name);
      mkdirSync(agentDir, { recursive: true });
      mkdirSync(join(orgDir, "shared"), { recursive: true });
      writeFiles(agentDir, files);
      return { agentDir, orgDir };
    },
    writeGlobalFile(relPath, content) {
      const path = join(globalDir, relPath);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, content);
      return path;
    },
    writeOrgSharedFile(orgName, relPath, content) {
      const sharedDir = join(workspacesDir, orgName, "shared");
      mkdirSync(sharedDir, { recursive: true });
      const path = join(sharedDir, relPath);
      writeFileSync(path, content);
      return path;
    },
  };
}
