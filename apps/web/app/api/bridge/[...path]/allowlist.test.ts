/**
 * Pre-PR regression test for the bridge proxy allowlists.
 *
 * Locks in two security-relevant invariants without spinning up Next:
 *   1. The pre-v17 per-topic SSE paths (`/approvals/tail`, etc.) are
 *      gone — neither the GET allowlist nor the SSE allowlist matches
 *      them. A regression here would re-expose endpoints the daemon no
 *      longer serves and silently 404 every navigation.
 *   2. The new `/events/tail` path is the only addition to the SSE
 *      allowlist; per-conversation tail still matches; admin endpoints
 *      stay OFF.
 *
 * If you intentionally add or remove an allowlist entry, this test
 * needs to be updated in the same commit. That's the discipline.
 */

import { describe, expect, it } from "vitest";

import {
  GET_ALLOWLIST,
  POST_ALLOWLIST,
  SSE_ALLOWLIST,
  matchesAllowlist,
} from "./allowlist";

describe("bridge proxy SSE_ALLOWLIST", () => {
  it("matches the multiplex endpoint and per-conversation tail", () => {
    expect(matchesAllowlist("/events/tail", SSE_ALLOWLIST)).toBe(true);
    expect(
      matchesAllowlist(
        "/conversations/alice/web/web-main/tail",
        SSE_ALLOWLIST,
      ),
    ).toBe(true);
  });

  it.each([
    "/approvals/tail",
    "/agents/state/tail",
    "/tasks/tail",
    "/schedules/tail",
    "/heartbeats/tail",
    "/ledger/tail",
    "/ledger/tail/alice",
  ])("does NOT match removed pre-v17 path %s", (path) => {
    expect(matchesAllowlist(path, SSE_ALLOWLIST)).toBe(false);
  });

  it("does NOT match admin or unknown paths", () => {
    expect(matchesAllowlist("/admin/agents", SSE_ALLOWLIST)).toBe(false);
    expect(matchesAllowlist("/admin/env", SSE_ALLOWLIST)).toBe(false);
    expect(matchesAllowlist("/events/tail/extra", SSE_ALLOWLIST)).toBe(false);
  });

  it("contains exactly the two expected entries (defense against accidental additions)", () => {
    // Quantity is the cheapest way to catch "someone added a third SSE
    // route without thinking through the per-origin connection cap
    // implications".
    expect(SSE_ALLOWLIST).toHaveLength(2);
  });
});

describe("bridge proxy GET_ALLOWLIST", () => {
  it("matches the read endpoints the dashboard needs", () => {
    expect(matchesAllowlist("/version", GET_ALLOWLIST)).toBe(true);
    expect(matchesAllowlist("/agents", GET_ALLOWLIST)).toBe(true);
    expect(matchesAllowlist("/ledger/query", GET_ALLOWLIST)).toBe(true);
    expect(matchesAllowlist("/conversations/alice", GET_ALLOWLIST)).toBe(true);
    expect(
      matchesAllowlist(
        "/conversations/alice/web/web-main/history",
        GET_ALLOWLIST,
      ),
    ).toBe(true);
    expect(matchesAllowlist("/memory/alice", GET_ALLOWLIST)).toBe(true);
  });

  it("does NOT match admin endpoints — the proxy must never expose them", () => {
    // The daemon trusts loopback and has no per-endpoint auth; the
    // proxy's allowlist IS the access control for the browser surface.
    expect(matchesAllowlist("/admin/agents", GET_ALLOWLIST)).toBe(false);
    expect(matchesAllowlist("/admin/env", GET_ALLOWLIST)).toBe(false);
    expect(matchesAllowlist("/admin/status", GET_ALLOWLIST)).toBe(false);
  });

  it("does NOT match arbitrary path-traversal-shaped paths", () => {
    // Anchoring of the regex entries — without `^…$` an attacker could
    // smuggle e.g. `/memory/alice/admin/env` past the gate. These checks
    // exercise that the existing patterns are properly anchored.
    expect(matchesAllowlist("/memory/alice/extra", GET_ALLOWLIST)).toBe(false);
    expect(matchesAllowlist("/conversations/x/y/z/admin", GET_ALLOWLIST))
      .toBe(false);
  });
});

describe("bridge proxy POST_ALLOWLIST", () => {
  it("matches only /web/messages/send", () => {
    expect(matchesAllowlist("/web/messages/send", POST_ALLOWLIST)).toBe(true);
    expect(POST_ALLOWLIST).toHaveLength(1);
  });

  it("does NOT match other POST-shaped paths", () => {
    expect(matchesAllowlist("/admin/env", POST_ALLOWLIST)).toBe(false);
    expect(matchesAllowlist("/approvals/foo/resolve", POST_ALLOWLIST)).toBe(false);
  });
});
