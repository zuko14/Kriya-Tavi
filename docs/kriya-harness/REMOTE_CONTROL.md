# Remote Control

One switch in Kriya Harness replaces `kriya daemon` and its flags, and shows a
session live in the Kriya app. Owner brief in chat, 2026-11-05.

Switch: `harness.remoteControl` (default **off**). Off: `POST /live` answers 404,
`/harness` shows no Remote Control section, and the toggle says so.

## What it does

In a session's Overview tab, **Remote Control** on:

1. Streams that session to `/harness` and `/harness/live/{id}`: the person's
   messages, the agent's answers, each tool with one target (a file, a
   redacted command, an address), and working / waiting / idle.
2. Listens for the Control Center in that session's folder for as long as the
   app runs: the same `runDaemon` as `kriya daemon`, inside the app.

**Allow serving** and **Allow Full access** replace `--allow-serve` and
`--allow-full-access`. They exist only while Remote Control is on, and reset
when the last session is switched off.

## Decisions

- **RC-D1 The switch lives on the computer.** CC-D3 stands: nothing in Kriya can
  raise what a computer allows, so a stolen web session can't turn these on.
- **RC-D2 Per session, explicit.** Only switched-on sessions stream. The device's
  mirror setting and `kriya.harness_sessions` are untouched.
- **RC-D3 Lines, not output.** Tool output never leaves the computer; targets
  pass `redact()` (`src/live.js`). Messages and answers are sent as they are;
  that is what the person turned on.
- **RC-D4 Not agent context.** Live rows are shown to the person only, as plain
  text. Nothing reads them into a prompt, so no `MIRROR_CONTEXT` is needed.
- **RC-D5 One listener.** If a `kriya daemon` command is running (`daemon.pid`),
  the app leaves listening to it and only streams.
- **RC-D6 Polling.** The client reports every 2 s while there is news and every
  30 s otherwise; pages poll every 2.5 s. Silent for 2 minutes reads "Lost contact".

## Data

Migration `20271001000000_harness_live.sql`: `kriya.harness_live_sessions`,
`kriya.harness_live_events`. Read only by the person (RLS); written only by
`POST /live` after `authenticateDevice`. The newest 3,000 events per session are kept.

## Not built

- Steering from the app (typing into the running session): the Control Center
  starts new tasks; sending into a live session needs its own safety review.
- Screenshots of the agent's browser in Kriya: the address shows, not the page.
- Turning a session off from the Kriya app.
- A deleted local session stays in `/harness` until its device is removed.
