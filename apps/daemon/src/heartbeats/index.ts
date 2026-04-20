/**
 * Heartbeats module barrel.
 *
 * Per-agent liveness records. See `./heartbeat-service.ts` for the main
 * entry point. Agents write via the `rondel_heartbeat_update` MCP tool
 * (which posts to `POST /heartbeats/update` on the bridge); admins /
 * orchestrators read via `rondel_heartbeat_read_all`.
 */

export {
  HeartbeatService,
  HeartbeatError,
  HEALTHY_THRESHOLD_MS,
  DOWN_THRESHOLD_MS,
  classifyHealth,
  classifyHealthFromAge,
  withHealth,
  findStale,
  type HeartbeatServiceDeps,
  type HeartbeatCaller,
  type HeartbeatUpdateFields,
  type HeartbeatReadAllResult,
  type HeartbeatErrorCode,
  type ResolveAgentIntervalMs,
} from "./heartbeat-service.js";
export type { HeartbeatPaths } from "./heartbeat-store.js";
