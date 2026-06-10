// One-time harvest of the Claude CLI's native auto-memory (design D3).
//
// The CLI (v2.1.59+) maintains a per-project memory/ dir under
// ~/.claude/projects/<mangled-cwd>/. Rondel disables that system on every
// spawn (CLAUDE_CODE_DISABLE_AUTO_MEMORY=1) in favor of its own memory
// domain — but disabling must not orphan content the CLI already
// accumulated. Before the first spawn, copy any non-empty auto-memory dir
// into the agent's workspace at memory/imported-cli-auto-memory/ (user
// space: reviewable, deletable). A marker file under state/transcripts/
// makes the harvest once-per-agent.
//
// Agents sharing a cwd (e.g. workingDirectory unset → daemon cwd) each get
// a copy of the same dir — harmless duplication in user space, noted in the
// log line.

import { cp, mkdir, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile } from "../shared/atomic-file.js";
import type { Logger } from "../shared/logger.js";
import { deriveCliProjectDir } from "./cli-transcript-path.js";

export interface HarvestAgent {
  readonly agentName: string;
  readonly agentDir: string;
  readonly cwd: string;
}

export interface HarvestArgs {
  readonly agents: ReadonlyArray<HarvestAgent>;
  /** Marker file directory (state/transcripts). */
  readonly markerDir: string;
  readonly log: Logger;
  /** Test seam: where CLI project dirs live (default ~/.claude/projects/<mangled>). */
  readonly resolveCliProjectDir?: (cwd: string) => string;
}

const MARKER_FILE = ".auto-memory-harvested.json";

export async function harvestCliAutoMemory(args: HarvestArgs): Promise<void> {
  const log = args.log.child("auto-memory-harvest");
  const markerPath = join(args.markerDir, MARKER_FILE);

  let harvested: Record<string, string> = {};
  try {
    harvested = JSON.parse(await readFile(markerPath, "utf-8")) as Record<string, string>;
  } catch {
    /* first run */
  }

  let changed = false;
  for (const agent of args.agents) {
    if (harvested[agent.agentName]) continue;
    const projectDir = args.resolveCliProjectDir?.(agent.cwd) ?? deriveCliProjectDir(agent.cwd);
    const sourceDir = join(projectDir, "memory");

    let entries: string[];
    try {
      entries = await readdir(sourceDir);
    } catch {
      // No auto-memory for this cwd — mark done so we don't re-stat daily.
      harvested[agent.agentName] = new Date().toISOString();
      changed = true;
      continue;
    }
    if (entries.length === 0) {
      harvested[agent.agentName] = new Date().toISOString();
      changed = true;
      continue;
    }

    const destDir = join(agent.agentDir, "memory", "imported-cli-auto-memory");
    const destExists = await stat(destDir).then(
      () => true,
      () => false,
    );
    if (destExists) {
      log.warn(`Skipping harvest for ${agent.agentName}: ${destDir} already exists (never overwrite)`);
    } else {
      await cp(sourceDir, destDir, { recursive: true });
      log.info(`Harvested CLI auto-memory for ${agent.agentName}: ${entries.length} file(s) from ${sourceDir} (shared-cwd agents each get a copy)`);
    }
    harvested[agent.agentName] = new Date().toISOString();
    changed = true;
  }

  if (changed) {
    await mkdir(args.markerDir, { recursive: true });
    await atomicWriteFile(markerPath, JSON.stringify(harvested, null, 2));
  }
}
