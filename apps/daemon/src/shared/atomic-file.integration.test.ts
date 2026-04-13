import { describe, it, expect } from "vitest";
import { readFile, readdir, stat, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile } from "./atomic-file.js";
import { withTmpRondel } from "../../tests/helpers/tmp.js";

describe("atomicWriteFile", () => {
  it("writes a new file with exact content", async () => {
    const tmp = withTmpRondel();
    const path = join(tmp.stateDir, "new.json");
    await atomicWriteFile(path, '{"a":1}');
    expect(await readFile(path, "utf-8")).toBe('{"a":1}');
  });

  it("overwrites an existing file", async () => {
    const tmp = withTmpRondel();
    const path = join(tmp.stateDir, "x.json");
    await atomicWriteFile(path, "first");
    await atomicWriteFile(path, "second");
    expect(await readFile(path, "utf-8")).toBe("second");
  });

  it("creates parent directories recursively", async () => {
    const tmp = withTmpRondel();
    const path = join(tmp.stateDir, "deep", "nested", "dir", "file.txt");
    await atomicWriteFile(path, "content");
    expect(await readFile(path, "utf-8")).toBe("content");
  });

  it("writes an empty string as an empty file (not a no-op)", async () => {
    const tmp = withTmpRondel();
    const path = join(tmp.stateDir, "empty.txt");
    await atomicWriteFile(path, "");
    const s = await stat(path);
    expect(s.size).toBe(0);
  });

  it("leaves no .tmp siblings after a successful write", async () => {
    const tmp = withTmpRondel();
    const path = join(tmp.stateDir, "final.json");
    await atomicWriteFile(path, "payload");
    const entries = await readdir(tmp.stateDir);
    expect(entries.filter((e) => e.endsWith(".tmp"))).toEqual([]);
  });

  it("handles concurrent writes to the same path without corruption", async () => {
    const tmp = withTmpRondel();
    const path = join(tmp.stateDir, "race.json");
    const writers = [
      atomicWriteFile(path, JSON.stringify({ who: "a" })),
      atomicWriteFile(path, JSON.stringify({ who: "b" })),
      atomicWriteFile(path, JSON.stringify({ who: "c" })),
    ];
    await Promise.all(writers);
    const content = await readFile(path, "utf-8");
    // File must contain exactly one of the three writes — no partial writes.
    const parsed = JSON.parse(content) as { who: string };
    expect(["a", "b", "c"]).toContain(parsed.who);
    const entries = await readdir(tmp.stateDir);
    expect(entries.filter((e) => e.endsWith(".tmp"))).toEqual([]);
  });

  it("cleans up the .tmp file when rename fails over a non-empty directory", async () => {
    const tmp = withTmpRondel();
    // Pre-create the target path as a non-empty directory so mkdir(parent)
    // and writeFile(tmp) both succeed, but rename(tmp, target) fails with
    // EISDIR / ENOTEMPTY — exercising the unlink cleanup branch at
    // atomic-file.ts:31-35.
    const target = join(tmp.stateDir, "target.json");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "child.txt"), "blocker");

    await expect(atomicWriteFile(target, "content")).rejects.toBeDefined();

    // The .tmp sibling must have been unlinked by the cleanup branch.
    const entries = await readdir(tmp.stateDir);
    expect(entries.filter((e) => e.endsWith(".tmp"))).toEqual([]);
    // Target directory should still exist (rename failed, nothing moved).
    const s = await stat(target);
    expect(s.isDirectory()).toBe(true);
  });
});
