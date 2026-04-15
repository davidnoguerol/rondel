/**
 * Per-run artifact folder operations.
 *
 * Artifacts are plain files under `state/workflows/{runId}/artifacts/`.
 * Steps reference them by NAME ("prd.md", "dev-plan.md") — never by
 * absolute path. The runner resolves names to paths when feeding inputs
 * to step agents and when copying declared inputs at run start.
 *
 * Security-critical: artifact names originate from workflow definitions
 * AND from agent tool calls (`rondel_step_complete` passes an `artifact`
 * field). Agents must not be able to write outside the run's artifact
 * dir, so every name passes `validateArtifactName` before being joined
 * with the artifact directory.
 */

import { copyFile, mkdir, access } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { artifactDirectory } from "./workflow-storage.js";

export class ArtifactStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactStoreError";
  }
}

// ---------------------------------------------------------------------------
// Name handling
// ---------------------------------------------------------------------------

/** Parse an input specifier like "prd" or "prd?" into name and optionality. */
export function parseInputSpecifier(spec: string): { name: string; optional: boolean } {
  if (spec.endsWith("?")) {
    return { name: spec.slice(0, -1), optional: true };
  }
  return { name: spec, optional: false };
}

/**
 * Validate an artifact name. Rejects path separators, absolute paths,
 * parent traversal, empty/too-long names, and null bytes. Called on every
 * name before it becomes part of a filesystem path.
 */
export function validateArtifactName(name: string): void {
  if (name.length === 0) throw new ArtifactStoreError("Artifact name must not be empty");
  if (name.length > 255) throw new ArtifactStoreError(`Artifact name too long: "${name}"`);
  if (name.includes("/") || name.includes("\\")) {
    throw new ArtifactStoreError(`Artifact name must not contain path separators: "${name}"`);
  }
  if (name === "." || name === "..") {
    throw new ArtifactStoreError(`Artifact name must not be "." or ".."`);
  }
  if (name.includes("\0")) {
    throw new ArtifactStoreError("Artifact name must not contain null bytes");
  }
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/** Absolute path to an artifact file under a run's artifact dir. */
export function artifactPath(stateDir: string, runId: string, name: string): string {
  validateArtifactName(name);
  return join(artifactDirectory(stateDir, runId), name);
}

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

/**
 * Copy a source file into the run's artifact dir under the given name.
 * Used at run start to import declared inputs.
 *
 * Source must be an absolute path (validated) — the runner resolves the
 * caller's input map to absolute paths before calling this helper.
 */
export async function importArtifact(
  stateDir: string,
  runId: string,
  sourceAbsolutePath: string,
  artifactName: string,
): Promise<void> {
  validateArtifactName(artifactName);
  if (!isAbsolute(sourceAbsolutePath)) {
    throw new ArtifactStoreError(
      `importArtifact requires an absolute source path: "${sourceAbsolutePath}"`,
    );
  }
  await mkdir(artifactDirectory(stateDir, runId), { recursive: true });
  await copyFile(sourceAbsolutePath, artifactPath(stateDir, runId, artifactName));
}

/** True if the artifact exists on disk under the run's artifact dir. */
export async function artifactExists(
  stateDir: string,
  runId: string,
  name: string,
): Promise<boolean> {
  try {
    await access(artifactPath(stateDir, runId, name));
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a step's input specifiers to a list of artifact names that
 * currently exist on disk.
 *
 * Required (non-"?") inputs throw if missing. Optional ("?") inputs are
 * silently dropped. The returned list preserves author order and does
 * not contain the "?" suffix.
 */
export async function resolveStepInputs(
  stateDir: string,
  runId: string,
  specs: readonly string[],
): Promise<string[]> {
  const resolved: string[] = [];
  for (const spec of specs) {
    const { name, optional } = parseInputSpecifier(spec);
    validateArtifactName(name);
    const exists = await artifactExists(stateDir, runId, name);
    if (!exists) {
      if (optional) continue;
      throw new ArtifactStoreError(`Required input artifact "${name}" is missing`);
    }
    resolved.push(name);
  }
  return resolved;
}
