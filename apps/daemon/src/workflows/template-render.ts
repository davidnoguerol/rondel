/**
 * Template rendering for workflow step tasks.
 *
 * Supported placeholders:
 *   {{run.id}}             — the run id
 *   {{step.id}}            — the current step id (authored, not path-joined)
 *   {{inputs.<name>}}      — the resolved input artifact name
 *   {{artifacts.<name>}}   — the artifact name produced by a previous step
 *
 * Missing placeholders throw a descriptive error so authoring mistakes
 * fail loudly at render time rather than silently inserting empty strings.
 *
 * Pure — no I/O, fully unit-testable.
 */

export interface TemplateContext {
  readonly runId: string;
  readonly stepId: string;
  readonly inputs: Readonly<Record<string, string>>;
  readonly artifacts: Readonly<Record<string, string>>;
}

export class TemplateRenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateRenderError";
  }
}

const PLACEHOLDER = /\{\{\s*([^}]+?)\s*\}\}/g;

/**
 * Substitute `{{...}}` placeholders in `template` using `ctx`.
 *
 * Unknown or unsupported placeholders throw `TemplateRenderError`. Callers
 * should treat a render error as a configuration problem (the workflow
 * definition references something the runtime cannot provide) rather than
 * a runtime anomaly.
 */
export function renderTemplate(template: string, ctx: TemplateContext): string {
  return template.replace(PLACEHOLDER, (_match, raw: string) => {
    const key = raw.trim();
    const resolved = resolvePlaceholder(key, ctx);
    if (resolved === undefined) {
      throw new TemplateRenderError(`Unknown placeholder: {{${key}}}`);
    }
    return resolved;
  });
}

function resolvePlaceholder(key: string, ctx: TemplateContext): string | undefined {
  if (key === "run.id") return ctx.runId;
  if (key === "step.id") return ctx.stepId;

  if (key.startsWith("inputs.")) {
    const name = key.slice("inputs.".length);
    return ctx.inputs[name];
  }

  if (key.startsWith("artifacts.")) {
    const name = key.slice("artifacts.".length);
    return ctx.artifacts[name];
  }

  return undefined;
}
