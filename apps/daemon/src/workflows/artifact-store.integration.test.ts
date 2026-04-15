/**
 * Integration tests for artifact-store's I/O helpers:
 *   - importArtifact: copies a source file into state/workflows/{runId}/artifacts/
 *   - artifactExists: boolean probe
 *   - resolveStepInputs: turns declared input specs into concrete artifact names,
 *     honouring the "?" optional marker and throwing on missing required inputs.
 *
 * Pure name validation lives in artifact-store.unit.test.ts.
 */

import { describe, it, expect } from "vitest";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  importArtifact,
  artifactExists,
  resolveStepInputs,
  ArtifactStoreError,
} from "./artifact-store.js";
import { artifactDirectory } from "./workflow-storage.js";
import { withTmpRondel } from "../../../../tests/helpers/tmp.js";

const RUN_ID = "run_1700000000000_abc123";

function seedSourceFile(tmpDir: string, name: string, body: string): string {
  const path = join(tmpDir, name);
  writeFileSync(path, body);
  return path;
}

describe("importArtifact", () => {
  it("copies a source file into the run's artifact directory under the given name", async () => {
    const tmp = withTmpRondel();
    const source = seedSourceFile(tmp.rondelHome, "source.md", "hello world");

    await importArtifact(tmp.stateDir, RUN_ID, source, "prd.md");

    const written = readFileSync(
      join(artifactDirectory(tmp.stateDir, RUN_ID), "prd.md"),
      "utf-8",
    );
    expect(written).toBe("hello world");
  });

  it("creates the run's artifact directory if it does not yet exist", async () => {
    const tmp = withTmpRondel();
    const source = seedSourceFile(tmp.rondelHome, "source.md", "x");

    // stateDir/workflows/{runId}/artifacts/ does not exist yet
    await importArtifact(tmp.stateDir, RUN_ID, source, "prd.md");

    expect(await artifactExists(tmp.stateDir, RUN_ID, "prd.md")).toBe(true);
  });

  it("rejects a relative source path", async () => {
    const tmp = withTmpRondel();
    await expect(
      importArtifact(tmp.stateDir, RUN_ID, "relative/path.md", "prd.md"),
    ).rejects.toThrow(ArtifactStoreError);
  });

  it("rejects an invalid artifact name before touching the filesystem", async () => {
    const tmp = withTmpRondel();
    const source = seedSourceFile(tmp.rondelHome, "source.md", "x");
    await expect(
      importArtifact(tmp.stateDir, RUN_ID, source, "../escape.md"),
    ).rejects.toThrow(ArtifactStoreError);
  });
});

describe("artifactExists", () => {
  it("returns false when the run directory has never been created", async () => {
    const tmp = withTmpRondel();
    expect(await artifactExists(tmp.stateDir, RUN_ID, "prd.md")).toBe(false);
  });

  it("returns true after importArtifact has written the file", async () => {
    const tmp = withTmpRondel();
    const source = seedSourceFile(tmp.rondelHome, "source.md", "x");
    await importArtifact(tmp.stateDir, RUN_ID, source, "prd.md");
    expect(await artifactExists(tmp.stateDir, RUN_ID, "prd.md")).toBe(true);
  });
});

describe("resolveStepInputs", () => {
  it("returns an empty array for empty specs", async () => {
    const tmp = withTmpRondel();
    expect(await resolveStepInputs(tmp.stateDir, RUN_ID, [])).toEqual([]);
  });

  it("returns required inputs in author order when all are present", async () => {
    const tmp = withTmpRondel();
    const src = seedSourceFile(tmp.rondelHome, "source", "x");
    await importArtifact(tmp.stateDir, RUN_ID, src, "prd.md");
    await importArtifact(tmp.stateDir, RUN_ID, src, "spec.md");

    const resolved = await resolveStepInputs(tmp.stateDir, RUN_ID, ["prd.md", "spec.md"]);
    expect(resolved).toEqual(["prd.md", "spec.md"]);
  });

  it("drops missing optional inputs silently", async () => {
    const tmp = withTmpRondel();
    const src = seedSourceFile(tmp.rondelHome, "source", "x");
    await importArtifact(tmp.stateDir, RUN_ID, src, "prd.md");

    const resolved = await resolveStepInputs(tmp.stateDir, RUN_ID, ["prd.md", "notes.md?"]);
    expect(resolved).toEqual(["prd.md"]);
  });

  it("throws on a missing required input with the artifact name in the message", async () => {
    const tmp = withTmpRondel();
    await expect(
      resolveStepInputs(tmp.stateDir, RUN_ID, ["missing.md"]),
    ).rejects.toThrow(/Required input artifact "missing\.md" is missing/);
  });

  it("includes an optional input when it is present on disk", async () => {
    const tmp = withTmpRondel();
    const src = seedSourceFile(tmp.rondelHome, "source", "x");
    await importArtifact(tmp.stateDir, RUN_ID, src, "notes.md");

    const resolved = await resolveStepInputs(tmp.stateDir, RUN_ID, ["notes.md?"]);
    expect(resolved).toEqual(["notes.md"]);
  });

  it("rejects a spec with path separators before probing the filesystem", async () => {
    const tmp = withTmpRondel();
    await expect(
      resolveStepInputs(tmp.stateDir, RUN_ID, ["../etc/passwd"]),
    ).rejects.toThrow(ArtifactStoreError);
  });
});
