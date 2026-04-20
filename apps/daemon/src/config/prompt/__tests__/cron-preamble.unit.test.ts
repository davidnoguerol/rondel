import { describe, expect, it } from "vitest";
import type { CronJob } from "../../../shared/types/index.js";
import { buildCronPreamble, resolveDelivery, type ResolvedDelivery } from "../cron-preamble.js";

function makeJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: "test-job",
    name: "test",
    schedule: { kind: "every", interval: "1h" },
    prompt: "do something",
    ...overrides,
  };
}

describe("resolveDelivery", () => {
  it("returns null when delivery is undefined", () => {
    expect(resolveDelivery(undefined, () => undefined)).toBeNull();
  });

  it("returns null when delivery mode is 'none'", () => {
    expect(resolveDelivery({ mode: "none" }, () => undefined)).toBeNull();
  });

  it("returns the delivery tuple when fully specified", () => {
    const resolved = resolveDelivery(
      { mode: "announce", channelType: "telegram", accountId: "kai", chatId: "42" },
      () => undefined,
    );
    expect(resolved).toEqual({ channelType: "telegram", accountId: "kai", chatId: "42" });
  });

  it("fills missing channelType/accountId from the primary fallback", () => {
    const resolved = resolveDelivery(
      { mode: "announce", chatId: "42" } as unknown as Parameters<typeof resolveDelivery>[0],
      () => ({ channelType: "telegram", accountId: "kai" }),
    );
    expect(resolved).toEqual({ channelType: "telegram", accountId: "kai", chatId: "42" });
  });

  it("returns null when delivery is partial and the primary fallback is also absent", () => {
    const resolved = resolveDelivery(
      { mode: "announce", chatId: "42" } as unknown as Parameters<typeof resolveDelivery>[0],
      () => undefined,
    );
    expect(resolved).toBeNull();
  });
});

describe("buildCronPreamble", () => {
  const delivery: ResolvedDelivery = {
    channelType: "telegram",
    accountId: "kai",
    chatId: "42",
  };

  it("emits the auto-delivery variant when delivery is non-null", () => {
    const text = buildCronPreamble(makeJob({ name: "daily summary" }), delivery);
    expect(text).toContain("# Scheduled task context");
    expect(text).toContain("scheduler");
    expect(text).toContain("AUTOMATICALLY deliver your final response text");
    expect(text).toContain("Auto-delivery target: telegram / account `kai` / chat `42`");
    expect(text).toContain('Schedule: "daily summary" (test-job)');
  });

  it("emits the no-delivery variant when delivery is null", () => {
    const text = buildCronPreamble(makeJob(), null);
    expect(text).toContain("NO automatic delivery");
    expect(text).toContain("ledger but is NOT forwarded");
    expect(text).toContain("Auto-delivery target: none (output captured to ledger only)");
  });

  it("includes Registered by line when owner is set", () => {
    const text = buildCronPreamble(makeJob({ owner: "alice" }), null);
    expect(text).toContain("- Registered by: alice");
  });

  it("omits the Registered by line when owner is absent", () => {
    const text = buildCronPreamble(makeJob(), null);
    expect(text).not.toContain("Registered by:");
  });
});
