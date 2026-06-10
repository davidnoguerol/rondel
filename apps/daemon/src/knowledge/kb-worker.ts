// Worker entrypoint — runs full index rebuilds off the daemon's event loop.
// SQLite writes are synchronous INSIDE the worker; the main thread only ever
// opens read connections (WAL keeps readers unblocked during a rebuild).
//
// Jobs are processed strictly serially via an internal promise chain —
// parentPort message handlers don't await each other, so the chain is the
// ordering guarantee.

import { parentPort } from "node:worker_threads";
import { runRebuild, type RebuildJob, type RebuildStats } from "./kb-rebuild.js";

export interface KbWorkerInMsg {
  readonly type: "rebuild";
  readonly jobId: number;
  readonly job: RebuildJob;
}

export type KbWorkerOutMsg =
  | { readonly type: "rebuilt"; readonly jobId: number; readonly stats: RebuildStats }
  | { readonly type: "rebuild_failed"; readonly jobId: number; readonly error: string };

if (parentPort) {
  const port = parentPort;
  let chain: Promise<void> = Promise.resolve();
  port.on("message", (msg: KbWorkerInMsg) => {
    if (msg?.type !== "rebuild") return;
    chain = chain.then(async () => {
      try {
        const stats = await runRebuild(msg.job);
        port.postMessage({ type: "rebuilt", jobId: msg.jobId, stats } satisfies KbWorkerOutMsg);
      } catch (err) {
        port.postMessage({
          type: "rebuild_failed",
          jobId: msg.jobId,
          error: err instanceof Error ? err.message : String(err),
        } satisfies KbWorkerOutMsg);
      }
    });
  });
}
