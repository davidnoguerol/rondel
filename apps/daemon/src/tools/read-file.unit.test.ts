import { describe, it, expect } from "vitest";
import { validateAbsolutePath } from "./_common.js";

/**
 * rondel_read_file has no own pure helpers to test — its behavior is all
 * integration-shaped (fs + bridge). The path validation it relies on is
 * already covered in _common.unit.test.ts; this file exists so a future
 * pure helper added to read-file.ts has a natural home.
 */

describe("rondel_read_file path validation contract", () => {
  it("rejects relative paths (same gate as the other filesystem tools)", () => {
    expect(validateAbsolutePath("relative/path").ok).toBe(false);
  });

  it("rejects paths with null bytes", () => {
    expect(validateAbsolutePath("/tmp/x\0y").ok).toBe(false);
  });
});
