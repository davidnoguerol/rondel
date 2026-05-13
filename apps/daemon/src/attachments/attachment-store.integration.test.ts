import { describe, it, expect } from "vitest";
import { readFile, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AttachmentStore } from "./attachment-store.js";
import { withTmpRondel } from "../../../../tests/helpers/tmp.js";
import { createCapturingLogger } from "../../../../tests/helpers/logger.js";

function newStore(rondelHome: string): AttachmentStore {
  return new AttachmentStore(join(rondelHome, "state", "attachments"), createCapturingLogger());
}

describe("AttachmentStore", () => {
  it("save + list roundtrip stages bytes under the per-conversation subtree", async () => {
    const tmp = withTmpRondel();
    const store = newStore(tmp.rondelHome);

    const staged = await store.save("alice", "12345", Buffer.from("hello world"), {
      messageId: 7,
      extension: ".txt",
    });

    expect(staged.bytes).toBe("hello world".length);
    // Path lives under attachments/<agent>/<chatId>/...
    expect(staged.path).toContain(join(tmp.stateDir, "attachments", "alice", "12345"));
    expect(staged.path.endsWith(".txt")).toBe(true);
    expect(await readFile(staged.path, "utf-8")).toBe("hello world");

    const listed = await store.list("alice", "12345");
    expect(listed).toHaveLength(1);
    expect(listed[0].path).toBe(staged.path);
    expect(listed[0].bytes).toBe(staged.bytes);
  });

  it("ensureConversationDir creates a fresh empty directory before any save lands", async () => {
    const tmp = withTmpRondel();
    const store = newStore(tmp.rondelHome);

    const dir = await store.ensureConversationDir("bob", "555");
    expect(dir).toBe(store.conversationDir("bob", "555"));

    const s = await stat(dir);
    expect(s.isDirectory()).toBe(true);

    const listed = await store.list("bob", "555");
    expect(listed).toHaveLength(0);
  });

  it("sanitises path traversal / shell characters in agent and chat keys", async () => {
    const tmp = withTmpRondel();
    const store = newStore(tmp.rondelHome);

    const evilAgent = "../../etc";
    const evilChat = "../../passwd";
    const dir = store.conversationDir(evilAgent, evilChat);

    // No `..` segments survive into the resolved path.
    expect(dir.split("/").every((seg) => seg !== "..")).toBe(true);
    // The dir still lives under the attachments root.
    expect(dir.startsWith(join(tmp.stateDir, "attachments"))).toBe(true);
  });

  it("cleanup removes only files older than the cutoff and leaves fresh ones", async () => {
    const tmp = withTmpRondel();
    const store = newStore(tmp.rondelHome);

    // Bypass `save()` here — `save` runs an opportunistic per-save
    // prune that would race with our `utimes` backdate. The unit
    // under test is `cleanup` itself, so seed the directory directly.
    const dir = await store.ensureConversationDir("alice", "1");
    const stalePath = join(dir, "stale-file.bin");
    const freshPath = join(dir, "fresh-file.bin");
    await writeFile(stalePath, "OLD");
    await writeFile(freshPath, "NEW");

    // Backdate `stale` to two days ago — outside any reasonable
    // cleanup window without sleeping in real time.
    const longAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    await utimes(stalePath, longAgo, longAgo);

    const removed = await store.cleanup(24 * 60 * 60 * 1000);
    expect(removed).toBe(1);

    const survivors = await store.list("alice", "1");
    expect(survivors.map((s) => s.path)).toEqual([freshPath]);
  });

  it("cleanup returns 0 and does not throw when the attachments root does not exist", async () => {
    const tmp = withTmpRondel();
    // Note: state dir exists, but attachments subtree was never created.
    const store = newStore(tmp.rondelHome);

    const removed = await store.cleanup(1_000);
    expect(removed).toBe(0);
  });

  it("per-conversation listings are isolated — alice cannot see bob's files", async () => {
    const tmp = withTmpRondel();
    const store = newStore(tmp.rondelHome);

    await store.save("alice", "1", Buffer.from("A"), { messageId: 1 });
    await store.save("bob", "1", Buffer.from("B"), { messageId: 1 });

    const aliceFiles = await store.list("alice", "1");
    const bobFiles = await store.list("bob", "1");

    expect(aliceFiles).toHaveLength(1);
    expect(bobFiles).toHaveLength(1);
    expect(aliceFiles[0].path).not.toBe(bobFiles[0].path);
  });
});
