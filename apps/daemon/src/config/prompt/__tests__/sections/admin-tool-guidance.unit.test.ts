import { describe, expect, it } from "vitest";
import { buildAdminToolGuidance } from "../../sections/admin-tool-guidance.js";

describe("buildAdminToolGuidance", () => {
  it("emits for admin agents in persistent mode", () => {
    const text = buildAdminToolGuidance({ isAdmin: true, isEphemeral: false });
    expect(text).not.toBeNull();
    expect(text).toContain("## Admin Tool Guidance");
    expect(text).toContain("rondel_add_agent");
    expect(text).toContain("rondel_update_agent");
    expect(text).toContain("rondel_delete_agent");
    expect(text).toContain("rondel_create_org");
    expect(text).toContain("rondel_set_env");
    expect(text).toContain("rondel_reload");
  });

  it("returns null for non-admin agents", () => {
    expect(buildAdminToolGuidance({ isAdmin: false, isEphemeral: false })).toBeNull();
  });

  it("returns null for ephemeral runs even when admin", () => {
    expect(buildAdminToolGuidance({ isAdmin: true, isEphemeral: true })).toBeNull();
  });
});
