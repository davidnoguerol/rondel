# How OpenClaw Agents Extend Their Own Capabilities

> Research compiled by bot1 (Claude claude-opus-4-5), April 2026.
> Sources: `openclaw-research/`, `rondel/docs/openclaw/`, `openclaw/skills/skill-creator/SKILL.md`, `openclaw/src/infra/clawhub.ts`, `openclaw/src/agents/skills/`.

---

## Overview

OpenClaw agents extend themselves through a **three-tier stack**:

1. **Skills** — natural language packages, self-selected at runtime from the system prompt
2. **ClawHub** — a marketplace of 5,400+ skills and plugins, installable at runtime
3. **`skill-creator`** — a meta-skill that lets the agent author new skills from scratch

The entire system is bootstrapped by one key insight: **include the skill catalog in the system prompt** so the LLM can self-route without being told which skill to use.

---

## Tier 1: Skills — Runtime Self-Selection

### What a Skill Is

A Skill is a directory containing a required `SKILL.md` file and optional bundled resources:

```
skill-name/
├── SKILL.md                  # Required — frontmatter + instructions
├── scripts/                  # Executable code (Python/Bash/etc.)
├── references/               # Docs loaded into context as needed
└── assets/                   # Files used in output (templates, icons, etc.)
```

`SKILL.md` has YAML frontmatter with `name` and `description`, followed by Markdown instructions:

```markdown
---
name: Email Daily Digest
description: Summarize important emails and send digest
tags: [email, automation, daily]
requires: [gmail, image-processing]
---
Check unread emails from the past 24 hours, summarize important ones by category,
and send a digest to the user via message.
```

### How the Agent Self-Selects

The system prompt includes a **catalog of all available skills** — name + description only, ~100 tokens per skill. The LLM reads this list and autonomously decides which skill to invoke based on the user's request. No explicit routing instruction needed.

**Three-level progressive disclosure:**

| Level | What's loaded | When |
|-------|--------------|------|
| Metadata (name + description) | Always in context | ~100 words per skill |
| SKILL.md body | When skill triggers | < 5,000 words |
| Bundled resources (scripts, references, assets) | As needed by agent | Unlimited (scripts execute without loading) |

This keeps context lean — the agent only loads what it actually needs for the task.

### Skill Sources

Skills are loaded from multiple directories:

- **Bundled skills** — shipped with OpenClaw (global defaults)
- **Plugin-contributed skills** — extensions register their skill directories via `resolvePluginSkillDirs()`
- **Local workspace skills** — user's own custom skills
- **ClawHub-installed skills** — downloaded from the marketplace

The `skills/workspace.ts` module assembles all sources, applies config filters, compacts paths for token efficiency (~5–6 tokens saved per path × N skills), and formats them for the system prompt.

---

## Tier 2: ClawHub — The Skill Marketplace

OpenClaw has a built-in registry client (`src/infra/clawhub.ts`) connected to `clawhub.ai`.

### Three Package Families

```typescript
type ClawHubPackageFamily = "skill" | "code-plugin" | "bundle-plugin";
type ClawHubPackageChannel = "official" | "community" | "private";
```

- **`skill`** — natural language SKILL.md packages
- **`code-plugin`** — compiled TypeScript extensions that register via the plugin API
- **`bundle-plugin`** — full plugin bundles (channel + tools + skills together)

### Scale

As of February 2026:
- **5,400+** community-contributed skills on ClawHub
- **820+** of ~10,700 skills were found to be malicious (a known security gap)

New skills installed via ClawHub are immediately available to the agent — the skill catalog in the system prompt refreshes, and the agent can self-select the new capability on the next turn.

---

## Tier 3: `skill-creator` — The Meta-Skill

This is the most powerful mechanism. OpenClaw ships a skill whose job is to **create other skills**. When the agent identifies a capability gap, it invokes `skill-creator` and authors a new skill from scratch.

### Trigger Description

```yaml
description: >
  Create, edit, improve, or audit AgentSkills. Use when creating a new skill from scratch
  or when asked to improve, review, audit, tidy up, or clean up an existing skill or SKILL.md
  file. Also use when editing or restructuring a skill directory. Triggers on phrases like
  "create a skill", "author a skill", "tidy up a skill", "improve this skill".
```

### The 6-Step Creation Process

**Step 1: Understand with concrete examples**
Dialogue to surface exactly how the skill will be used. Key questions:
- "What functionality should this skill support?"
- "What would a user say that should trigger this skill?"
- "Can you give examples of how it would be used?"

**Step 2: Plan reusable contents**
Analyze each use case to identify what scripts, references, and assets would help:
- Repeatedly-rewritten code → `scripts/` (e.g., `rotate_pdf.py`)
- Boilerplate output → `assets/` (e.g., `hello-world/` HTML template)
- Domain knowledge to rediscover each time → `references/` (e.g., `schema.md`)

**Step 3: Initialize the skill**
Run the scaffold script:
```bash
scripts/init_skill.py <skill-name> --path <output-directory> [--resources scripts,references,assets]
```
Generates the directory structure with a SKILL.md template and TODO placeholders.

**Step 4: Edit the skill**
Write for another instance of the agent — include what would be non-obvious. Guidelines:
- Write the `description` frontmatter comprehensively — it's the ONLY thing read before triggering
- Use imperative/infinitive form in instructions
- Keep SKILL.md body under 500 lines; split detailed content into `references/` files
- Reference all resource files explicitly from SKILL.md so future-agent knows they exist

**Step 5: Package the skill**
```bash
scripts/package_skill.py <path/to/skill-folder>
```
Validates YAML format, naming conventions, description completeness, file structure. Packages into a distributable `.skill` file (zip with `.skill` extension). Symlinks rejected.

**Step 6: Iterate**
Test on real tasks, notice struggles, update the skill. The loop is:
```
Agent identifies gap
  → invokes skill-creator
  → new SKILL.md authored
  → skill loaded into catalog
  → agent self-selects new skill on next relevant task
```

---

## The Plugin System: Code-Level Extension

For more complex needs beyond natural language skills, OpenClaw has a full plugin architecture (81+ built-in extensions).

### Plugin Manifest (`openclaw.plugin.json`)

Every plugin declares its capabilities without requiring runtime loading:

```typescript
{
  id: string;                     // Canonical plugin ID
  contracts?: {
    tools?: string[];             // Tools this plugin provides
  };
  configSchema: Record<string, unknown>;  // JSON Schema for config
  kind?: "memory" | "context-engine";    // Exclusive slot plugins
}
```

### Plugin Loading Pipeline

1. **Discovery** — scan for `openclaw.plugin.json` manifests
2. **Manifest load** — parse into queryable registry
3. **Config filter** — apply enable/disable state from user config
4. **Dynamic import** — load entry point via `jiti` (runtime TypeScript loader)
5. **Registration** — call `definition.register(api: OpenClawPluginApi)` — plugin registers its tools, channels, skills

Plugins can only touch core through `openclaw/plugin-sdk/*` — no direct internal access.

### Plugin SDK Example

```typescript
import { Tool, ToolContext } from 'openclaw/tools';
import { Channel } from 'openclaw/channels';
import { Plugin } from 'openclaw/plugins';

const myCustomTool = new Tool({
  name: 'my_tool',
  description: 'Does something useful',
  handler: async (context: ToolContext, args: any) => { /* ... */ }
});

export default {
  name: 'my-plugin',
  version: '1.0.0',
  tools: [myCustomTool],
} as Plugin;
```

---

## The Key Insight: Natural Language as the Routing Protocol

The entire skill system works because of one design principle: **the LLM itself is the router**.

Instead of building an explicit dispatch system, OpenClaw puts the skill catalog in the system prompt and trusts the model to decide when a skill is relevant. This means:

- No new tool UI required for new capabilities
- Every skill is immediately composable with every other skill
- The routing improves as models improve
- Human-readable skill definitions = auditable capability surface

Tools are atomic operations. Skills compose tools. The `skill-creator` meta-skill creates new skills. The result is a genuinely self-extending agent — the extension mechanism is itself just another skill.

---

## NanoClaw's Simpler Take

NanoClaw (the minimal 3,500-line fork) skips the plugin architecture entirely. Its `.claude/skills/` directory contains Claude Code skills that **teach the agent to modify the source code itself**:

```
.claude/skills/
├── add-whatsapp/SKILL.md     # How to add WhatsApp channel support
├── add-telegram/SKILL.md     # How to add Telegram channel support
├── add-discord/SKILL.md      # How to add Discord channel support
├── add-slack/SKILL.md        # How to add Slack channel support
└── add-ollama-tool/SKILL.md  # How to add a local Ollama model
```

When a user asks "add WhatsApp support," the agent doesn't install a plugin — it reads `add-whatsapp/SKILL.md` and **edits the source code of NanoClaw itself**. Every extension is a fork modification, version-controlled and auditable. No marketplace, no plugin registry. Just the agent and the code.

---

## Implications for Rondel

The skill system in OpenClaw maps directly to Rondel's current skill support (`.claude/skills/` directories, `--add-dir` skill discovery via `agent-process.ts`). Key patterns worth adopting:

| OpenClaw Pattern | Rondel Status | Notes |
|-----------------|--------------|-------|
| SKILL.md with YAML frontmatter | ✅ Used | Rondel agents use this already |
| Progressive disclosure (3 levels) | ✅ Implicit | Body loaded after trigger |
| `skill-creator` meta-skill | ❌ Not implemented | Could be a Rondel-specific skill |
| ClawHub / skill marketplace | ❌ Not implemented | Future if ecosystem grows |
| Plugin API (`openclaw.plugin.json`) | ❌ N/A | Rondel uses MCP tools instead |
| Skill catalog in system prompt | ✅ Via `--add-dir` | Claude CLI handles this natively |

The `skill-creator` pattern is the most actionable gap — a skill that helps agents (or the human) author new skills for the Rondel ecosystem. Given that Rondel agents can already read/write files and run bash, implementing it would require mostly just writing the `SKILL.md` itself.

---

*Sources: `openclaw/skills/skill-creator/SKILL.md`, `openclaw-research/OpenClaw_NanoClaw_NemoClaw_Deep_Research.md`, `rondel/docs/openclaw/openclaw-architecture.md`, `openclaw/src/agents/skills/workspace.ts`, `openclaw/src/infra/clawhub.ts`.*
