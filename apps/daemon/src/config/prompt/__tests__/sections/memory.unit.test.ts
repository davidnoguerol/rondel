import { describe, expect, it } from "vitest";
import { buildMemory } from "../../sections/memory.js";

describe("buildMemory", () => {
  it("emits the Memory section in persistent mode", () => {
    const text = buildMemory({ isEphemeral: false });
    expect(text).not.toBeNull();
    expect(text).toContain("## Memory");
    expect(text).toContain("rondel_memory_save");
    expect(text).toContain("rondel_memory_read");
  });

  it("returns null in ephemeral mode (cron)", () => {
    expect(buildMemory({ isEphemeral: true })).toBeNull();
  });
});
