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

Native `CronCreate`, `CronDelete`, and `CronList` are disallowed — they're
session-only (die on Claude CLI exit) and Claude Code caps them at 7 days.
Use `rondel_schedule_*` instead.

`ScheduleWakeup` remains available and is the right tool for short
in-session waits (≤1h, same turn's chain of thought). Use it for
"check back in 5 minutes" patterns within a single turn.
