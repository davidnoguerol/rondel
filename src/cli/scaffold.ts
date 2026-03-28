import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Shared scaffolding logic for creating agent directories.
 * Used by both `flowclaw init` (first agent) and `flowclaw add agent`.
 *
 * Context files are loaded from templates/context/ and have {{agentName}}
 * substituted. This keeps templates as the single source of truth —
 * scaffold.ts never hardcodes prompt content.
 */

export interface ScaffoldAgentOptions {
  readonly agentDir: string;
  readonly agentName: string;
  readonly botToken: string;
  readonly model?: string;
}

/** Create the agent directory with agent.json + context files from templates. */
export async function scaffoldAgent(options: ScaffoldAgentOptions): Promise<void> {
  const { agentDir, agentName, botToken, model = "sonnet" } = options;

  await mkdir(agentDir, { recursive: true });

  // agent.json
  const agentConfig = {
    agentName,
    enabled: true,
    model,
    permissionMode: "bypassPermissions",
    workingDirectory: null,
    telegram: {
      botToken,
    },
    tools: {
      allowed: ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebSearch", "WebFetch"],
      disallowed: [],
    },
    crons: [],
  };
  await writeFile(join(agentDir, "agent.json"), JSON.stringify(agentConfig, null, 2) + "\n");

  // Context files — loaded from templates/context/, {{agentName}} substituted
  const templateDir = resolveTemplateDir();
  const contextFiles = ["AGENT.md", "SOUL.md", "IDENTITY.md", "USER.md", "BOOTSTRAP.md"];

  for (const filename of contextFiles) {
    const template = await readFile(join(templateDir, filename), "utf-8");
    const content = template.replaceAll("{{agentName}}", agentName);
    await writeFile(join(agentDir, filename), content);
  }
}

/**
 * Resolve the path to templates/context/ relative to the project root.
 * Works from both src/ (dev) and dist/ (built).
 */
function resolveTemplateDir(): string {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  // From dist/cli/scaffold.js → ../../templates/context
  // From src/cli/scaffold.ts → ../../templates/context
  return join(thisDir, "..", "..", "templates", "context");
}
