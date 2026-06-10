import { describe, expect, it } from "vitest";
import { buildMemory } from "../../sections/memory.js";

describe("buildMemory", () => {
  it("emits the Memory section in persistent mode", () => {
    const text = buildMemory({ isEphemeral: false });
    expect(text).not.toBeNull();
    expect(text).toContain("## Memory");
    expect(text).toContain("rondel_memory_append");
    expect(text).toContain("rondel_memory_replace");
    expect(text).toContain("rondel_memory_remove");
    expect(text).toContain("rondel_memory_read");
    expect(text).toContain("7-day rule");
    expect(text).not.toContain("rondel_memory_save");
  });

  it("returns null in ephemeral mode (cron)", () => {
    expect(buildMemory({ isEphemeral: true })).toBeNull();
  });
});
