import { describe, expect, it } from "vitest";
import { buildIdentity } from "../../sections/identity.js";

describe("buildIdentity", () => {
  it("returns the Rondel framework identity line verbatim", () => {
    expect(buildIdentity()).toBe("You are a personal assistant running inside Rondel.");
  });
});
