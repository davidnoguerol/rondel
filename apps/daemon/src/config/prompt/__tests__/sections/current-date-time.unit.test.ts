import { describe, expect, it } from "vitest";
import { buildCurrentDateTime } from "../../sections/current-date-time.js";

describe("buildCurrentDateTime", () => {
  it("emits the section when a timezone is provided", () => {
    const text = buildCurrentDateTime({ timezone: "America/New_York" });
    expect(text).not.toBeNull();
    expect(text).toContain("## Current Date & Time");
    expect(text).toContain("Time zone: America/New_York");
    expect(text).toContain("rondel_system_status");
    expect(text).toContain("currentTimeIso");
  });

  it("returns null when timezone is null (not configured)", () => {
    expect(buildCurrentDateTime({ timezone: null })).toBeNull();
  });

  it("does NOT bake a timestamp into the prompt (stale-risk on always-on agents)", () => {
    const text = buildCurrentDateTime({ timezone: "UTC" });
    // Should NOT contain an ISO date pattern like 20YY-MM-DD — that would be baked in.
    expect(text ?? "").not.toMatch(/\b20\d{2}-\d{2}-\d{2}\b/);
  });
});
