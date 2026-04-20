---
name: rondel-heartbeat
description: "Run the 4-hour discipline cycle: check in, glance at your work, update your heartbeat. Invoked by the heartbeat cron."
---

# Heartbeat — your regular check-in

You're running the heartbeat cycle. This is a short discipline turn, not a task.
Be quick, be terse, and get back to work.

## What to do (in order)

1. **Follow up on any pending inter-agent conversation.** If your injected
   context shows a recent message from another agent that you owe a reply to,
   send it with `rondel_send_message`. Skip if nothing's pending — the
   heartbeat cron runs in isolation and won't see live inbox state anyway.
2. **Note your current state.** What are you working on? What's your status in
   one line? Examples:
   - `"drafting the Q2 summary, blocked on metrics from analyst"`
   - `"idle — no tasks queued"`
   - `"in flow on the ingestion rewrite"`
3. **Update your heartbeat.** Call `rondel_heartbeat_update` with:
   - `status` — the one-liner from step 2
   - `currentTask` — one-line summary of the primary thing you're on (optional)
   - `notes` — anything worth a future-you reading (optional)
4. **Save anything worth remembering.** If you learned something useful since
   your last beat, call `rondel_memory_save`. Don't over-write — memory is for
   things that help you later, not a running journal.
5. **Stop.** Don't continue the conversation. The heartbeat cron has no
   auto-delivery — your output is captured to the ledger only. End with a two-
   or three-line summary (what you're on, anything flagged) and return.

## What NOT to do

- Don't send the user a status message unless you've been silent for a day AND
  you have something genuinely worth surfacing. The heartbeat is internal
  plumbing; the user has a dashboard.
- Don't make up work. If you're idle, say so. `status: "idle"` is a valid
  heartbeat.
- Don't call channel-delivery tools (`rondel_send_telegram` etc.) — this is a
  cron run without auto-delivery. Just produce your summary as text and stop.

## If you're unsure what to write

`status: "alive — standing by"` is acceptable when nothing is happening. The
point of the heartbeat is to *exist*, not to perform activity.
