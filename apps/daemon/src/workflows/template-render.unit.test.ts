import { describe, it, expect } from "vitest";
import { renderTemplate, TemplateRenderError, type TemplateContext } from "./template-render.js";

const baseCtx: TemplateContext = {
  runId: "run_1700000000000_abc123",
  stepId: "architecture",
  inputs: { prd: "prd.md", spec: "spec.md" },
  artifacts: { "dev-plan.md": "dev-plan.md", "code-summary.md": "code-summary.md" },
};

describe("renderTemplate", () => {
  it("returns the input unchanged when there are no placeholders", () => {
    expect(renderTemplate("hello world", baseCtx)).toBe("hello world");
  });

  it("substitutes {{run.id}}", () => {
    expect(renderTemplate("run is {{run.id}}", baseCtx)).toBe("run is run_1700000000000_abc123");
  });

  it("substitutes {{step.id}}", () => {
    expect(renderTemplate("step is {{step.id}}", baseCtx)).toBe("step is architecture");
  });

  it("substitutes {{inputs.<name>}}", () => {
    expect(renderTemplate("read {{inputs.prd}}", baseCtx)).toBe("read prd.md");
  });

  it("substitutes {{artifacts.<name>}}", () => {
    const result = renderTemplate("see {{artifacts.dev-plan.md}}", baseCtx);
    expect(result).toBe("see dev-plan.md");
  });

  it("substitutes multiple placeholders in one string", () => {
    const tpl = "{{step.id}}: read {{inputs.prd}} and {{inputs.spec}}";
    expect(renderTemplate(tpl, baseCtx)).toBe("architecture: read prd.md and spec.md");
  });

  it("tolerates internal whitespace in braces", () => {
    expect(renderTemplate("{{  inputs.prd  }}", baseCtx)).toBe("prd.md");
  });

  it("throws TemplateRenderError for unknown placeholder", () => {
    expect(() => renderTemplate("{{unknown.thing}}", baseCtx))
      .toThrow(TemplateRenderError);
  });

  it("throws TemplateRenderError for missing input", () => {
    expect(() => renderTemplate("{{inputs.missing}}", baseCtx))
      .toThrow(/Unknown placeholder: \{\{inputs\.missing\}\}/);
  });

  it("throws TemplateRenderError for missing artifact", () => {
    expect(() => renderTemplate("{{artifacts.none}}", baseCtx))
      .toThrow(/Unknown placeholder: \{\{artifacts\.none\}\}/);
  });

  it("does not interpret single braces as placeholders", () => {
    expect(renderTemplate("use { braces } fine", baseCtx)).toBe("use { braces } fine");
  });

  it("handles an empty template", () => {
    expect(renderTemplate("", baseCtx)).toBe("");
  });

  it("allows a placeholder to produce an empty string if the input is empty", () => {
    const ctx: TemplateContext = { ...baseCtx, inputs: { empty: "" } };
    expect(renderTemplate("before{{inputs.empty}}after", ctx)).toBe("beforeafter");
  });

  it("treats trailing '?' as part of the name so optional input syntax is template-safe", () => {
    // Optional input specifiers ("prd?") are parsed by artifact-store, NOT
    // by the template renderer. A placeholder like {{inputs.prd?}} asks for
    // an input literally named "prd?" and should fail if absent.
    expect(() => renderTemplate("{{inputs.prd?}}", baseCtx))
      .toThrow(TemplateRenderError);
  });
});
