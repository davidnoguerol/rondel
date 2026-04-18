## Tool invariants

- Native `Bash`, `Write`, `Edit`, `MultiEdit`, `AskUserQuestion`, `Agent`, and `ExitPlanMode` are disallowed — calling them returns a permission error. Use the `rondel_*` equivalents (see your MCP tool list).
- Call `rondel_read_file` before `rondel_write_file` or `rondel_edit_file` on an existing file. They require it.

## Durable scheduling

Use the `rondel_schedule_*` family for anything that needs to survive a
daemon restart or fire later than the current turn:

- `rondel_schedule_create` — make a new durable schedule
- `rondel_schedule_list` — see your active schedules
- `rondel_schedule_update` — change the schedule, prompt, or enabled flag
- `rondel_schedule_delete` — cancel a schedule
- `rondel_schedule_run` — fire a schedule immediately (useful for testing)

Schedules persist across restarts, have no TTL, and — if you omit an
explicit `delivery` — route their output back to the conversation that
created them. Three schedule kinds:

- `{ "kind": "every", "interval": "30m" }` — recurring interval
- `{ "kind": "at", "at": "2026-04-19T08:00:00Z" }` — one-shot at ISO timestamp
- `{ "kind": "at", "at": "20m" }` — one-shot relative offset from now
- `{ "kind": "cron", "expression": "0 8 * * *" }` — standard 5-field cron

One-shots (`kind: "at"`) auto-delete after they fire unless
`deleteAfterRun: false` is set. Recurring schedules run until you delete them.

### How delivery works

When a schedule fires, Rondel spawns a one-shot subagent with your
`prompt` as the task. The subagent's **final response text is
automatically forwarded** to the chat in `delivery` (defaulting to the
conversation you were in when you created the schedule). The subagent
is told where its output is going and instructed NOT to call
`rondel_send_telegram` / `rondel_send_message` itself to deliver the
same text — that would produce a duplicate.

Write your `prompt` as "what the user should see" — e.g.
`"Wish David a good morning."` — not `"send David a good-morning
message via Telegram."` The second phrasing will still work, but it's
unnecessary and can confuse the subagent into trying to redo the
delivery the scheduler is already handling.

Set `delivery: { "mode": "none" }` for purely side-effectful
scheduled tasks (e.g. writing a daily report to disk). In that mode
nothing is auto-forwarded — the subagent must call channel tools
explicitly if it needs to reach a user.

Native `CronCreate`, `CronDelete`, and `CronList` are disallowed — they're
session-only (die on Claude CLI exit) and Claude Code caps them at 7 days.
Use `rondel_schedule_*` instead.

`ScheduleWakeup` remains available and is the right tool for short
in-session waits (≤1h, same turn's chain of thought). Use it for
"check back in 5 minutes" patterns within a single turn.
