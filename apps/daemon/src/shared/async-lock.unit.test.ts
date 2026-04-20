import { describe, it, expect } from "vitest";
import { AsyncLock } from "./async-lock.js";

/**
 * Resolvable promise helper — lets a test control when a locked operation
 * finishes without resorting to timers.
 */
function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("AsyncLock — serialization", () => {
  it("runs operations on the same key serially in submission order", async () => {
    const lock = new AsyncLock();
    const events: string[] = [];

    const d1 = deferred();
    const d2 = deferred();

    const p1 = lock.withLock("k", async () => {
      events.push("start-1");
      await d1.promise;
      events.push("end-1");
    });
    const p2 = lock.withLock("k", async () => {
      events.push("start-2");
      await d2.promise;
      events.push("end-2");
    });

    // Yield once so withLock had a chance to schedule its chain.
    await Promise.resolve();
    // Second operation must not have started yet — first one still running.
    expect(events).toEqual(["start-1"]);

    d1.resolve();
    await p1;
    expect(events).toEqual(["start-1", "end-1", "start-2"]);

    d2.resolve();
    await p2;
    expect(events).toEqual(["start-1", "end-1", "start-2", "end-2"]);
  });

  it("runs operations on distinct keys concurrently", async () => {
    const lock = new AsyncLock();
    const events: string[] = [];

    const dA = deferred();
    const dB = deferred();

    const pA = lock.withLock("a", async () => {
      events.push("start-a");
      await dA.promise;
      events.push("end-a");
    });
    const pB = lock.withLock("b", async () => {
      events.push("start-b");
      await dB.promise;
      events.push("end-b");
    });

    await Promise.resolve();
    // Both should have started — different keys don't block each other.
    expect(events).toEqual(["start-a", "start-b"]);

    dB.resolve();
    await pB;
    dA.resolve();
    await pA;
  });
});

describe("AsyncLock — error handling", () => {
  it("does not deadlock subsequent work after a rejection on the same key", async () => {
    const lock = new AsyncLock();

    const failing = lock.withLock("k", async () => {
      throw new Error("boom");
    });
    await expect(failing).rejects.toThrow("boom");

    const succeeding = lock.withLock("k", async () => "ok");
    await expect(succeeding).resolves.toBe("ok");
  });

  it("does not leak a prior rejection into the next caller", async () => {
    const lock = new AsyncLock();

    // Fire-and-forget a rejection on key "k" without awaiting.
    lock.withLock("k", async () => {
      throw new Error("prior-failure");
    }).catch(() => {}); // caller swallows its own error

    // Next caller on the same key must see only its own outcome.
    const result = await lock.withLock("k", async () => 42);
    expect(result).toBe(42);
  });

  it("preserves serialization even when the in-flight operation rejects", async () => {
    const lock = new AsyncLock();
    const events: string[] = [];

    const d1 = deferred();
    const p1 = lock.withLock("k", async () => {
      events.push("start-1");
      await d1.promise;
      events.push("reject-1");
      throw new Error("first-failed");
    });
    const p2 = lock.withLock("k", async () => {
      events.push("start-2");
      return "second-ok";
    });

    await Promise.resolve();
    // Second has not started — it must wait for the first to settle.
    expect(events).toEqual(["start-1"]);

    d1.resolve();
    await expect(p1).rejects.toThrow("first-failed");
    await expect(p2).resolves.toBe("second-ok");
    expect(events).toEqual(["start-1", "reject-1", "start-2"]);
  });
});
