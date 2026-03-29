---
name: flowclaw-create-agent
description: "Create a new persistent FlowClaw agent with its own Telegram bot. Use when the user asks to add a new agent, bot, or team member."
---

# Creating a New Agent

A new agent is a persistent entity with its own Telegram bot, identity, memory, and conversations. Do NOT confuse with subagents (ephemeral task workers) — see the flowclaw-delegation skill if unclear.

## Before You Start

1. **Clarify the role**: What should this agent do? (PM, dev lead, researcher, etc.)
2. **Choose a name**: Ask what to call it. Suggest something short based on the role.
3. **Check the filesystem**: If the user mentions a project, verify it exists — this becomes the agent's `workingDirectory`
4. **Model**: Default to `sonnet` unless the user asks for something else. Don't ask.
5. **Present your plan**: Summarize name, role, and model. **Wait for explicit confirmation.**

Do NOT ask the user about the `location` parameter — use `global/agents` as the default. The user doesn't need to know about FlowClaw's internal directory structure.

## Getting the Telegram Bot Token

Walk the user through creating a bot:

1. Open Telegram and search for **@BotFather**
2. Send `/newbot`
3. Choose a display name (e.g., "Scout PM")
4. Choose a username (must end in `bot`, e.g., `scout_pm_bot`)
5. BotFather will reply with a token — ask the user to copy and send it here

Do NOT proceed until you have the token.

## Creating the Agent

Only after the user has:
- Confirmed the plan (name, model, location)
- Provided the bot token

Call `flowclaw_add_agent` with:
- `agent_name`: the name (lowercase, hyphens and underscores OK)
- `bot_token`: the token from BotFather
- `model`: the model (default: `sonnet`)
- `location`: path within workspaces/ (default: `global/agents`)

## After Creation

Tell the user:
- The new agent is live — they can message it on Telegram right now
- It will run its bootstrap ritual on first message (introduces itself, asks about preferences)
- The agent is non-admin by default — they can promote it later if needed
