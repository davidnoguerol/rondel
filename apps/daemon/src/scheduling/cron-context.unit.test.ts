import { describe, it, expect } from "vitest";
import { buildCronContextPrompt, resolveDelivery, type ResolvedDelivery } from "./cron-context.js";
import type { CronJob } from "../shared/types/index.js";

function makeJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: "sched_1776500000_abcdef12",
    name: "wake-up ping",
    schedule: { kind: "at", at: "2026-04-19T08:00:00Z" },
    prompt: "Wish the user good morning.",
    ...overrides,
  };
}

describe("resolveDelivery", () => {
  it("returns null when delivery is undefined", () => {
    expect(resolveDelivery(undefined, () => undefined)).toBeNull();
  });

  it('returns null when delivery.mode is "none"', () => {
    expect(resolveDelivery({ mode: "none" }, () => undefined)).toBeNull();
  });

  it("returns the full target when all three fields are explicit", () => {
    const out = resolveDelivery(
      { mode: "announce", chatId: "c1", channelType: "telegram", accountId: "bot1" },
      () => {
        throw new Error("should not consult fallback when full spec given");
      },
    );
    expect(out).toEqual({ channelType: "telegram", accountId: "bot1", chatId: "c1" });
  });

  it("fills missing channelType + accountId from the primary-channel fallback", () => {
    const out = resolveDelivery(
      { mode: "announce", chatId: "c1" },
      () => ({ channelType: "telegram", accountId: "bot1" }),
    );
    expect(out).toEqual({ channelType: "telegram", accountId: "bot1", chatId: "c1" });
  });

  it("returns null when the spec is partial AND no primary-channel fallback exists", () => {
    const out = resolveDelivery({ mode: "announce", chatId: "c1" }, () => undefined);
    expect(out).toBeNull();
  });

  it("keeps the explicit channelType when only accountId is missing", () => {
    const out = resolveDelivery(
      { mode: "announce", chatId: "c1", channelType: "slack" },
      () => ({ channelType: "telegram", accountId: "bot1" }),
    );
    expect(out).toEqual({ channelType: "slack", accountId: "bot1", chatId: "c1" });
  });
});

describe("buildCronContextPrompt — auto-delivery variant", () => {
  const delivery: ResolvedDelivery = {
    channelType: "telegram",
    accountId: "bot1",
    chatId: "5948773741",
  };

  it("includes the schedule id, name, and owner when present", () => {
    const block = buildCronContextPrompt(makeJob({ owner: "bot1" }), delivery);
    expect(block).toContain('"wake-up ping"');
    expect(block).toContain("sched_1776500000_abcdef12");
    expect(block).toContain("Registered by: bot1");
  });

  it("omits the owner line when the job has no owner", () => {
    const block = buildCronContextPrompt(makeJob(), delivery);
    expect(block).not.toContain("Registered by:");
  });

  it("explicitly forbids calling send tools for the auto-delivered response", () => {
    const block = buildCronContextPrompt(makeJob(), delivery);
    // The whole point of this branch: prevent the double-send bug.
    expect(block).toContain("do NOT");
    expect(block).toContain("rondel_send_telegram");
    expect(block).toContain("duplicate");
  });

  it("names the exact delivery target so the LLM sees where its text is going", () => {
    const block = buildCronContextPrompt(makeJob(), delivery);
    expect(block).toContain("telegram");
    expect(block).toContain("bot1");
    expect(block).toContain("5948773741");
  });
});

describe("buildCronContextPrompt — no-delivery variant", () => {
  it("tells the subagent its response is captured but NOT forwarded", () => {
    const block = buildCronContextPrompt(makeJob(), null);
    expect(block).toContain("NO automatic delivery");
    expect(block).toContain("ledger");
  });

  it("points at channel tools as the explicit path for user-facing messages", () => {
    const block = buildCronContextPrompt(makeJob(), null);
    expect(block).toContain("rondel_send_telegram");
    expect(block).toContain("explicitly");
  });

  it("does NOT include the forbidden-double-send language (no channel to double-send to)", () => {
    const block = buildCronContextPrompt(makeJob(), null);
    expect(block).not.toMatch(/do NOT call.*duplicate/);
  });
});
