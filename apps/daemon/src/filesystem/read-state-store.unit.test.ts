import { describe, it, expect } from "vitest";
import { ReadFileStateStore } from "./read-state-store.js";
import { createHooks } from "../shared/hooks.js";

describe("ReadFileStateStore", () => {
  it("record + get roundtrips the ReadRecord", () => {
    const hooks = createHooks();
    const store = new ReadFileStateStore(hooks);
    store.record("alice", "s1", "/tmp/x", "abc");
    const r = store.get("alice", "s1", "/tmp/x");
    expect(r).toBeDefined();
    expect(r!.contentHash).toBe("abc");
    expect(typeof r!.readAt).toBe("string");
    expect(Number.isNaN(Date.parse(r!.readAt))).toBe(false);
  });

  it("returns undefined for a nonexistent record", () => {
    const hooks = createHooks();
    const store = new ReadFileStateStore(hooks);
    expect(store.get("alice", "s1", "/tmp/x")).toBeUndefined();
  });

  it("different agents with same (session, path) do not collide", () => {
    const hooks = createHooks();
    const store = new ReadFileStateStore(hooks);
    store.record("alice", "s1", "/tmp/x", "hashA");
    store.record("bob", "s1", "/tmp/x", "hashB");
    expect(store.get("alice", "s1", "/tmp/x")!.contentHash).toBe("hashA");
    expect(store.get("bob", "s1", "/tmp/x")!.contentHash).toBe("hashB");
  });

  it("different sessions with same (agent, path) do not collide", () => {
    const hooks = createHooks();
    const store = new ReadFileStateStore(hooks);
    store.record("alice", "s1", "/tmp/x", "hashA");
    store.record("alice", "s2", "/tmp/x", "hashB");
    expect(store.get("alice", "s1", "/tmp/x")!.contentHash).toBe("hashA");
    expect(store.get("alice", "s2", "/tmp/x")!.contentHash).toBe("hashB");
  });

  it("different paths with same (agent, session) do not collide", () => {
    const hooks = createHooks();
    const store = new ReadFileStateStore(hooks);
    store.record("alice", "s1", "/tmp/x", "hashA");
    store.record("alice", "s1", "/tmp/y", "hashB");
    expect(store.get("alice", "s1", "/tmp/x")!.contentHash).toBe("hashA");
    expect(store.get("alice", "s1", "/tmp/y")!.contentHash).toBe("hashB");
  });

  it("invalidateSession drops only matching-prefix records", () => {
    const hooks = createHooks();
    const store = new ReadFileStateStore(hooks);
    store.record("alice", "s1", "/tmp/x", "h1");
    store.record("alice", "s1", "/tmp/y", "h2");
    store.record("alice", "s2", "/tmp/x", "h3");
    store.record("bob", "s1", "/tmp/x", "h4");

    store.invalidateSession("alice", "s1");

    expect(store.get("alice", "s1", "/tmp/x")).toBeUndefined();
    expect(store.get("alice", "s1", "/tmp/y")).toBeUndefined();
    // Other agent's s1 and same agent's s2 remain
    expect(store.get("alice", "s2", "/tmp/x")!.contentHash).toBe("h3");
    expect(store.get("bob", "s1", "/tmp/x")!.contentHash).toBe("h4");
  });

  it("session:crash hook invalidates records for that (agent, sessionId)", () => {
    const hooks = createHooks();
    const store = new ReadFileStateStore(hooks);
    // Touch the store so it subscribes to hooks.
    store.record("alice", "s1", "/tmp/x", "h1");
    store.record("alice", "s2", "/tmp/x", "h2");
    expect(store.size()).toBe(2);

    hooks.emit("session:crash", {
      agentName: "alice",
      channelType: "telegram",
      chatId: "42",
      sessionId: "s1",
    });

    expect(store.get("alice", "s1", "/tmp/x")).toBeUndefined();
    expect(store.get("alice", "s2", "/tmp/x")).toBeDefined();
  });

  it("session:halt hook invalidates records for that (agent, sessionId)", () => {
    const hooks = createHooks();
    const store = new ReadFileStateStore(hooks);
    store.record("alice", "s1", "/tmp/x", "h1");

    hooks.emit("session:halt", {
      agentName: "alice",
      channelType: "telegram",
      chatId: "42",
      sessionId: "s1",
    });

    expect(store.get("alice", "s1", "/tmp/x")).toBeUndefined();
  });

  it("re-recording the same key overwrites prior record", () => {
    const hooks = createHooks();
    const store = new ReadFileStateStore(hooks);
    store.record("alice", "s1", "/tmp/x", "h1");
    const first = store.get("alice", "s1", "/tmp/x")!;
    store.record("alice", "s1", "/tmp/x", "h2");
    const second = store.get("alice", "s1", "/tmp/x")!;
    expect(second.contentHash).toBe("h2");
    // readAt should be a valid ISO timestamp — we don't assert ordering since
    // record() calls within the same millisecond produce identical stamps.
    expect(typeof first.readAt).toBe("string");
    expect(typeof second.readAt).toBe("string");
  });
});
