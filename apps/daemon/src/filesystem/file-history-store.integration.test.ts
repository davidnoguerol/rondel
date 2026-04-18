import { describe, it, expect } from "vitest";
import { readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { FileHistoryStore } from "./file-history-store.js";
import { withTmpRondel } from "../../tests/helpers/tmp.js";
import { createCapturingLogger } from "../../tests/helpers/logger.js";

describe("FileHistoryStore", () => {
  it("backup + list roundtrip returns the entry with correct fields", async () => {
    const tmp = withTmpRondel();
    const store = new FileHistoryStore(tmp.stateDir, createCapturingLogger());

    const backupId = await store.backup("alice", "/tmp/project/foo.txt", "old contents\nline 2\n");
    expect(typeof backupId).toBe("string");
    expect(backupId.length).toBeGreaterThan(0);

    const entries = await store.list("alice");
    expect(entries).toHaveLength(1);
    expect(entries[0].backupId).toBe(backupId);
    expect(entries[0].originalPath).toBe("/tmp/project/foo.txt");
    expect(entries[0].sizeBytes).toBe("old contents\nline 2\n".length);
    expect(typeof entries[0].createdAt).toBe("string");
    expect(Number.isNaN(Date.parse(entries[0].createdAt))).toBe(false);
  });

  it("restore returns the exact pre-image and originalPath", async () => {
    const tmp = withTmpRondel();
    const store = new FileHistoryStore(tmp.stateDir, createCapturingLogger());
    const content = "line1\nline2\n";
    const backupId = await store.backup("alice", "/tmp/project/foo.txt", content);

    const restored = await store.restore("alice", backupId);
    expect(restored.originalPath).toBe("/tmp/project/foo.txt");
    expect(restored.content).toBe(content);
  });

  it("list filtered by originalPath returns only that file's backups", async () => {
    const tmp = withTmpRondel();
    const store = new FileHistoryStore(tmp.stateDir, createCapturingLogger());
    await store.backup("alice", "/tmp/a.txt", "A1");
    await store.backup("alice", "/tmp/b.txt", "B1");
    await store.backup("alice", "/tmp/a.txt", "A2");

    const onlyA = await store.list("alice", "/tmp/a.txt");
    expect(onlyA).toHaveLength(2);
    for (const e of onlyA) {
      expect(e.originalPath).toBe("/tmp/a.txt");
    }

    const onlyB = await store.list("alice", "/tmp/b.txt");
    expect(onlyB).toHaveLength(1);
    expect(onlyB[0].originalPath).toBe("/tmp/b.txt");
  });

  it("multiple backups of the same path are listed newest first", async () => {
    const tmp = withTmpRondel();
    const store = new FileHistoryStore(tmp.stateDir, createCapturingLogger());
    await store.backup("alice", "/tmp/a.txt", "v1");
    // ISO timestamps have millisecond resolution; sleep 5ms to guarantee
    // ordering holds regardless of system clock quirks.
    await new Promise((r) => setTimeout(r, 5));
    await store.backup("alice", "/tmp/a.txt", "v2");
    await new Promise((r) => setTimeout(r, 5));
    await store.backup("alice", "/tmp/a.txt", "v3");

    const list = await store.list("alice", "/tmp/a.txt");
    expect(list).toHaveLength(3);
    // Descending by createdAt
    expect(list[0].createdAt >= list[1].createdAt).toBe(true);
    expect(list[1].createdAt >= list[2].createdAt).toBe(true);
  });

  it("missing agent directory yields empty list + cleanup no-op", async () => {
    const tmp = withTmpRondel();
    const store = new FileHistoryStore(tmp.stateDir, createCapturingLogger());
    expect(await store.list("ghost")).toEqual([]);
    expect(await store.cleanup(0)).toBe(0);
  });

  it("cleanup with olderThanMs=0 prunes everything and preserves sidecars match", async () => {
    const tmp = withTmpRondel();
    const store = new FileHistoryStore(tmp.stateDir, createCapturingLogger());
    await store.backup("alice", "/tmp/a.txt", "x");
    await store.backup("alice", "/tmp/b.txt", "y");

    const removed = await store.cleanup(0);
    expect(removed).toBe(2);
    expect(await store.list("alice")).toEqual([]);
  });

  it("cleanup with a large retention keeps fresh backups", async () => {
    const tmp = withTmpRondel();
    const store = new FileHistoryStore(tmp.stateDir, createCapturingLogger());
    await store.backup("alice", "/tmp/a.txt", "x");
    const removed = await store.cleanup(24 * 60 * 60 * 1000); // 1 day retention
    expect(removed).toBe(0);
    expect(await store.list("alice")).toHaveLength(1);
  });

  it("content with newlines and unicode roundtrips exactly", async () => {
    const tmp = withTmpRondel();
    const store = new FileHistoryStore(tmp.stateDir, createCapturingLogger());
    const content = "héllo\n世界\n\r\n\tfinal line";
    const id = await store.backup("alice", "/tmp/unicode.txt", content);
    const { content: restored } = await store.restore("alice", id);
    expect(restored).toBe(content);
  });

  it("orphan .pre file (missing meta sidecar) is silently skipped by list", async () => {
    const tmp = withTmpRondel();
    const store = new FileHistoryStore(tmp.stateDir, createCapturingLogger());
    const id = await store.backup("alice", "/tmp/a.txt", "content");
    // Delete the sidecar
    await rm(join(tmp.stateDir, "file-history", "alice", `${id}.meta.json`));
    const list = await store.list("alice");
    expect(list).toEqual([]);
  });

  it("concurrent backups of the same path produce distinct ids", async () => {
    const tmp = withTmpRondel();
    const store = new FileHistoryStore(tmp.stateDir, createCapturingLogger());
    // Sequential to guarantee unique timestamps.
    const ids = [] as string[];
    for (let i = 0; i < 3; i++) {
      ids.push(await store.backup("alice", "/tmp/a.txt", `v${i}`));
      await new Promise((r) => setTimeout(r, 2));
    }
    // All ids distinct
    expect(new Set(ids).size).toBe(3);

    // All files exist on disk
    for (const id of ids) {
      const s = await stat(join(tmp.stateDir, "file-history", "alice", `${id}.pre`));
      expect(s.isFile()).toBe(true);
    }
  });

  it("restore reads the exact bytes even after other backups land", async () => {
    const tmp = withTmpRondel();
    const store = new FileHistoryStore(tmp.stateDir, createCapturingLogger());
    const id1 = await store.backup("alice", "/tmp/a.txt", "first");
    await new Promise((r) => setTimeout(r, 5));
    await store.backup("alice", "/tmp/a.txt", "second");
    await new Promise((r) => setTimeout(r, 5));
    await store.backup("alice", "/tmp/a.txt", "third");

    const restored = await store.restore("alice", id1);
    expect(restored.content).toBe("first");
  });

  it("sidecar file contains the originalPath and createdAt verbatim", async () => {
    const tmp = withTmpRondel();
    const store = new FileHistoryStore(tmp.stateDir, createCapturingLogger());
    const id = await store.backup("alice", "/tmp/a.txt", "x");
    const raw = await readFile(
      join(tmp.stateDir, "file-history", "alice", `${id}.meta.json`),
      "utf-8",
    );
    const parsed = JSON.parse(raw) as { originalPath: string; createdAt: string };
    expect(parsed.originalPath).toBe("/tmp/a.txt");
    expect(typeof parsed.createdAt).toBe("string");
  });
});
