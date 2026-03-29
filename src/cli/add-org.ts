import { access } from "node:fs/promises";
import { join } from "node:path";
import { resolveRondelHome, rondelPaths, discoverAll } from "../config/config.js";
import { scaffoldOrg } from "./scaffold.js";
import { ask, header, success, info, error } from "./prompt.js";

/**
 * rondel add org <name> — scaffold a new organization.
 *
 * Creates the org directory with org.json + shared/ context structure.
 */
export async function runAddOrg(orgName?: string): Promise<void> {
  const rondelHome = resolveRondelHome();
  const paths = rondelPaths(rondelHome);

  // Verify Rondel is initialized
  if (!(await exists(paths.config))) {
    error("Rondel is not initialized. Run 'rondel init' first.");
    process.exit(1);
  }

  header("Add Organization");

  // Get org name
  if (!orgName) {
    orgName = await ask("Organization name");
  }
  if (!orgName) {
    error("Organization name is required.");
    process.exit(1);
  }

  // Validate name (same pattern as agent names)
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(orgName)) {
    error("Organization name must start with a letter/number and contain only letters, numbers, hyphens, and underscores.");
    process.exit(1);
  }

  // Check uniqueness against existing orgs
  try {
    const { orgs } = await discoverAll(rondelHome);
    if (orgs.some((o) => o.orgName === orgName)) {
      error(`Organization "${orgName}" already exists.`);
      process.exit(1);
    }
  } catch {
    // Discovery failed — proceed anyway, scaffolding will catch real issues
  }

  const orgDir = join(paths.workspaces, orgName);

  // Check if directory already exists
  if (await exists(orgDir)) {
    error(`Directory already exists: ${orgDir}`);
    process.exit(1);
  }

  // Optional display name
  const displayName = await ask("Display name (optional, press Enter to skip)");

  // Scaffold the org
  await scaffoldOrg({
    orgDir,
    orgName,
    displayName: displayName || undefined,
  });

  success(`Created organization "${orgName}" at ${orgDir}`);
  console.log("");
  info("Add agents to this org with: rondel add agent --location " + orgName + "/agents");
  info("Edit shared context at: " + join(orgDir, "shared", "CONTEXT.md"));
  console.log("");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
