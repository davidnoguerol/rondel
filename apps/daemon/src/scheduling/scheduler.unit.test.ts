import { describe, it, expect } from "vitest";
import { parseInterval, getBackoffDelay } from "./scheduler.js";

describe("parseInterval (valid inputs)", () => {
  it.each([
    ["30s", 30_000],
    ["5m", 5 * 60_000],
    ["1h", 60 * 60_000],
    ["24h", 24 * 60 * 60_000],
    ["2h30m", 2 * 60 * 60_000 + 30 * 60_000],
    ["1d2h3m4s", 86_400_000 + 2 * 3_600_000 + 3 * 60_000 + 4_000],
  ] as const)("parses %s → %d ms", (input, expected) => {
    expect(parseInterval(input)).toBe(expected);
  });
});

describe("parseInterval (invalid inputs)", () => {
  it("throws on empty string", () => {
    expect(() => parseInterval("")).toThrow();
  });

  it("throws when the total is zero", () => {
    expect(() => parseInterval("0s")).toThrow(/greater than zero/);
  });

  it("throws on unknown unit", () => {
    expect(() => parseInterval("5x")).toThrow();
  });

  it("throws on spaces in the interval", () => {
    expect(() => parseInterval("5 m")).toThrow();
  });

  it("throws on uppercase units (contract: lowercase only)", () => {
    expect(() => parseInterval("5M")).toThrow();
  });

  it("throws on out-of-order units (contract: d→h→m→s)", () => {
    expect(() => parseInterval("3m2h")).toThrow();
  });
});

describe("getBackoffDelay", () => {
  it("uses the documented schedule [30s, 1m, 5m, 15m, 60m]", () => {
    expect(getBackoffDelay(1)).toBe(30_000);
    expect(getBackoffDelay(2)).toBe(60_000);
    expect(getBackoffDelay(3)).toBe(300_000);
    expect(getBackoffDelay(4)).toBe(900_000);
    expect(getBackoffDelay(5)).toBe(3_600_000);
  });

  it("clamps at the final delay for 6+ consecutive errors", () => {
    expect(getBackoffDelay(6)).toBe(3_600_000);
    expect(getBackoffDelay(100)).toBe(3_600_000);
  });

});
