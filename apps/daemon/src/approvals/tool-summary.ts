/**
 * Pure helper: produce a one-line, human-readable summary of a tool call.
 *
 * Used for two audiences:
 *  - Telegram approval messages (short text block in the prompt card)
 *  - Ledger `summary` field for the `approval_request` event kind
 *
 * Ported in spirit from cortextos's `formatToolSummary`
 * (cortextos/src/hooks/index.ts), but keeps everything local so the
 * hook script and the bridge produce identical summaries.
 *
 * No runtime imports — this module is shared between the bridge
 * (TypeScript) and the hook script (reads the same logic in .mjs form).
 */

const MAX_SUMMARY_LEN = 200;

function truncate(text: string, max = MAX_SUMMARY_LEN): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 3) + "...";
}

function asString(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === undefined || v === null) return "";
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * Build a short, human-readable summary string.
 *
 * Format depends on the tool:
 *   Bash    → `Bash: <command>`
 *   Write   → `Write <path> (<size>B)`
 *   Edit    → `Edit <path>`
 *   Read    → `Read <path>`
 *   default → `<tool>: <stringified input>`
 */
export function summarizeToolUse(toolName: string, toolInput: unknown): string {
  const input = (toolInput ?? {}) as Record<string, unknown>;

  switch (toolName) {
    case "Bash": {
      const command = asString(input.command);
      return truncate(`Bash: ${command}`);
    }
    case "rondel_bash": {
      const command = asString(input.command);
      return truncate(`rondel_bash: ${command}`);
    }
    case "Write": {
      const path = asString(input.file_path ?? input.path);
      const content = asString(input.content);
      const size = content.length;
      return truncate(`Write ${path} (${size}B)`);
    }
    case "rondel_write_file": {
      const path = asString(input.path ?? input.file_path);
      const content = asString(input.content);
      const size = content.length;
      return truncate(`rondel_write_file ${path} (${size}B)`);
    }
    case "Edit":
    case "MultiEdit": {
      const path = asString(input.file_path ?? input.path);
      return truncate(`${toolName} ${path}`);
    }
    case "rondel_edit_file": {
      const path = asString(input.path ?? input.file_path);
      return truncate(`rondel_edit_file ${path}`);
    }
    case "rondel_multi_edit_file": {
      const path = asString(input.path ?? input.file_path);
      const edits = Array.isArray(input.edits) ? input.edits.length : 0;
      return truncate(`rondel_multi_edit_file ${path} (${edits} edits)`);
    }
    case "rondel_ask_user": {
      // Short `ask_user: <prompt>` prefix so the ledger shows which
      // question produced which answer without dumping the full option
      // list (which can be up to 8 labels × 200 chars).
      const prompt = asString(input.prompt);
      return truncate(`ask_user: ${prompt}`);
    }
    case "Read": {
      const path = asString(input.file_path ?? input.path);
      return truncate(`Read ${path}`);
    }
    case "rondel_read_file": {
      const path = asString(input.path ?? input.file_path);
      return truncate(`rondel_read_file ${path}`);
    }
    case "Glob": {
      const pattern = asString(input.pattern);
      return truncate(`Glob ${pattern}`);
    }
    case "Grep": {
      const pattern = asString(input.pattern);
      return truncate(`Grep ${pattern}`);
    }
    case "WebFetch": {
      const url = asString(input.url);
      return truncate(`WebFetch ${url}`);
    }
    case "WebSearch": {
      const query = asString(input.query);
      return truncate(`WebSearch ${query}`);
    }
    default: {
      // Unknown tool — stringify the whole input for visibility
      return truncate(`${toolName}: ${asString(input)}`);
    }
  }
}
