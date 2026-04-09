import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Shared scaffolding logic for creating agent and org directories.
 * Used by CLI commands (`rondel init`, `rondel add agent/org`)
 * and by the bridge admin endpoints for hot-add.
 *
 * Context files are loaded from templates/context/ and have {{agentName}}/{{orgName}}
 * substituted. This keeps templates as the single source of truth —
 * scaffold.ts never hardcodes prompt content.
 */

export interface ScaffoldAgentOptions {
  readonly agentDir: string;
  readonly agentName: string;
  readonly botToken: string;
  readonly model?: string;
  readonly admin?: boolean;
  readonly workingDirectory?: string;
}

/** Create the agent directory with agent.json + context files from templates. */
export async function scaffoldAgent(options: ScaffoldAgentOptions): Promise<void> {
  const { agentDir, agentName, botToken, model = "sonnet", admin = false, workingDirectory } = options;

  await mkdir(agentDir, { recursive: true });

  // agent.json
  const agentConfig: Record<string, unknown> = {
    agentName,
    enabled: true,
    ...(admin ? { admin: true } : {}),
    model,
    permissionMode: "bypassPermissions",
    workingDirectory: workingDirectory ?? null,
    channels: [
      {
        channelType: "telegram",
        accountId: agentName,
        credentials: `__INLINE:${botToken}`,
      },
    ],
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

  // Create .claude/skills/ directory for per-agent skills (Claude CLI convention)
  await mkdir(join(agentDir, ".claude", "skills"), { recursive: true });
}

// ---------------------------------------------------------------------------
// Org scaffolding
// ---------------------------------------------------------------------------

export interface ScaffoldOrgOptions {
  readonly orgDir: string;
  readonly orgName: string;
  readonly displayName?: string;
}

/** Create the org directory with org.json + shared context structure. */
export async function scaffoldOrg(options: ScaffoldOrgOptions): Promise<void> {
  const { orgDir, orgName, displayName } = options;

  await mkdir(orgDir, { recursive: true });
  await mkdir(join(orgDir, "shared"), { recursive: true });
  await mkdir(join(orgDir, "agents"), { recursive: true });

  // org.json
  const orgConfig: Record<string, unknown> = {
    orgName,
    ...(displayName ? { displayName } : {}),
    enabled: true,
  };
  await writeFile(join(orgDir, "org.json"), JSON.stringify(orgConfig, null, 2) + "\n");

  // shared/CONTEXT.md — starter template from templates/context/
  const templateDir = resolveTemplateDir();
  try {
    const template = await readFile(join(templateDir, "ORG-CONTEXT.md"), "utf-8");
    const content = template.replaceAll("{{orgName}}", orgName);
    await writeFile(join(orgDir, "shared", "CONTEXT.md"), content);
  } catch {
    // Template not found — write a minimal starter
    await writeFile(
      join(orgDir, "shared", "CONTEXT.md"),
      `# ${displayName ?? orgName}\n\nShared context for all agents in this organization.\n`,
    );
  }
}

// ---------------------------------------------------------------------------
// Template resolution
// ---------------------------------------------------------------------------

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
