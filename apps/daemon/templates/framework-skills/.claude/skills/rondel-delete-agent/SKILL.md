---
name: rondel-delete-agent
description: "Delete a Rondel agent permanently. Use when the user asks to remove, delete, or get rid of an agent."
---

# Deleting an Agent

This is **permanent and irreversible**. The agent's directory, config, identity, memory, and skills are all deleted. Its Telegram bot stops immediately.

## Before You Delete

1. **Confirm which agent**: Ask the user to name the agent. Use `rondel_system_status` to show them the list if they're unsure.
2. **Warn them**: Tell them this deletes everything — identity, memory, conversation history config. It cannot be undone.
3. **Get explicit confirmation**: Wait for a clear "yes" or "do it" before proceeding.

## Deleting

Call `rondel_delete_agent` with the agent name.

## After Deletion

Confirm to the user that:
- The agent has been removed
- Its Telegram bot has stopped
- The directory has been deleted
