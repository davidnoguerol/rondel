import { describe, it, expect } from "vitest";
import { KbQueryRequestSchema, KbIngestRequestSchema, KbDeleteRequestSchema } from "./schemas.js";

const CALLER = { agentName: "kai", channelType: "telegram", chatId: "42" };

describe("KbQueryRequestSchema", () => {
  it("accepts a discovery query and clamps via validation", () => {
    expect(KbQueryRequestSchema.safeParse({ caller: CALLER, args: { query: "lisbon" } }).success).toBe(true);
    expect(KbQueryRequestSchema.safeParse({ caller: CALLER, args: { limit: 11 } }).success).toBe(false);
    expect(KbQueryRequestSchema.safeParse({ caller: CALLER, args: { collections: ["bogus"] } }).success).toBe(false);
  });

  it("defaults isAdmin to false on the caller", () => {
    const parsed = KbQueryRequestSchema.safeParse({ caller: CALLER, args: {} });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.caller.isAdmin).toBe(false);
  });
});

describe("KbIngestRequestSchema", () => {
  it("requires exactly one of content | sourcePath", () => {
    const base = { caller: CALLER, collection: "agent-private", title: "doc" };
    expect(KbIngestRequestSchema.safeParse({ ...base, content: "x" }).success).toBe(true);
    expect(KbIngestRequestSchema.safeParse({ ...base, sourcePath: "/x.md" }).success).toBe(true);
    expect(KbIngestRequestSchema.safeParse({ ...base }).success).toBe(false);
    expect(KbIngestRequestSchema.safeParse({ ...base, content: "x", sourcePath: "/x.md" }).success).toBe(false);
  });

  it("rejects sessions/memory as ingest targets", () => {
    expect(KbIngestRequestSchema.safeParse({ caller: CALLER, collection: "sessions", title: "x", content: "y" }).success).toBe(false);
  });
});

describe("KbDeleteRequestSchema", () => {
  it("requires a non-empty path", () => {
    expect(KbDeleteRequestSchema.safeParse({ caller: CALLER, collection: "org-shared", path: "" }).success).toBe(false);
    expect(KbDeleteRequestSchema.safeParse({ caller: CALLER, collection: "org-shared", path: "doc.md" }).success).toBe(true);
  });
});
