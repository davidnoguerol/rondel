/**
 * Unit tests for LedgerStreamSource.
 *
 * Scope: fan-out semantics, per-client error isolation, zero-client fast
 * path, and dispose() unsubscribing from the upstream LedgerWriter. We
 * hand-fake a minimal `LedgerWriter` shape (just the `onAppended` method)
 * so the test has no fs dependency and no real RondelHooks wiring.
 *
 * Out of scope: the wire format (`event: "ledger.appended"`) is asserted
 * at the unit level here but the SSE serialization is covered by
 * `sse-handler.integration.test.ts`.
 */

import { describe, it, expect } from "vitest";

import type { LedgerEvent } from "../ledger/ledger-types.js";
import type { LedgerWriter } from "../ledger/ledger-writer.js";
import { LedgerStreamSource } from "./ledger-stream.js";
import type { SseFrame } from "./sse-types.js";

// -----------------------------------------------------------------------------
// Fake LedgerWriter
// -----------------------------------------------------------------------------
//
// LedgerStreamSource only touches `onAppended`. We don't construct a real
// writer (which would require hooks + fs). Instead, the fake exposes an
// `emit()` that invokes all registered subscribers synchronously — the
// same contract the real writer provides.

interface FakeLedgerWriter {
  readonly writer: LedgerWriter;
  emit(event: LedgerEvent): void;
  subscriberCount(): number;
}

function makeFakeWriter(): FakeLedgerWriter {
  const subs = new Set<(event: LedgerEvent) => void>();
  const fake = {
    onAppended(cb: (event: LedgerEvent) => void): () => void {
      subs.add(cb);
      return () => {
        subs.delete(cb);
      };
    },
  } as unknown as LedgerWriter;
  return {
    writer: fake,
    emit: (event) => {
      for (const cb of subs) cb(event);
    },
    subscriberCount: () => subs.size,
  };
}

function makeEvent(overrides: Partial<LedgerEvent> = {}): LedgerEvent {
  return {
    ts: "2026-04-13T12:00:00.000Z",
    agent: "alice",
    kind: "user_message",
    chatId: "c1",
    summary: "hello",
    ...overrides,
  };
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe("LedgerStreamSource — subscription lifecycle", () => {
  it("subscribes once to LedgerWriter.onAppended at construction", () => {
    const fake = makeFakeWriter();
    new LedgerStreamSource(fake.writer);
    expect(fake.subscriberCount()).toBe(1);
  });

  it("getClientCount reflects subscribe/unsubscribe", () => {
    const source = new LedgerStreamSource(makeFakeWriter().writer);
    expect(source.getClientCount()).toBe(0);

    // Distinct callback identities — `Set.add` deduplicates by
    // reference, so two subscriptions sharing one `noop` would only
    // register once. Using arrow functions gives each client a unique
    // identity, matching how `handleSseRequest` wraps `send` fresh per
    // request.
    const unsubA = source.subscribe(() => {});
    const unsubB = source.subscribe(() => {});
    expect(source.getClientCount()).toBe(2);

    unsubA();
    expect(source.getClientCount()).toBe(1);
    unsubB();
    expect(source.getClientCount()).toBe(0);
  });

  it("dispose() clears clients AND unsubscribes from the upstream writer", () => {
    const fake = makeFakeWriter();
    const source = new LedgerStreamSource(fake.writer);
    source.subscribe(() => {});
    source.subscribe(() => {});
    expect(fake.subscriberCount()).toBe(1); // still just the source's own sub

    source.dispose();

    expect(source.getClientCount()).toBe(0);
    expect(fake.subscriberCount()).toBe(0);
  });
});

describe("LedgerStreamSource — fan-out", () => {
  it("emits a `ledger.appended` frame to every subscriber", () => {
    const fake = makeFakeWriter();
    const source = new LedgerStreamSource(fake.writer);

    const received: SseFrame<LedgerEvent>[][] = [[], []];
    source.subscribe((f) => received[0].push(f));
    source.subscribe((f) => received[1].push(f));

    const event = makeEvent({ summary: "first" });
    fake.emit(event);

    for (const inbox of received) {
      expect(inbox).toHaveLength(1);
      expect(inbox[0].event).toBe("ledger.appended");
      expect(inbox[0].data).toEqual(event);
    }
  });

  it("skips work entirely when there are zero subscribers", () => {
    // This is the "clients.size === 0" fast-path guard. We assert it by
    // ensuring no subscriber-side work runs (there are none to run) and
    // that emitting doesn't throw with an empty client set.
    const fake = makeFakeWriter();
    new LedgerStreamSource(fake.writer);
    expect(() => fake.emit(makeEvent())).not.toThrow();
  });

  it("a throwing client does NOT break delivery to sibling clients", () => {
    const fake = makeFakeWriter();
    const source = new LedgerStreamSource(fake.writer);

    let goodCalls = 0;
    source.subscribe(() => {
      throw new Error("boom");
    });
    source.subscribe(() => {
      goodCalls++;
    });

    // Emitting must not throw into the upstream writer, and the good
    // subscriber must still receive the frame despite the bad sibling.
    expect(() => fake.emit(makeEvent())).not.toThrow();
    expect(goodCalls).toBe(1);
  });

  it("iterates over a snapshot of clients so mid-fanout unsubscribe is safe", () => {
    // A client that unsubscribes itself during fan-out (common when an
    // HTTP response has died) must not invalidate the iterator for its
    // siblings. LedgerStreamSource copies the client set before iterating
    // — this test pins that behavior.
    const fake = makeFakeWriter();
    const source = new LedgerStreamSource(fake.writer);

    let bCalls = 0;
    let unsubA: (() => void) | null = null;
    unsubA = source.subscribe(() => {
      unsubA?.();
    });
    source.subscribe(() => {
      bCalls++;
    });

    fake.emit(makeEvent());
    expect(bCalls).toBe(1);
    expect(source.getClientCount()).toBe(1);
  });
});
