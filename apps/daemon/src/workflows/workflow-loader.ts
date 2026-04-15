/**
 * Workflow definition loader.
 *
 * Parses JSON workflow files, validates them against the Zod schema from
 * bridge/schemas.ts, and performs structural checks that Zod cannot (unique
 * step ids, retry targets exist inside body). Pure parsing is in
 * `parseWorkflowDefinition` — unit-testable with a raw JSON string. File
 * I/O and discovery wrappers sit on top.
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { WorkflowDefinition, Step, RetryStep } from "../shared/types/index.js";
import { WorkflowDefinitionSchema } from "../bridge/schemas.js";
import { validateRetryTarget } from "./step-retry.js";

export class WorkflowLoadError extends Error {
  readonly sourcePath: string | undefined;
  constructor(message: string, sourcePath?: string) {
    super(sourcePath ? `${message} (source: ${sourcePath})` : message);
    this.name = "WorkflowLoadError";
    this.sourcePath = sourcePath;
  }
}

// ---------------------------------------------------------------------------
// Pure parsing (unit-testable)
// ---------------------------------------------------------------------------

/**
 * Parse a workflow definition from a raw JSON string.
 *
 * Performs three validation passes:
 *  1. JSON syntax
 *  2. Zod schema (field types, enum values, required fields, nested step shapes)
 *  3. Structural — unique step ids across the whole tree, retry targets
 *     reference existing steps inside their body.
 *
 * Throws `WorkflowLoadError` with a descriptive message on any failure.
 */
export function parseWorkflowDefinition(
  raw: string,
  sourceLabel?: string,
): WorkflowDefinition {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new WorkflowLoadError(`Invalid JSON: ${msg}`, sourceLabel);
  }

  const result = WorkflowDefinitionSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((i) => {
      const path = i.path.length > 0 ? `${i.path.join(".")}: ` : "";
      return `${path}${i.message}`;
    }).join("; ");
    throw new WorkflowLoadError(`Invalid workflow definition: ${issues}`, sourceLabel);
  }

  // z.ZodType<any> on the recursive step union means result.data is loosely
  // typed. The hand-written WorkflowDefinition is the source of truth —
  // the structural checks below ensure it's safe to trust the cast.
  const definition = result.data as unknown as WorkflowDefinition;

  const seen = new Set<string>();
  for (const step of definition.steps) {
    validateStepTree(step, seen, sourceLabel);
  }

  return definition;
}

/** Depth-first walk validating each step; mutates `seen`. */
function validateStepTree(step: Step, seen: Set<string>, source?: string): void {
  if (seen.has(step.id)) {
    throw new WorkflowLoadError(`Duplicate step id "${step.id}"`, source);
  }
  seen.add(step.id);

  if (step.kind === "retry") {
    const retry = step as RetryStep;
    if (retry.body.length === 0) {
      throw new WorkflowLoadError(`RetryStep "${retry.id}" has empty body`, source);
    }
    try {
      validateRetryTarget(retry);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new WorkflowLoadError(msg, source);
    }
    for (const inner of retry.body) {
      validateStepTree(inner, seen, source);
    }
  }
}

// ---------------------------------------------------------------------------
// File + discovery wrappers
// ---------------------------------------------------------------------------

/** Load a single workflow definition from an absolute file path. */
export async function loadWorkflowFromFile(filePath: string): Promise<WorkflowDefinition> {
  const raw = await readFile(filePath, "utf-8");
  return parseWorkflowDefinition(raw, filePath);
}

export interface DiscoveredWorkflow {
  readonly definition: WorkflowDefinition;
  readonly sourcePath: string;
  /** `null` for workflows under `workspaces/global/workflows/`. */
  readonly orgName: string | null;
}

export interface WorkflowDiscoveryScope {
  readonly orgName: string;
  readonly orgDir: string;
}

/**
 * Discover all workflow JSON files under:
 *   - workspaces/global/workflows/*.json  (scope: null)
 *   - workspaces/{org}/workflows/*.json   (scope: orgName) for each org
 *
 * Workflow ids must be globally unique across all scopes. A duplicate
 * throws `WorkflowLoadError` pointing at both sources — matches the
 * precedent for agent/org discovery.
 */
export async function discoverWorkflows(
  workspacesDir: string,
  orgs: readonly WorkflowDiscoveryScope[],
): Promise<Map<string, DiscoveredWorkflow>> {
  const result = new Map<string, DiscoveredWorkflow>();

  const globalDir = join(workspacesDir, "global", "workflows");
  await scanWorkflowDir(globalDir, null, result);

  for (const org of orgs) {
    const orgWorkflowsDir = join(org.orgDir, "workflows");
    await scanWorkflowDir(orgWorkflowsDir, org.orgName, result);
  }

  return result;
}

async function scanWorkflowDir(
  dir: string,
  orgName: string | null,
  target: Map<string, DiscoveredWorkflow>,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // missing directory — treat as empty
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".json")) continue;
    const filePath = join(dir, entry.name);
    const def = await loadWorkflowFromFile(filePath);

    const existing = target.get(def.id);
    if (existing) {
      throw new WorkflowLoadError(
        `Duplicate workflow id "${def.id}" in ${filePath} (already loaded from ${existing.sourcePath})`,
        filePath,
      );
    }
    target.set(def.id, { definition: def, sourcePath: filePath, orgName });
  }
}
