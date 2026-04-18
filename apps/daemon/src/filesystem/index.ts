/**
 * Filesystem state for the first-class Rondel tool suite.
 *
 * - `ReadFileStateStore`: in-memory session-scoped record of which files
 *   an agent has read, keyed by (agent, sessionId, path). Consulted by
 *   write/edit/multi-edit tools to enforce "you must have read it first".
 * - `FileHistoryStore`: disk-backed pre-image backups taken before any
 *   destructive filesystem operation, so an undo path exists even when
 *   the edit was approved.
 */

export { ReadFileStateStore, type ReadRecord } from "./read-state-store.js";
export { FileHistoryStore, type BackupEntry } from "./file-history-store.js";
