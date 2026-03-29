---
name: flowclaw-manage-config
description: "Update FlowClaw agent configuration, environment variables, or trigger a config reload. Use for system management tasks."
---

# Managing FlowClaw Configuration

## Rule: Always Confirm Before Acting

1. Explain what you're about to change and why
2. Wait for explicit user approval
3. Only then call the tool

## Available Tools

### Check system status (`flowclaw_system_status`)

Read-only. Shows all agents, their conversations, and uptime.
Safe to call anytime — no confirmation needed.

### Update agent config (`flowclaw_update_agent`)

Changes an agent's settings: model, enabled/disabled, admin privileges.
Changes apply to new conversations — running ones keep current settings.

Parameters:
- `agent_name`: which agent to update
- `model`: new model (e.g., "sonnet", "haiku", "opus")
- `enabled`: true/false
- `admin`: true/false

### Set environment variables (`flowclaw_set_env`)

Adds or updates a key in FlowClaw's `.env` file.
Use for: API keys, bot tokens, secrets.
Takes effect immediately for new processes.

Parameters:
- `key`: variable name (uppercase, e.g., `SOME_API_KEY`)
- `value`: the value to set

### Reload configuration (`flowclaw_reload`)

Re-discovers agents from the workspaces directory.
Use after: manually adding agent directories or changing agent.json files.
Returns which agents were added or updated.
