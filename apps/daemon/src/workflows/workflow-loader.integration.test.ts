/**
 * Integration tests for the workflow loader's disk-discovery path.
 *
 * Unit tests in workflow-loader.unit.test.ts cover the pure parsing.
 * This file covers the part that touches the filesystem: scanning
 * workspaces/global/workflows/ and workspaces/{org}/workflows/ for
 * JSON files, parsing them, and detecting cross-scope id collisions.
 */

import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { discoverWorkflows, WorkflowLoadError } from "./workflow-loader.js";
import { withTmpRondel } from "../../../../tests/helpers/tmp.js";

function writeWorkflow(dir: string, fileName: string, definition: object): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, fileName);
  writeFileSync(path, JSON.stringify(definition, null, 2));
  return path;
}

const minimalDef = (id: string) => ({
  id,
  version: 1,
  inputs: {},
  steps: [{ id: "only", kind: "agent", agent: "writer", task: "do it" }],
});

describe("discoverWorkflows", () => {
  it("returns an empty map when no workflows directories exist", async () => {
    const tmp = withTmpRondel();
    const result = await discoverWorkflows(tmp.workspacesDir, []);
    expect(result.size).toBe(0);
  });

  it("loads a single global workflow", async () => {
    const tmp = withTmpRondel();
    writeWorkflow(
      join(tmp.globalDir, "workflows"),
      "demo.json",
      minimalDef("demo"),
    );

    const result = await discoverWorkflows(tmp.workspacesDir, []);
    expect(result.size).toBe(1);
    const found = result.get("demo");
    expect(found).toBeDefined();
    expect(found?.orgName).toBeNull();
    expect(found?.definition.id).toBe("demo");
  });

  it("loads workflows from multiple orgs and tags each with its org", async () => {
    const tmp = withTmpRondel();
    const acmeDir = join(tmp.workspacesDir, "acme");
    const wonkaDir = join(tmp.workspacesDir, "wonka");
    writeWorkflow(join(acmeDir, "workflows"), "build.json", minimalDef("build"));
    writeWorkflow(join(wonkaDir, "workflows"), "ship.json", minimalDef("ship"));

    const result = await discoverWorkflows(tmp.workspacesDir, [
      { orgName: "acme", orgDir: acmeDir },
      { orgName: "wonka", orgDir: wonkaDir },
    ]);

    expect(result.size).toBe(2);
    expect(result.get("build")?.orgName).toBe("acme");
    expect(result.get("ship")?.orgName).toBe("wonka");
  });

  it("loads global + org workflows together", async () => {
    const tmp = withTmpRondel();
    const acmeDir = join(tmp.workspacesDir, "acme");
    writeWorkflow(join(tmp.globalDir, "workflows"), "shared.json", minimalDef("shared"));
    writeWorkflow(join(acmeDir, "workflows"), "private.json", minimalDef("private"));

    const result = await discoverWorkflows(tmp.workspacesDir, [
      { orgName: "acme", orgDir: acmeDir },
    ]);

    expect(result.size).toBe(2);
    expect(result.get("shared")?.orgName).toBeNull();
    expect(result.get("private")?.orgName).toBe("acme");
  });

  it("ignores non-JSON files in workflows directories", async () => {
    const tmp = withTmpRondel();
    const dir = join(tmp.globalDir, "workflows");
    writeWorkflow(dir, "demo.json", minimalDef("demo"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "README.md"), "# Workflows");
    writeFileSync(join(dir, ".DS_Store"), "");

    const result = await discoverWorkflows(tmp.workspacesDir, []);
    expect(result.size).toBe(1);
    expect(result.has("demo")).toBe(true);
  });

  it("throws on invalid JSON in a workflow file", async () => {
    const tmp = withTmpRondel();
    const dir = join(tmp.globalDir, "workflows");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "broken.json"), "{not json");

    await expect(discoverWorkflows(tmp.workspacesDir, [])).rejects.toThrow(WorkflowLoadError);
  });

  it("throws on a duplicate workflow id across scopes", async () => {
    const tmp = withTmpRondel();
    const acmeDir = join(tmp.workspacesDir, "acme");
    writeWorkflow(join(tmp.globalDir, "workflows"), "duplicated.json", minimalDef("duplicated"));
    writeWorkflow(join(acmeDir, "workflows"), "also-duplicated.json", minimalDef("duplicated"));

    await expect(
      discoverWorkflows(tmp.workspacesDir, [{ orgName: "acme", orgDir: acmeDir }]),
    ).rejects.toThrow(/Duplicate workflow id "duplicated"/);
  });

  it("propagates structural validation errors from the loader (e.g. duplicate step ids)", async () => {
    const tmp = withTmpRondel();
    const dir = join(tmp.globalDir, "workflows");
    writeWorkflow(dir, "dup-steps.json", {
      id: "dup-steps",
      version: 1,
      inputs: {},
      steps: [
        { id: "x", kind: "agent", agent: "a", task: "t" },
        { id: "x", kind: "agent", agent: "b", task: "u" },
      ],
    });

    await expect(discoverWorkflows(tmp.workspacesDir, [])).rejects.toThrow(/Duplicate step id "x"/);
  });
});
