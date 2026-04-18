/**
 * shared/safety — pure classification logic for tool-use safety checks.
 *
 * Every file here has zero runtime imports outside sibling files and
 * `node:path`. That's what lets us bundle this module into the PreToolUse
 * hook's `.mjs` script without dragging in config, logger, or any other
 * daemon state.
 */

export type { Classification, EscalationReason, ClassificationResult } from "./types.js";
export type { SafeZoneContext } from "./safe-zones.js";
export { classifyBash } from "./classify-bash.js";
export { isPathInSafeZone } from "./safe-zones.js";
export { scanForSecrets, type SecretMatch } from "./secret-scanner.js";
