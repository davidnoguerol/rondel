/**
 * Unit tests for the pure, I/O-free parts of artifact-store:
 *   - parseInputSpecifier: splits "name?" → { name, optional }
 *   - validateArtifactName: rejects path traversal, separators, null bytes, etc.
 *   - artifactPath: resolves a name under a run's artifact dir
 *
 * The filesystem-touching helpers (importArtifact, artifactExists,
 * resolveStepInputs) live in artifact-store.integration.test.ts.
 */

import { describe, it, expect } from "vitest";
import { join } from "node:path";
import {
  parseInputSpecifier,
  validateArtifactName,
  artifactPath,
  ArtifactStoreError,
} from "./artifact-store.js";

describe("parseInputSpecifier", () => {
  it("treats a plain name as required", () => {
    expect(parseInputSpecifier("prd")).toEqual({ name: "prd", optional: false });
  });

  it("strips a trailing ? and marks the input optional", () => {
    expect(parseInputSpecifier("prd?")).toEqual({ name: "prd", optional: true });
  });

  it("only treats the LAST character as the optional marker", () => {
    // A "?" inside the name stays — we strip exactly one trailing char.
    expect(parseInputSpecifier("a?b")).toEqual({ name: "a?b", optional: false });
  });
});

describe("validateArtifactName", () => {
  it("accepts a normal filename", () => {
    expect(() => validateArtifactName("prd.md")).not.toThrow();
  });

  it("accepts a name with dots and dashes", () => {
    expect(() => validateArtifactName("dev-plan.v2.md")).not.toThrow();
  });

  it.each([
    ["empty", ""],
    ["forward slash", "a/b"],
    ["backslash", "a\\b"],
    ["single dot", "."],
    ["double dot", ".."],
    ["null byte", "a\0b"],
  ] as const)("rejects %s", (_label, value) => {
    expect(() => validateArtifactName(value)).toThrow(ArtifactStoreError);
  });

  it("rejects a name longer than 255 characters", () => {
    const long = "x".repeat(256);
    expect(() => validateArtifactName(long)).toThrow(ArtifactStoreError);
  });

  it("accepts a name of exactly 255 characters", () => {
    const boundary = "x".repeat(255);
    expect(() => validateArtifactName(boundary)).not.toThrow();
  });
});

describe("artifactPath", () => {
  it("joins stateDir / workflows / runId / artifacts / name", () => {
    const p = artifactPath("/tmp/state", "run_1_abc123", "prd.md");
    expect(p).toBe(join("/tmp/state", "workflows", "run_1_abc123", "artifacts", "prd.md"));
  });

  it("runs the name through validateArtifactName (rejects traversal)", () => {
    expect(() => artifactPath("/tmp/state", "run_1_abc123", "../etc/passwd")).toThrow(
      ArtifactStoreError,
    );
  });

  it("rejects an absolute-looking name", () => {
    expect(() => artifactPath("/tmp/state", "run_1_abc123", "/etc/passwd")).toThrow(
      ArtifactStoreError,
    );
  });
});
