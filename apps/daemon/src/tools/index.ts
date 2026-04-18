/**
 * First-class Rondel MCP tools.
 *
 * Each file exports a single `registerXxxTool(server)` function.
 * New tools added here must be wired into `bridge/mcp-server.ts`.
 *
 * See ./README.md for the env-var contract these tools rely on.
 */

export { registerBashTool } from "./bash.js";
export { registerReadFileTool } from "./read-file.js";
export { registerWriteFileTool } from "./write-file.js";
export { registerEditFileTool } from "./edit-file.js";
export { registerMultiEditFileTool } from "./multi-edit-file.js";
export { registerAskUserTool } from "./ask-user.js";
