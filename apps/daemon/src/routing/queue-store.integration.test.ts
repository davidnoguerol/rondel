/**
 * Integration tests for the per-conversation queue store.
 * Mirrors the structure of messaging/inbox.integration.test.ts.
 */

import { describe, it, expect } from "vitest";
import { readFile, stat, writeFile, mkdir, readdir, access } from "node:fs/promises";
import { join } from "node:path";
import { QueueStore } from "./queue-store.js";
import { conversationKey, type ConversationKey, type QueuedMessage } from "../shared/types/index.js";
import { withTmpRondel } from "../../../../tests/helpers/tmp.js";

const KEY_A: ConversationKey = conversationKey("bot1", "telegram", "chat1");
const KEY_B: ConversationKey = conversationKey("bot1", "telegram", "chat2");

function makeMessage(partial: Partial<QueuedMessage> & { text: string }): QueuedMessage {
  return {
    agentName: "bot1",
    channelType: "telegram",
    accountId: "bot1",
    chatId: "chat1",
    queuedAt: Date.now(),
    ...partial,
  };
}

function fileFor(stateDir: string, key: ConversationKey): string {
  return join(stateDir, "queues", `${encodeURIComponent(key)}.json`);
}

describe("QueueStore — ensureDir", () => {
  it("creates the queues directory", async () => {
    const tmp = withTmpRondel();
    const store = new QueueStore(tmp.stateDir);
    await store.ensureDir();
    const s = await stat(join(tmp.stateDir, "queues"));
    expect(s.isDirectory()).toBe(true);
  });

  it("is idempotent when called repeatedly", async () => {
    const tmp = withTmpRondel();
    const store = new QueueStore(tmp.stateDir);
    await store.ensureDir();
    await store.ensureDir();
    const s = await stat(join(tmp.stateDir, "queues"));
    expect(s.isDirectory()).toBe(true);
  });
});

describe("QueueStore — append", () => {
  it("creates the file when missing and stores the message", async () => {
    const tmp = withTmpRondel();
    const store = new QueueStore(tmp.stateDir);
    await store.append(KEY_A, makeMessage({ text: "first" }));

    const content = await readFile(fileFor(tmp.stateDir, KEY_A), "utf-8");
    const parsed = JSON.parse(content) as QueuedMessage[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0].text).toBe("first");
  });

  it("appends to an existing file preserving order", async () => {
    const tmp = withTmpRondel();
    const store = new QueueStore(tmp.stateDir);
    await store.append(KEY_A, makeMessage({ text: "a" }));
    await store.append(KEY_A, makeMessage({ text: "b" }));
    await store.append(KEY_A, makeMessage({ text: "c" }));

    const all = await store.readAll();
    expect(all.get(KEY_A)!.map((m) => m.text)).toEqual(["a", "b", "c"]);
  });

  it("preserves all 10 messages under concurrent appends on the same key", async () => {
    const tmp = withTmpRondel();
    const store = new QueueStore(tmp.stateDir);

    const texts = Array.from({ length: 10 }, (_, i) => `m${i}`);
    await Promise.all(texts.map((t) => store.append(KEY_A, makeMessage({ text: t }))));

    const all = await store.readAll();
    const stored = all.get(KEY_A)!.map((m) => m.text);
    // Order of concurrent appends isn't guaranteed, but nothing must be lost.
    expect(stored.sort()).toEqual(texts.sort());
  });
});

describe("QueueStore — removeFirst", () => {
  it("returns and removes the head, preserving the rest", async () => {
    const tmp = withTmpRondel();
    const store = new QueueStore(tmp.stateDir);
    await store.append(KEY_A, makeMessage({ text: "a" }));
    await store.append(KEY_A, makeMessage({ text: "b" }));

    const first = await store.removeFirst(KEY_A);
    expect(first?.text).toBe("a");

    const all = await store.readAll();
    expect(all.get(KEY_A)!.map((m) => m.text)).toEqual(["b"]);
  });

  it("deletes the file when the queue empties", async () => {
    const tmp = withTmpRondel();
    const store = new QueueStore(tmp.stateDir);
    await store.append(KEY_A, makeMessage({ text: "only" }));
    await store.removeFirst(KEY_A);

    await expect(access(fileFor(tmp.stateDir, KEY_A))).rejects.toThrow();
  });

  it("returns undefined when the queue file doesn't exist", async () => {
    const tmp = withTmpRondel();
    const store = new QueueStore(tmp.stateDir);
    const result = await store.removeFirst(KEY_A);
    expect(result).toBeUndefined();
  });
});

describe("QueueStore — clear", () => {
  it("removes all messages for a conversation", async () => {
    const tmp = withTmpRondel();
    const store = new QueueStore(tmp.stateDir);
    await store.append(KEY_A, makeMessage({ text: "a" }));
    await store.append(KEY_A, makeMessage({ text: "b" }));

    await store.clear(KEY_A);

    const all = await store.readAll();
    expect(all.has(KEY_A)).toBe(false);
  });

  it("is idempotent on a missing queue", async () => {
    const tmp = withTmpRondel();
    const store = new QueueStore(tmp.stateDir);
    await expect(store.clear(KEY_A)).resolves.toBeUndefined();
  });

  it("leaves other conversations untouched", async () => {
    const tmp = withTmpRondel();
    const store = new QueueStore(tmp.stateDir);
    await store.append(KEY_A, makeMessage({ text: "a" }));
    await store.append(KEY_B, makeMessage({ text: "b" }));

    await store.clear(KEY_A);

    const all = await store.readAll();
    expect(all.has(KEY_A)).toBe(false);
    expect(all.get(KEY_B)!.map((m) => m.text)).toEqual(["b"]);
  });
});

describe("QueueStore — readAll", () => {
  it("returns per-conversation messages across multiple files", async () => {
    const tmp = withTmpRondel();
    const store = new QueueStore(tmp.stateDir);
    await store.append(KEY_A, makeMessage({ text: "a1" }));
    await store.append(KEY_A, makeMessage({ text: "a2" }));
    await store.append(KEY_B, makeMessage({ text: "b1" }));

    const all = await store.readAll();
    expect(all.get(KEY_A)!.map((m) => m.text)).toEqual(["a1", "a2"]);
    expect(all.get(KEY_B)!.map((m) => m.text)).toEqual(["b1"]);
  });

  it("returns an empty map when the queues directory doesn't exist", async () => {
    const tmp = withTmpRondel();
    const store = new QueueStore(tmp.stateDir);
    const all = await store.readAll();
    expect(all.size).toBe(0);
  });

  it("skips files with malformed names (not a valid conversation key)", async () => {
    const tmp = withTmpRondel();
    const store = new QueueStore(tmp.stateDir);
    await store.ensureDir();
    // Drop a file with a garbage name that decodes to something without two colons.
    await writeFile(join(tmp.stateDir, "queues", "garbage.json"), "[]");
    await store.append(KEY_A, makeMessage({ text: "real" }));

    const all = await store.readAll();
    expect(all.size).toBe(1);
    expect(all.get(KEY_A)!.map((m) => m.text)).toEqual(["real"]);
  });
});

describe("QueueStore — corruption handling", () => {
  it("quarantines a file containing invalid JSON on next read", async () => {
    const tmp = withTmpRondel();
    const store = new QueueStore(tmp.stateDir);
    await store.ensureDir();
    await writeFile(fileFor(tmp.stateDir, KEY_A), "not json");

    // Next read returns empty; original file is quarantined.
    const all = await store.readAll();
    expect(all.has(KEY_A)).toBe(false);

    const files = await readdir(join(tmp.stateDir, "queues"));
    expect(files.some((f) => f.includes(".corrupted."))).toBe(true);
  });

  it("quarantines a file whose payload is not an array", async () => {
    const tmp = withTmpRondel();
    const store = new QueueStore(tmp.stateDir);
    await store.ensureDir();
    await writeFile(fileFor(tmp.stateDir, KEY_A), '{"not":"an array"}');

    await store.readAll(); // triggers quarantine path

    const files = await readdir(join(tmp.stateDir, "queues"));
    expect(files.some((f) => f.includes(".corrupted."))).toBe(true);
  });
});
