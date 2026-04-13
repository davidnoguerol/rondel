/**
 * Integration tests for handleSseRequest.
 *
 * Scope: end-to-end wire format, subscribe-before-replay ordering, the
 * per-client filter, the no-`event:`-line regression guard, and cleanup
 * on client disconnect. This is the only test tier that exercises the
 * actual SSE serialization — the unit tests for stream sources stay
 * protocol-agnostic.
 *
 * We build a real `http.Server` bound to a random port and consume the
 * response body as a raw UTF-8 stream. The source is a hand-rolled
 * `StreamSource<T>` with explicit controls for emitting deltas and
 * signaling snapshot/replay completion — this gives us a deterministic
 * way to drive the race the handler exists to prevent.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

import { handleSseRequest } from "./sse-handler.js";
import type { SseFrame, StreamSource } from "./sse-types.js";

// -----------------------------------------------------------------------------
// Test-controlled StreamSource
// -----------------------------------------------------------------------------

interface Payload {
  readonly id: number;
  readonly label: string;
}

interface ControlledSource extends StreamSource<Payload> {
  /** Synchronously deliver a frame to every subscribed client. */
  emit(frame: SseFrame<Payload>): void;
  /** Override the snapshot returned on the next handler invocation. */
  setSnapshot(frame: SseFrame<Payload> | undefined): void;
  /** Count of currently-subscribed clients. */
  readonly clients: Set<(frame: SseFrame<Payload>) => void>;
}

function makeSource(): ControlledSource {
  const clients = new Set<(frame: SseFrame<Payload>) => void>();
  let snapshotFrame: SseFrame<Payload> | undefined;

  return {
    clients,
    subscribe(send) {
      clients.add(send);
      return () => {
        clients.delete(send);
      };
    },
    snapshot() {
      return snapshotFrame;
    },
    setSnapshot(frame) {
      snapshotFrame = frame;
    },
    emit(frame) {
      for (const send of [...clients]) {
        try {
          send(frame);
        } catch {
          // isolate per-client errors, matching real sources
        }
      }
    },
    dispose() {
      clients.clear();
    },
    getClientCount() {
      return clients.size;
    },
  };
}

// -----------------------------------------------------------------------------
// HTTP plumbing
// -----------------------------------------------------------------------------

type RouteHandler = (req: IncomingMessage, res: ServerResponse) => void;

interface ServerHandle {
  readonly url: string;
  readonly server: Server;
  setRoute(handler: RouteHandler): void;
  close(): Promise<void>;
}

async function startServer(): Promise<ServerHandle> {
  let route: RouteHandler = (_req, res) => {
    res.writeHead(404);
    res.end();
  };
  const server = createServer((req, res) => route(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return {
    server,
    url: `http://127.0.0.1:${addr.port}`,
    setRoute(handler) {
      route = handler;
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * Open a raw TCP/HTTP connection to the server and return an async
 * iterator over the response body chunks. We don't use `fetch()` here
 * because we need access to the raw bytes as they arrive (not an
 * aggregated string) and we need to close the client socket on demand
 * to exercise the cleanup path.
 */
interface SseClient {
  /** Wait until the body contains a substring. Rejects on timeout. */
  waitForText(needle: string, timeoutMs?: number): Promise<void>;
  /** Full body seen so far. */
  body(): string;
  /** Close the client socket — triggers `req.on("close")` on the server. */
  close(): void;
  /** Promise that resolves when the server closes the connection. */
  ended(): Promise<void>;
}

async function openSseClient(url: string): Promise<SseClient> {
  // We use http.request with a GET verb — fetch in undici is fine but
  // closing the socket deterministically is easier with the classic API.
  const { request } = await import("node:http");
  const u = new URL(url);

  return new Promise<SseClient>((resolve, reject) => {
    const req = request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: "GET",
        headers: { Accept: "text/event-stream" },
      },
      (res) => {
        let body = "";
        let endedResolve: () => void = () => {};
        const endedPromise = new Promise<void>((r) => (endedResolve = r));

        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          body += chunk;
        });
        res.on("end", () => endedResolve());
        res.on("close", () => endedResolve());

        resolve({
          body: () => body,
          waitForText: async (needle, timeoutMs = 2000) => {
            const deadline = Date.now() + timeoutMs;
            while (Date.now() < deadline) {
              if (body.includes(needle)) return;
              await delay(10);
            }
            throw new Error(
              `Timed out waiting for "${needle}". Body so far:\n${body}`,
            );
          },
          close: () => {
            req.destroy();
            res.destroy();
          },
          ended: () => endedPromise,
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe("handleSseRequest — wire format", () => {
  let server: ServerHandle;

  beforeEach(async () => {
    server = await startServer();
  });
  afterEach(async () => {
    await server.close();
  });

  it("never writes an `event:` line (regression guard for EventSource onmessage)", async () => {
    // The file header in sse-handler.ts calls this out: adding an
    // `event:` line breaks generic consumers because it dispatches as a
    // NAMED event and `eventSource.onmessage` does NOT catch it. This
    // test fails loud if a future refactor re-adds the line.
    const source = makeSource();
    source.setSnapshot({
      event: "test.snapshot",
      data: { id: 0, label: "initial" },
    });
    server.setRoute((req, res) => handleSseRequest(req, res, source));

    const client = await openSseClient(server.url);
    await client.waitForText(`"label":"initial"`);

    // Emit a live delta so the body includes a representative slice.
    source.emit({ event: "test.delta", data: { id: 1, label: "delta-1" } });
    await client.waitForText(`"label":"delta-1"`);

    // The discriminator MUST be inside the JSON payload, not on its
    // own line. `event:` at the start of any SSE line would break
    // EventSource.onmessage dispatch.
    const body = client.body();
    for (const line of body.split("\n")) {
      expect(line.startsWith("event:")).toBe(false);
    }

    client.close();
  });

  it("writes the `retry: 3000` directive once at the top", async () => {
    const source = makeSource();
    server.setRoute((req, res) => handleSseRequest(req, res, source));
    const client = await openSseClient(server.url);

    source.emit({ event: "t", data: { id: 1, label: "ping" } });
    await client.waitForText(`"label":"ping"`);

    const body = client.body();
    expect(body).toMatch(/^retry: 3000\n\n/);
    // Exactly one retry directive — if two appeared, it would mean
    // handleSseRequest ran twice for the same client.
    expect(body.match(/retry: 3000/g)).toHaveLength(1);

    client.close();
  });
});

describe("handleSseRequest — subscribe-before-replay ordering", () => {
  let server: ServerHandle;

  beforeEach(async () => {
    server = await startServer();
  });
  afterEach(async () => {
    await server.close();
  });

  it("delta emitted during the replay phase is delivered AFTER the replay frames", async () => {
    // This is the core race fix `handleSseRequest` exists to close:
    //
    //   1. subscribe to source (captures live frames into a buffer)
    //   2. run replay (writes historical frames directly)
    //   3. during step 2, a live delta arrives → it MUST be buffered
    //   4. after replay finishes, the buffered delta is flushed
    //
    // We drive this deterministically by making the replay callback
    // await a promise that we resolve AFTER we've emitted a live delta.
    const source = makeSource();

    let releaseReplay: () => void = () => {};
    const replayGate = new Promise<void>((r) => (releaseReplay = r));

    server.setRoute((req, res) =>
      handleSseRequest(req, res, source, {
        async replay(send) {
          send({ event: "replay.1", data: { id: 100, label: "historical-A" } });
          send({ event: "replay.2", data: { id: 101, label: "historical-B" } });
          // Pause replay so a live delta has time to land in the buffer.
          await replayGate;
          send({ event: "replay.3", data: { id: 102, label: "historical-C" } });
        },
      }),
    );

    const client = await openSseClient(server.url);
    // Wait for the first two replay frames to confirm the handler is
    // in the replay phase with a buffered live-send.
    await client.waitForText(`"label":"historical-B"`);

    // Emit a live delta while replay is still paused — this MUST be
    // queued, not written immediately.
    source.emit({ event: "t.delta", data: { id: 200, label: "live-during-replay" } });

    // Give the event loop a tick so any (incorrect) direct write would
    // race ahead of the next replay frame. Then let replay finish.
    await delay(20);
    releaseReplay();

    await client.waitForText(`"label":"live-during-replay"`);

    // Assert ordering by index in the body string.
    const body = client.body();
    const iA = body.indexOf(`"label":"historical-A"`);
    const iB = body.indexOf(`"label":"historical-B"`);
    const iC = body.indexOf(`"label":"historical-C"`);
    const iLive = body.indexOf(`"label":"live-during-replay"`);
    expect(iA).toBeGreaterThan(-1);
    expect(iB).toBeGreaterThan(iA);
    expect(iC).toBeGreaterThan(iB);
    // Live delta MUST come after ALL replay frames — this is the
    // invariant the buffer-flush-then-switch dance guarantees.
    expect(iLive).toBeGreaterThan(iC);

    client.close();
  });

  it("snapshot frame precedes any replay frames and any buffered deltas", async () => {
    const source = makeSource();
    source.setSnapshot({ event: "s", data: { id: 0, label: "snap-0" } });

    let releaseReplay: () => void = () => {};
    const replayGate = new Promise<void>((r) => (releaseReplay = r));

    server.setRoute((req, res) =>
      handleSseRequest(req, res, source, {
        async replay(send) {
          send({ event: "r", data: { id: 1, label: "replay-1" } });
          await replayGate;
        },
      }),
    );

    const client = await openSseClient(server.url);
    await client.waitForText(`"label":"replay-1"`);

    source.emit({ event: "d", data: { id: 2, label: "live-2" } });
    await delay(20);
    releaseReplay();

    await client.waitForText(`"label":"live-2"`);

    const body = client.body();
    const iSnap = body.indexOf(`"label":"snap-0"`);
    const iReplay = body.indexOf(`"label":"replay-1"`);
    const iLive = body.indexOf(`"label":"live-2"`);
    expect(iSnap).toBeGreaterThan(-1);
    // snapshot → replay → buffered live, in that exact order.
    expect(iReplay).toBeGreaterThan(iSnap);
    expect(iLive).toBeGreaterThan(iReplay);

    client.close();
  });
});

describe("handleSseRequest — per-client filter", () => {
  let server: ServerHandle;

  beforeEach(async () => {
    server = await startServer();
  });
  afterEach(async () => {
    await server.close();
  });

  it("filter drops frames for the filtered client but not its siblings", async () => {
    // Two clients share one source. Client A filters for even ids,
    // Client B accepts all. We assert A misses odd-id frames while B
    // sees everything. This verifies the filter is applied at the
    // handler boundary per client, not at the source.
    const source = makeSource();

    server.setRoute((req, res) => {
      const acceptEvenOnly = req.url?.includes("even=1");
      handleSseRequest(req, res, source, {
        filter: acceptEvenOnly ? (p: Payload) => p.id % 2 === 0 : undefined,
      });
    });

    const [clientA, clientB] = await Promise.all([
      openSseClient(`${server.url}/?even=1`),
      openSseClient(server.url),
    ]);

    // Both connections need to be fully through the prefix phase
    // before we emit — otherwise a live delta could race ahead of the
    // subscribe closure for one client and not the other. Give the
    // handlers a beat.
    await delay(30);

    source.emit({ event: "t", data: { id: 1, label: "odd-1" } });
    source.emit({ event: "t", data: { id: 2, label: "even-2" } });
    source.emit({ event: "t", data: { id: 3, label: "odd-3" } });
    source.emit({ event: "t", data: { id: 4, label: "even-4" } });

    await clientB.waitForText(`"label":"even-4"`);
    await clientA.waitForText(`"label":"even-4"`);

    // Client A (filtered): only even labels.
    const bodyA = clientA.body();
    expect(bodyA).not.toContain(`"label":"odd-1"`);
    expect(bodyA).not.toContain(`"label":"odd-3"`);
    expect(bodyA).toContain(`"label":"even-2"`);
    expect(bodyA).toContain(`"label":"even-4"`);

    // Client B (no filter): all four labels.
    const bodyB = clientB.body();
    expect(bodyB).toContain(`"label":"odd-1"`);
    expect(bodyB).toContain(`"label":"even-2"`);
    expect(bodyB).toContain(`"label":"odd-3"`);
    expect(bodyB).toContain(`"label":"even-4"`);

    clientA.close();
    clientB.close();
  });
});

describe("handleSseRequest — cleanup", () => {
  let server: ServerHandle;

  beforeEach(async () => {
    server = await startServer();
  });
  afterEach(async () => {
    await server.close();
  });

  it("client disconnect unsubscribes from the source", async () => {
    const source = makeSource();
    server.setRoute((req, res) => handleSseRequest(req, res, source));

    const client = await openSseClient(server.url);
    // Make sure the handler has reached the live phase before we test
    // the subscription count. Emitting one frame forces a round-trip.
    source.emit({ event: "t", data: { id: 1, label: "ready" } });
    await client.waitForText(`"label":"ready"`);
    expect(source.clients.size).toBe(1);

    client.close();
    // The cleanup path runs via `req.on("close")` on the server. Give
    // it a couple of event-loop ticks to propagate.
    const deadline = Date.now() + 1000;
    while (source.clients.size !== 0 && Date.now() < deadline) {
      await delay(10);
    }
    expect(source.clients.size).toBe(0);
  });

  it("two clients, one disconnects, the other keeps receiving frames", async () => {
    const source = makeSource();
    server.setRoute((req, res) => handleSseRequest(req, res, source));

    const [a, b] = await Promise.all([
      openSseClient(server.url),
      openSseClient(server.url),
    ]);
    source.emit({ event: "t", data: { id: 1, label: "first" } });
    await Promise.all([a.waitForText(`"label":"first"`), b.waitForText(`"label":"first"`)]);
    expect(source.clients.size).toBe(2);

    a.close();
    const deadline = Date.now() + 1000;
    while (source.clients.size !== 1 && Date.now() < deadline) {
      await delay(10);
    }
    expect(source.clients.size).toBe(1);

    source.emit({ event: "t", data: { id: 2, label: "second" } });
    await b.waitForText(`"label":"second"`);
    expect(b.body()).toContain(`"label":"second"`);
    // A's body must NOT have the post-close frame.
    expect(a.body()).not.toContain(`"label":"second"`);

    b.close();
  });
});
