---
name: rondel-create-skill
description: "Author a new skill (reusable procedure) for yourself, or edit/improve/audit an existing one. Use when the user asks to save, remember, or teach you a procedure; when they say 'from now on, whenever X, do Y'; when they ask you to create, author, review, clean up, tidy up, or improve a skill. Triggers on phrases like 'create a skill', 'save this as a skill', 'teach you how to X', 'remember how to do X', 'author a skill', 'improve this skill', 'audit the skill', 'clean up the skill'. Do NOT use for one-off facts or preferences — those belong in MEMORY.md via rondel_memory_save."
---

# Creating a Skill

A skill is a **procedure** — a repeatable, multi-step workflow you can follow when the user asks for it. Skills are discovered automatically by Claude CLI at spawn time and surface in your catalog via their `description` field. Once created, a skill triggers itself whenever the description matches the user's request.

## Skills vs memory — when to use which

- **`MEMORY.md`** is for **facts**: decisions, preferences, project state, user context. Things you know.
- **Skills** are for **procedures**: multi-step workflows, playbooks, recipes. Things you do.

If you notice yourself reconstructing the same multi-step procedure from memory twice, stop and propose promoting it to a skill. Memory is indexed knowledge; skills are indexed action.

## Where your skills live

Per-agent skills live at `<your agent directory>/.claude/skills/<skill-name>/SKILL.md`. Rondel already passes your agent directory as `--add-dir`, so a file written there is automatically in your catalog on the next process spawn.

Your absolute agent directory is in the **"Your environment"** block of your system prompt — use it. Never write into a sibling agent's directory; each agent owns its own skills.

## Core design principles

### Concise is key

The context window is a public good. Skills share it with everything else: the system prompt, conversation history, other skills' metadata, and the user's actual request. Default assumption: **the future reader of this skill is already very smart**. Only add context they don't already have. Challenge each paragraph: "Does this justify its token cost?"

### Set appropriate degrees of freedom

Match specificity to fragility:

- **High freedom** (plain text instructions) — when multiple approaches are valid and heuristics guide the choice.
- **Medium freedom** (pseudocode, parametrized scripts) — when a preferred pattern exists and some variation is OK.
- **Low freedom** (specific scripts, few parameters) — when operations are fragile and consistency is critical.

A narrow bridge with cliffs needs guardrails. An open field allows many routes.

### Progressive disclosure

Skills load in three levels:

1. **Metadata** (`name` + `description`) — always in context, ~100 words
2. **SKILL.md body** — loaded only when the skill triggers, keep under 500 lines
3. **Bundled resources** (`scripts/`, `references/`, `assets/`) — loaded on demand

The `description` is the **entire trigger surface**. Everything a future reader needs to decide whether to use this skill must be in the description. The body is only read after triggering — it cannot help trigger.

## Anatomy of a skill

```
<skill-name>/
├── SKILL.md              required — frontmatter + markdown body
├── scripts/   optional   executable code (Python/bash/etc.)
├── references/ optional  docs loaded into context as needed
└── assets/     optional  files used in output (templates, images)
```

Only create resource directories you actually need. Most skills are just a single `SKILL.md`.

## The 5-step process

Follow these steps in order. Skip a step only when there's a clear reason it doesn't apply.

### Step 1 — Understand with concrete examples

You're about to write a procedure for another instance of yourself to follow. You can't do that well without knowing exactly how it will be used. Ask the user, starting with the most important questions (don't overwhelm them):

- "What functionality should this skill support?"
- "Can you give me a concrete example of how you'd use it?"
- "What would you say that should trigger this skill?"
- "Are there variations or edge cases I should handle?"

Conclude Step 1 when you have a clear sense of what the skill should do and what phrases should trigger it. If the user's request is already specific and unambiguous ("from now on, whenever I say 'standup', do X, Y, Z"), you can compress this step into a single confirmation.

### Step 2 — Plan reusable contents

For each concrete example, ask yourself:

1. **How would I execute this from scratch?**
2. **What would help if I had to do this repeatedly?**

Three patterns, each with a real-world example:

- **Rewriting the same code** → put it in `scripts/`. *Example: a `pdf-editor` skill with `scripts/rotate_pdf.py` so the rotation logic isn't re-invented each time.*
- **Reusing the same boilerplate output** → put it in `assets/`. *Example: a `frontend-webapp-builder` skill with `assets/hello-world/` as a starter template.*
- **Rediscovering the same domain knowledge** → put it in `references/`. *Example: a `bigquery` skill with `references/schema.md` documenting the table schemas so you don't re-query them every time.*

Most skills don't need any of these. A procedure that's "check X, then Y, then Z" is often fine as pure text in `SKILL.md`.

### Step 3 — Write the SKILL.md

**Name the skill.** Rules:

- Lowercase letters, digits, and hyphens only
- ≤64 characters total
- Short, verb-led phrases when possible (`summarize-prs`, not `pr-summary-tool`)
- Normalize the user's wording: *"My Awesome Skill!"* → `my-awesome-skill`. If normalization changes what the user said, tell them before writing ("I'll save this as `my-awesome-skill` since skill names are hyphen-case").

**Check for conflicts.** Before writing, verify the target directory does NOT already exist. If it does, tell the user and ask whether to (a) pick a different name or (b) explicitly overwrite. Never silently overwrite.

**Target path**: `<agentDir>/.claude/skills/<skill-name>/SKILL.md` — inside your own agent directory only.

**Create the directory** with bash: `mkdir -p <agentDir>/.claude/skills/<skill-name>/`.

**Write the SKILL.md** using the `Write` tool with this template as the starting point. Fill in every `[TODO]` — don't leave placeholders in the final file.

```markdown
---
name: <skill-name>
description: [Complete, explicit description. Say what the skill does AND when to use it. Include trigger phrases the user might say. This is the ONLY thing read before the skill fires — make it comprehensive.]
---

# <Skill Title>

## Overview

[One or two sentences explaining what this skill enables.]

## [First main section]

[Content. Pick a structure that fits:
- Workflow-based (sequential steps)
- Task-based (here's how to do X, here's how to do Y)
- Reference/guidelines (standards or specifications)
- Capabilities-based (a numbered list of what it can do)
Mix patterns as needed. Delete this placeholder block before saving.]
```

### Step 4 — Write for a future version of yourself

Remember: the skill is read by another Claude instance that has no context about this conversation. Include information that would be beneficial and non-obvious to them.

**Voice and form:**

- Use imperative/infinitive form: *"Check unread emails from the past 24 hours"*, not *"I will check..."*
- Keep the body under 500 lines. If it grows longer, split detailed content into `references/` files and link to them from SKILL.md.
- Information lives in `SKILL.md` **XOR** `references/` — never both. Duplication rots.

**The description is everything.** The description field is the only thing loaded before the skill triggers. If a future instance of you needs to know *when* to use this skill, it must be in the description. Do NOT put "When to use this skill" sections in the body — they'll never be read at decision time.

Good descriptions:
- State what the skill does
- State explicit triggers ("Use when the user says X, Y, Z")
- List concrete trigger phrases
- Call out anti-triggers when relevant ("Do NOT use for one-off facts — those belong in MEMORY.md")

### Step 5 — Reload and verify

After writing the SKILL.md:

1. **Call `rondel_reload_skills`**. It schedules a restart for *after* your current response completes. Your session context is preserved via `--resume`. You do not need to do anything special — just continue your turn.
2. **Confirm to the user**: *"Skill saved. My next response will use it."*
3. **End your turn normally.**

On the user's next message, the new skill is in your catalog. If you want to verify it yourself, in your next response you can call `rondel_system_status` or simply proceed as normal — the skill will trigger automatically when its description matches a future request.

## Forbidden files inside a skill

Do NOT create any of these inside a skill directory:

- `README.md`
- `INSTALLATION_GUIDE.md`
- `QUICK_REFERENCE.md`
- `CHANGELOG.md`

A skill contains only what's needed for a future instance of an agent to do the job. Process notes, setup instructions, user-facing docs, and change history are clutter — they steal context without paying for it.

If you find yourself wanting to write one of those files, ask: *"Does a future instance of me need this to perform the procedure?"* If no, don't write it.

## Editing an existing skill

The same 5 steps apply, with small differences:

- **Step 1** is lighter: you already know the purpose. Ask only about what's changing.
- **Step 3** becomes *edit* — read the existing `SKILL.md` first, preserve structure, make focused changes via `Edit` tool.
- **Step 5** is unchanged: always call `rondel_reload_skills` after any edit. Skills are discovered at spawn, so an edit without a reload is invisible until the next natural restart.

## Safety rails (do not skip)

- **Write only inside your own agent directory** (path in the "Your environment" block).
- **Never overwrite a skill silently.** Check first; confirm with the user.
- **Normalize names before writing** and tell the user if normalization changes their wording.
- **Always reload after write or edit.** A skill that isn't in the catalog is invisible.
- **One SKILL.md per directory.** The file name is always exactly `SKILL.md`.
