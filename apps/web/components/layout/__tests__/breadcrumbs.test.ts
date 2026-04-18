/**
 * Unit tests for the TopBar breadcrumb helpers.
 *
 * `breadcrumbs` + `labelFor` are pure path-string transforms. They're
 * the only thing between `usePathname()` and what the user sees in
 * the header — subtle bugs here (missing trailing crumb, wrong href
 * accumulation, missing known label) are immediately visible.
 */

import { describe, expect, it } from "vitest";

import { breadcrumbs, labelFor } from "../breadcrumbs";

describe("breadcrumbs", () => {
  it("returns a single Home crumb for the root path", () => {
    expect(breadcrumbs("/")).toEqual([{ label: "Home", href: "/" }]);
  });

  it("returns a single Home crumb for an empty path", () => {
    // Shouldn't happen in practice (usePathname returns "/"), but
    // the implementation filters empties so this stays safe.
    expect(breadcrumbs("")).toEqual([{ label: "Home", href: "/" }]);
  });

  it("handles a one-segment known path", () => {
    expect(breadcrumbs("/agents")).toEqual([
      { label: "Agents", href: "/agents" },
    ]);
  });

  it("accumulates hrefs for each segment", () => {
    expect(breadcrumbs("/agents/foo")).toEqual([
      { label: "Agents", href: "/agents" },
      { label: "foo", href: "/agents/foo" },
    ]);
  });

  it("keeps dynamic segments (agent name, chat id) as raw text", () => {
    expect(breadcrumbs("/agents/foo/chat/telegram/12345")).toEqual([
      { label: "Agents", href: "/agents" },
      { label: "foo", href: "/agents/foo" },
      { label: "Chat", href: "/agents/foo/chat" },
      { label: "Telegram", href: "/agents/foo/chat/telegram" },
      { label: "12345", href: "/agents/foo/chat/telegram/12345" },
    ]);
  });

  it("handles unknown static segments by falling through to raw", () => {
    expect(breadcrumbs("/does-not-exist")).toEqual([
      { label: "does-not-exist", href: "/does-not-exist" },
    ]);
  });

  it("ignores trailing slashes", () => {
    expect(breadcrumbs("/agents/")).toEqual([
      { label: "Agents", href: "/agents" },
    ]);
  });

  it("ignores duplicate slashes", () => {
    expect(breadcrumbs("/agents//foo")).toEqual([
      { label: "Agents", href: "/agents" },
      { label: "foo", href: "/agents/foo" },
    ]);
  });
});

describe("labelFor", () => {
  it.each([
    ["agents", "Agents"],
    ["approvals", "Approvals"],
    ["chat", "Chat"],
    ["ledger", "Ledger"],
    ["memory", "Memory"],
    ["telegram", "Telegram"],
    ["web", "Web"],
    ["internal", "Internal"],
  ])("maps known segment %s to %s", (segment, label) => {
    expect(labelFor(segment)).toBe(label);
  });

  it("returns the raw segment when not in the known map", () => {
    expect(labelFor("my-agent")).toBe("my-agent");
    expect(labelFor("12345")).toBe("12345");
  });

  it("is case-sensitive", () => {
    // Known labels are lowercase. A caller passing "Agents" must not
    // collide — it isn't a known key, so it falls through.
    expect(labelFor("Agents")).toBe("Agents");
  });
});
