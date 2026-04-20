import { describe, expect, it } from "vitest";
import { buildCliQuickReference } from "../../sections/cli-quick-reference.js";

describe("buildCliQuickReference", () => {
  it("emits the section in persistent mode with all core commands", () => {
    const text = buildCliQuickReference({ isEphemeral: false });
    expect(text).not.toBeNull();
    expect(text).toContain("## Rondel CLI Quick Reference");
    expect(text).toContain("`rondel status`");
    expect(text).toContain("`rondel restart`");
    expect(text).toContain("`rondel logs");
    expect(text).toContain("`rondel doctor`");
    expect(text).toContain("`rondel add agent");
    expect(text).toContain("`rondel add org");
  });

  it("returns null in ephemeral mode", () => {
    expect(buildCliQuickReference({ isEphemeral: true })).toBeNull();
  });
});
