import { describe, it, expect } from "vitest";
import {
  contentHash,
  resolveBridgeContext,
  resolveFilesystemContext,
  validateAbsolutePath,
} from "./_common.js";

describe("contentHash", () => {
  it("returns a 64-char lowercase hex digest", () => {
    const h = contentHash("hello");
    expect(h).toMatch(/^[a-f0-9]{64}$/);
  });

  it("is deterministic", () => {
    expect(contentHash("abc")).toBe(contentHash("abc"));
  });

  it("differs for different inputs", () => {
    expect(contentHash("a")).not.toBe(contentHash("b"));
  });

  it("hashes empty content deterministically (sha256 of empty string)", () => {
    expect(contentHash("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
});

describe("validateAbsolutePath", () => {
  it("accepts a simple absolute path", () => {
    const r = validateAbsolutePath("/tmp/x");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.path).toBe("/tmp/x");
  });

  it("rejects empty string", () => {
    const r = validateAbsolutePath("");
    expect(r.ok).toBe(false);
  });

  it("rejects non-string", () => {
    expect(validateAbsolutePath(undefined).ok).toBe(false);
    expect(validateAbsolutePath(42).ok).toBe(false);
    expect(validateAbsolutePath({}).ok).toBe(false);
    expect(validateAbsolutePath(null).ok).toBe(false);
  });

  it("rejects relative paths", () => {
    const r = validateAbsolutePath("relative/path");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/absolute/i);
  });

  it("rejects bare filename", () => {
    const r = validateAbsolutePath("foo.txt");
    expect(r.ok).toBe(false);
  });

  it("rejects UNC paths", () => {
    const r = validateAbsolutePath("\\\\server\\share\\file");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/UNC/i);
  });

  it("rejects //-prefixed UNC-like paths", () => {
    const r = validateAbsolutePath("//server/share/file");
    expect(r.ok).toBe(false);
  });

  it("rejects null-byte injection", () => {
    const r = validateAbsolutePath("/tmp/foo\0bar");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/null/i);
  });
});

describe("resolveBridgeContext", () => {
  it("returns undefined when RONDEL_BRIDGE_URL is missing", () => {
    expect(
      resolveBridgeContext({
        RONDEL_PARENT_AGENT: "bot1",
        RONDEL_PARENT_CHAT_ID: "123",
      }),
    ).toBeUndefined();
  });

  it("returns undefined when RONDEL_PARENT_AGENT is missing", () => {
    expect(
      resolveBridgeContext({
        RONDEL_BRIDGE_URL: "http://127.0.0.1:0",
        RONDEL_PARENT_CHAT_ID: "123",
      }),
    ).toBeUndefined();
  });

  it("returns undefined when RONDEL_PARENT_CHAT_ID is missing", () => {
    expect(
      resolveBridgeContext({
        RONDEL_BRIDGE_URL: "http://127.0.0.1:0",
        RONDEL_PARENT_AGENT: "bot1",
      }),
    ).toBeUndefined();
  });

  it("defaults channelType to 'internal'", () => {
    const ctx = resolveBridgeContext({
      RONDEL_BRIDGE_URL: "http://127.0.0.1:0",
      RONDEL_PARENT_AGENT: "bot1",
      RONDEL_PARENT_CHAT_ID: "c",
    });
    expect(ctx?.channelType).toBe("internal");
  });

  it("populates sessionId when present", () => {
    const ctx = resolveBridgeContext({
      RONDEL_BRIDGE_URL: "http://127.0.0.1:0",
      RONDEL_PARENT_AGENT: "a",
      RONDEL_PARENT_CHAT_ID: "c",
      RONDEL_PARENT_SESSION_ID: "sess-1",
    });
    expect(ctx?.sessionId).toBe("sess-1");
  });

  it("defaults sessionId to empty string when unset", () => {
    const ctx = resolveBridgeContext({
      RONDEL_BRIDGE_URL: "http://127.0.0.1:0",
      RONDEL_PARENT_AGENT: "a",
      RONDEL_PARENT_CHAT_ID: "c",
    });
    expect(ctx?.sessionId).toBe("");
  });
});

describe("resolveFilesystemContext", () => {
  it("errors clearly when base env is missing", () => {
    const r = resolveFilesystemContext({});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Missing RONDEL_BRIDGE_URL/);
  });

  it("errors clearly when sessionId is missing", () => {
    const r = resolveFilesystemContext({
      RONDEL_BRIDGE_URL: "http://127.0.0.1:0",
      RONDEL_PARENT_AGENT: "a",
      RONDEL_PARENT_CHAT_ID: "c",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/SESSION_ID/);
  });

  it("returns ctx when all vars are present", () => {
    const r = resolveFilesystemContext({
      RONDEL_BRIDGE_URL: "http://127.0.0.1:0",
      RONDEL_PARENT_AGENT: "a",
      RONDEL_PARENT_CHAT_ID: "c",
      RONDEL_PARENT_SESSION_ID: "s1",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.ctx.agent).toBe("a");
      expect(r.ctx.sessionId).toBe("s1");
    }
  });
});
