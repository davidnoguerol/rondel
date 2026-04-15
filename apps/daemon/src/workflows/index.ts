/**
 * Workflow engine module — public API.
 *
 * External code imports only from this barrel, never from internal files.
 * v0 exposes the pure-core helpers that other commits build on. Later
 * commits add the WorkflowManager (the DI entry point) and hook-driven
 * event surfaces.
 */

export { renderTemplate, TemplateRenderError } from "./template-render.js";
export type { TemplateContext } from "./template-render.js";

export {
  shouldRunInAttempt,
  buildRetryStepKey,
  evaluateSucceedsWhen,
  validateRetryTarget,
} from "./step-retry.js";

export {
  parseWorkflowDefinition,
  loadWorkflowFromFile,
  discoverWorkflows,
  WorkflowLoadError,
} from "./workflow-loader.js";
export type { DiscoveredWorkflow, WorkflowDiscoveryScope } from "./workflow-loader.js";

export {
  runDirectory,
  artifactDirectory,
  gateDirectory,
  runStatePath,
  definitionSnapshotPath,
  gateRecordPath,
  ensureRunDirectories,
  writeRunState,
  readRunState,
  listRunIds,
  writeDefinitionSnapshot,
  readDefinitionSnapshot,
  writeGateRecord,
  readGateRecord,
  listGateRecords,
  WorkflowStorageError,
} from "./workflow-storage.js";

export {
  parseInputSpecifier,
  validateArtifactName,
  artifactPath,
  importArtifact,
  artifactExists,
  resolveStepInputs,
  ArtifactStoreError,
} from "./artifact-store.js";
