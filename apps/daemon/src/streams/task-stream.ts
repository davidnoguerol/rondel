/**
 * Live task board stream source.
 *
 * Snapshot + delta (same wire shape as `HeartbeatStreamSource`):
 *   - `task.snapshot` — sent once per client at connect; carries every
 *     non-terminal task in scope at that instant.
 *   - `task.delta`    — sent per `task:*` hook emission, with the
 *     triggering event tagged so clients can discriminate visually
 *     (e.g. claimed → green flash, blocked → red chip).
 *
 * `task:stale` is deliberately NOT subscribed — staleness is a
 * time-based property the client can re-classify locally from
 * `updatedAt` and the documented thresholds. Flooding the wire with
 * stale events every heartbeat would be noise.
 *
 * One instance lives for the daemon's lifetime. Disposing removes every
 * hook listener and drops every client.
 */

import type { RondelHooks } from "../shared/hooks.js";
import type { TaskAuditEvent, TaskRecord } from "../shared/types/tasks.js";
import type { TaskService } from "../tasks/index.js";

import type { SseFrame, StreamSource } from "./sse-types.js";

const SNAPSHOT_EVENT = "task.snapshot";
const DELTA_EVENT = "task.delta";

export type TaskFrameData =
  | { readonly kind: "snapshot"; readonly entries: readonly TaskRecord[] }
  | {
      readonly kind: "delta";
      readonly entry: TaskRecord;
      readonly event: TaskAuditEvent;
    };

const HOOK_TO_AUDIT_EVENT = {
  "task:created": "created",
  "task:claimed": "claimed",
  "task:updated": "updated",
  "task:blocked": "blocked",
  "task:completed": "completed",
  "task:cancelled": "cancelled",
} as const satisfies Record<string, TaskAuditEvent>;

type TaskHookName = keyof typeof HOOK_TO_AUDIT_EVENT;

const TASK_HOOKS: readonly TaskHookName[] = [
  "task:created",
  "task:claimed",
  "task:updated",
  "task:blocked",
  "task:completed",
  "task:cancelled",
];

export class TaskStreamSource implements StreamSource<TaskFrameData> {
  private readonly clients = new Set<(frame: SseFrame<TaskFrameData>) => void>();
  private readonly unsubscribeFromHooks: (() => void)[] = [];

  constructor(hooks: RondelHooks, private readonly service: TaskService) {
    for (const name of TASK_HOOKS) {
      const event = HOOK_TO_AUDIT_EVENT[name];
      const listener = ({ record }: { record: TaskRecord }): void => {
        if (this.clients.size === 0) return;
        const frame: SseFrame<TaskFrameData> = {
          event: DELTA_EVENT,
          data: { kind: "delta", entry: record, event },
        };
        // Snapshot the client set before iterating — a mid-fan-out
        // unsubscribe (e.g. EPIPE) must not invalidate the iterator.
        for (const send of [...this.clients]) {
          try {
            send(frame);
          } catch {
            // Per-client failures don't affect other clients.
          }
        }
      };
      hooks.on(name, listener);
      this.unsubscribeFromHooks.push(() => hooks.off(name, listener));
    }
  }

  subscribe(send: (frame: SseFrame<TaskFrameData>) => void): () => void {
    this.clients.add(send);
    return () => {
      this.clients.delete(send);
    };
  }

  /**
   * See `HeartbeatStreamSource.snapshot`: disk-backed reads are async
   * but the StreamSource interface wants a sync snapshot(). We return
   * undefined here and expose `asyncSnapshot` for the bridge handler's
   * `replay` callback.
   */
  snapshot(): undefined {
    return undefined;
  }

  /**
   * Initial snapshot for a newly-connected client. Pulls non-terminal
   * tasks via the service; scope filtering (per-org) happens in the
   * bridge handler's `replay` closure, same as heartbeats.
   */
  async asyncSnapshot(caller: {
    readonly agentName: string;
    readonly isAdmin: boolean;
  }): Promise<SseFrame<TaskFrameData>> {
    const tasks = await this.service.list(caller, { includeCompleted: false });
    return {
      event: SNAPSHOT_EVENT,
      data: { kind: "snapshot", entries: tasks },
    };
  }

  dispose(): void {
    for (const undo of this.unsubscribeFromHooks) {
      try {
        undo();
      } catch {
        // Hook off() semantics aren't ours to enforce here.
      }
    }
    this.unsubscribeFromHooks.length = 0;
    this.clients.clear();
  }

  getClientCount(): number {
    return this.clients.size;
  }
}
