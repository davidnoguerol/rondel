import { describe, it, expect } from "vitest";
import { readFile, stat, writeFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  ensureInboxDir,
  appendToInbox,
  removeFromInbox,
  readAllInboxes,
} from "./inbox.js";
import { withTmpRondel } from "../../tests/helpers/tmp.js";
import { makeInterAgentMessage } from "../../tests/helpers/fixtures.js";

const inboxFor = (stateDir: string, agent: string): string =>
  join(stateDir, "inboxes", `${agent}.json`);

describe("ensureInboxDir", () => {
  it("creates the inboxes directory", async () => {
    const tmp = withTmpRondel();
    await ensureInboxDir(tmp.stateDir);
    const s = await stat(join(tmp.stateDir, "inboxes"));
    expect(s.isDirectory()).toBe(true);
  });

  it("is idempotent when called repeatedly", async () => {
    const tmp = withTmpRondel();
    await ensureInboxDir(tmp.stateDir);
    await ensureInboxDir(tmp.stateDir);
    const s = await stat(join(tmp.stateDir, "inboxes"));
    expect(s.isDirectory()).toBe(true);
  });
});

describe("appendToInbox", () => {
  it("creates the file when missing and stores the message", async () => {
    const tmp = withTmpRondel();
    await appendToInbox(tmp.stateDir, makeInterAgentMessage({ to: "bob" }));
    const content = await readFile(inboxFor(tmp.stateDir, "bob"), "utf-8");
    const parsed = JSON.parse(content) as Array<{ id: string }>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe("msg_test_1");
  });

  it("appends to an existing file preserving order", async () => {
    const tmp = withTmpRondel();
    await appendToInbox(
      tmp.stateDir,
      makeInterAgentMessage({ id: "m1", to: "bob" }),
    );
    await appendToInbox(
      tmp.stateDir,
      makeInterAgentMessage({ id: "m2", to: "bob" }),
    );
    await appendToInbox(
      tmp.stateDir,
      makeInterAgentMessage({ id: "m3", to: "bob" }),
    );
    const all = await readAllInboxes(tmp.stateDir);
    expect(all.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
  });

  it("produces JSON readable by readAllInboxes", async () => {
    const tmp = withTmpRondel();
    await appendToInbox(
      tmp.stateDir,
      makeInterAgentMessage({ to: "bob", content: "hi" }),
    );
    const all = await readAllInboxes(tmp.stateDir);
    expect(all).toHaveLength(1);
    expect(all[0].content).toBe("hi");
  });
});

describe("removeFromInbox", () => {
  it("removes a message by id", async () => {
    const tmp = withTmpRondel();
    await appendToInbox(
      tmp.stateDir,
      makeInterAgentMessage({ id: "keep", to: "bob" }),
    );
    await appendToInbox(
      tmp.stateDir,
      makeInterAgentMessage({ id: "drop", to: "bob" }),
    );
    await removeFromInbox(tmp.stateDir, "bob", "drop");
    const all = await readAllInboxes(tmp.stateDir);
    expect(all.map((m) => m.id)).toEqual(["keep"]);
  });

  it("is idempotent — removing the same id twice is a no-op", async () => {
    const tmp = withTmpRondel();
    await appendToInbox(
      tmp.stateDir,
      makeInterAgentMessage({ id: "keep", to: "bob" }),
    );
    await appendToInbox(
      tmp.stateDir,
      makeInterAgentMessage({ id: "drop", to: "bob" }),
    );
    await removeFromInbox(tmp.stateDir, "bob", "drop");
    await removeFromInbox(tmp.stateDir, "bob", "drop"); // no throw
    const all = await readAllInboxes(tmp.stateDir);
    expect(all.map((m) => m.id)).toEqual(["keep"]);
  });

  it("is a no-op when the agent has no inbox file", async () => {
    const tmp = withTmpRondel();
    await ensureInboxDir(tmp.stateDir);
    await expect(
      removeFromInbox(tmp.stateDir, "nobody", "missing"),
    ).resolves.toBeUndefined();
  });

  it("deletes the inbox file entirely when the list becomes empty", async () => {
    const tmp = withTmpRondel();
    await appendToInbox(
      tmp.stateDir,
      makeInterAgentMessage({ id: "only", to: "bob" }),
    );
    await removeFromInbox(tmp.stateDir, "bob", "only");
    await expect(stat(inboxFor(tmp.stateDir, "bob"))).rejects.toBeDefined();
  });

  it("rewrites the file when one of N remains", async () => {
    const tmp = withTmpRondel();
    await appendToInbox(tmp.stateDir, makeInterAgentMessage({ id: "a", to: "bob" }));
    await appendToInbox(tmp.stateDir, makeInterAgentMessage({ id: "b", to: "bob" }));
    await appendToInbox(tmp.stateDir, makeInterAgentMessage({ id: "c", to: "bob" }));
    await removeFromInbox(tmp.stateDir, "bob", "b");
    const all = await readAllInboxes(tmp.stateDir);
    expect(all.map((m) => m.id)).toEqual(["a", "c"]);
  });
});

describe("readAllInboxes", () => {
  it("returns [] when the inbox directory does not exist", async () => {
    const tmp = withTmpRondel();
    expect(await readAllInboxes(tmp.stateDir)).toEqual([]);
  });

  it("returns [] when the inbox directory is empty", async () => {
    const tmp = withTmpRondel();
    await ensureInboxDir(tmp.stateDir);
    expect(await readAllInboxes(tmp.stateDir)).toEqual([]);
  });

  it("aggregates messages across multiple agent inbox files", async () => {
    const tmp = withTmpRondel();
    await appendToInbox(tmp.stateDir, makeInterAgentMessage({ id: "m1", to: "bob" }));
    await appendToInbox(tmp.stateDir, makeInterAgentMessage({ id: "m2", to: "carol" }));
    const all = await readAllInboxes(tmp.stateDir);
    expect(all.map((m) => m.id).sort()).toEqual(["m1", "m2"]);
  });

  it("ignores non-.json files in the inbox directory", async () => {
    const tmp = withTmpRondel();
    await ensureInboxDir(tmp.stateDir);
    await writeFile(join(tmp.stateDir, "inboxes", "README.md"), "not json");
    await appendToInbox(
      tmp.stateDir,
      makeInterAgentMessage({ id: "m1", to: "bob" }),
    );
    const all = await readAllInboxes(tmp.stateDir);
    expect(all.map((m) => m.id)).toEqual(["m1"]);
  });

  it("treats a corrupted JSON inbox file as empty (does not throw)", async () => {
    const tmp = withTmpRondel();
    await mkdir(join(tmp.stateDir, "inboxes"), { recursive: true });
    await writeFile(
      join(tmp.stateDir, "inboxes", "bob.json"),
      "{ this is not valid json",
    );
    // Add a valid entry for a different agent to confirm aggregation still works
    await appendToInbox(
      tmp.stateDir,
      makeInterAgentMessage({ id: "ok", to: "carol" }),
    );
    const all = await readAllInboxes(tmp.stateDir);
    expect(all.map((m) => m.id)).toEqual(["ok"]);
  });
});

describe("inbox — corrupted file quarantine", () => {
  it("renames a corrupted inbox to {file}.corrupted.{ts} on first read", async () => {
    const tmp = withTmpRondel();
    await mkdir(join(tmp.stateDir, "inboxes"), { recursive: true });
    await writeFile(
      join(tmp.stateDir, "inboxes", "bob.json"),
      "{ this is not valid json",
    );

    // Triggering a read quarantines the file.
    await readAllInboxes(tmp.stateDir);

    // The original should be gone, and a sibling matching the quarantine
    // pattern should exist.
    await expect(stat(inboxFor(tmp.stateDir, "bob"))).rejects.toBeDefined();
    const entries = await readdir(join(tmp.stateDir, "inboxes"));
    const quarantined = entries.find((f) =>
      /^bob\.json\.corrupted\..+$/.test(f),
    );
    expect(quarantined).toBeDefined();
  });

  it("quarantines a file whose JSON parses but is not an array", async () => {
    const tmp = withTmpRondel();
    await mkdir(join(tmp.stateDir, "inboxes"), { recursive: true });
    await writeFile(
      join(tmp.stateDir, "inboxes", "bob.json"),
      '{"not":"an array"}',
    );
    await readAllInboxes(tmp.stateDir);
    const entries = await readdir(join(tmp.stateDir, "inboxes"));
    expect(entries.some((f) => /^bob\.json\.corrupted\./.test(f))).toBe(true);
  });

  it("allows a fresh appendToInbox to create a new file after quarantine", async () => {
    const tmp = withTmpRondel();
    await mkdir(join(tmp.stateDir, "inboxes"), { recursive: true });
    await writeFile(
      join(tmp.stateDir, "inboxes", "bob.json"),
      "garbage",
    );

    // First touch quarantines. Next append creates a fresh file with only the
    // new message — no silent data merge.
    await readAllInboxes(tmp.stateDir);
    await appendToInbox(
      tmp.stateDir,
      makeInterAgentMessage({ id: "fresh", to: "bob" }),
    );

    const messages = await readAllInboxes(tmp.stateDir);
    expect(messages.map((m) => m.id)).toEqual(["fresh"]);
  });
});

describe("inbox — concurrent safety", () => {
  // These tests lock the per-file serial lock invariant. Without the lock,
  // Promise.all over appendToInbox would interleave read-modify-write and
  // silently lose messages.

  it("preserves every message when 10 appends race on the same inbox", async () => {
    const tmp = withTmpRondel();
    const ids = Array.from({ length: 10 }, (_, i) => `race_${i}`);
    await Promise.all(
      ids.map((id) =>
        appendToInbox(
          tmp.stateDir,
          makeInterAgentMessage({ id, to: "bob" }),
        ),
      ),
    );
    const all = await readAllInboxes(tmp.stateDir);
    expect(all.map((m) => m.id).sort()).toEqual(ids.slice().sort());
  });

  it("interleaves appends and removes without losing the surviving message", async () => {
    const tmp = withTmpRondel();
    // Append three, then concurrently remove one and append one more.
    await appendToInbox(tmp.stateDir, makeInterAgentMessage({ id: "a", to: "bob" }));
    await appendToInbox(tmp.stateDir, makeInterAgentMessage({ id: "b", to: "bob" }));
    await appendToInbox(tmp.stateDir, makeInterAgentMessage({ id: "c", to: "bob" }));

    await Promise.all([
      removeFromInbox(tmp.stateDir, "bob", "b"),
      appendToInbox(tmp.stateDir, makeInterAgentMessage({ id: "d", to: "bob" })),
    ]);

    const all = await readAllInboxes(tmp.stateDir);
    expect(all.map((m) => m.id).sort()).toEqual(["a", "c", "d"]);
  });

  it("isolates locks across different agents (no cross-agent blocking)", async () => {
    const tmp = withTmpRondel();
    // Two agents, racing appends — each should end up with its own message.
    await Promise.all([
      appendToInbox(
        tmp.stateDir,
        makeInterAgentMessage({ id: "b1", to: "bob" }),
      ),
      appendToInbox(
        tmp.stateDir,
        makeInterAgentMessage({ id: "c1", to: "carol" }),
      ),
    ]);
    const all = await readAllInboxes(tmp.stateDir);
    expect(all.map((m) => m.id).sort()).toEqual(["b1", "c1"]);
  });
});
