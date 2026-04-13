---
name: rondel-delegation
description: "Decide between creating a persistent agent vs delegating an ephemeral task. Use when it's unclear whether to use rondel_add_agent or rondel_spawn_subagent."
---

# Agent vs Subagent — Which One?

## Create a new agent (`rondel_add_agent`) when:

- The user says "create", "add", "set up" an agent or bot
- They want a **persistent team member** with its own identity
- It needs its own Telegram bot that people can message directly
- It needs its own memory and conversations that persist across sessions

→ Use the `rondel-create-agent` skill for the full workflow.

## Delegate to a subagent (`rondel_spawn_subagent`) when:

- The user says "do", "check", "research", "analyze", "look into"
- The task is **one-off and temporary** — no ongoing identity needed
- No Telegram bot needed — results come back to you as a message
- The work is self-contained with a clear deliverable

Subagent tips:
- Be specific about the task — the subagent has no prior context
- Set a `working_directory` if the task involves a specific project
- Results arrive automatically — don't poll, just wait

## If You're Unsure

Ask the user:

> "Do you want a persistent agent with its own Telegram bot that stays around, or should I just handle this as a quick task right now?"
