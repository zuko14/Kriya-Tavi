# Kriya Harness Control Center

Every `kriya` terminal command as a control on `/harness` (and the phone),
running on the person's own computer through `kriya daemon`, and every kriya
process on that computer reporting what it runs. Owner brief: "Full CLI-to-UI
parity and bidirectional control center" (2026-11-04).

Switch: `harness.controlCenter` (default **off**). Off: `/harness` renders
exactly as before and the four device routes answer 404 (HT-CC-01).

## 1. What it does

| Terminal | Control Center | Runs on the computer as |
| --- | --- | --- |
| `kriya run --mode <m> [switches] "<job>"` | New task: folder, mode (Ask, Auto, Read only, Plan, Full access), Loop v2, Turn budget, Context anchor, Browser | `kriya run` with the same flags, in the offered folder |
| `kriya doctor` | Run health check | the same `doctor()` routine; each check with its fix |
| `kriya rules confirm|dismiss <n>` | Learned rules: Confirm rule / Dismiss | `confirmRule` / `dismissRule` in that folder |
| `kriya handoff ["note"]` | Handoff to cloud | `kriya handoff` in that folder |
| `kriya pull [id]` | Pull to computer | `kriya pull` in that folder |
| `kriya serve <folder>` | Remote worker: Serve / Stop serving | `kriya serve <folder>` while it's on |
| `kriya usage` | Usage this month (meter against the plan's cap) | read in Kriya; nothing runs |
| any `kriya`, `kriya run`, `kriya acp` | Activity: "From the terminal" with mode, switches, folder and state | broadcast by the launcher |

## 2. Decisions (CC-D1…D9)

- **CC-D1 Typed actions, never commands.** Kriya queues one of eight kinds
  (`run`, `doctor`, `rule_confirm`, `rule_dismiss`, `handoff`, `pull`,
  `serve_start`, `serve_stop`), each with a strict schema
  (`DispatchPayloads` in `lib/harness/contract.ts`). There is no "run this
  command" action. A task's text reaches the agent as its prompt, never a
  shell.
- **CC-D2 Folders are the computer's to offer.** `kriya daemon` offers the
  folder it starts in and each `--folder` (real directories; never the home
  folder or a drive root; at most 50). Kriya addresses a folder by its id
  (sha256 of the real path, 16 hex); a path typed in Kriya is never used.
- **CC-D3 Escalation is set on the computer.** Full access and serving work
  from Kriya only when the daemon was started with `--allow-full-access` /
  `--allow-serve`. Kriya checks the computer's reported capabilities before
  queueing, and the daemon checks again before running. A stolen web
  session can't raise them.
- **CC-D4 Approvals unchanged.** A task in Ask mode is `kriya run` as from a
  terminal, so its approvals go to Waiting for you and the Inbox (H5); the
  daemon never answers one (HS-4).
- **CC-D5 The person queues and cancels; only the server runs.** RLS lets
  the person insert a `queued` action for their own signed-in computer (four
  columns only) and change its status to `canceled`/`canceling`; claiming,
  running, finishing and results are written by device routes after
  `authenticateDevice`, scoped by the device's person and the device.
  Statuses move only along `kriya.allowed_transitions`.
- **CC-D6 Online means polled within a minute.** An action for a computer
  that isn't listening is refused at once; a queued action expires after ten
  minutes; at most 30 actions per person per ten minutes (and the action
  rate limit of 20 a minute).
- **CC-D7 Long polling, not sockets.** The daemon long-polls
  `GET /dispatch/next?wait=25` (the approvals pattern); no new service, and
  it goes through the same host as every harness request. Bodies go
  gzip+base64 when Kriya decodes them (the firewall fix).
- **CC-D8 The terminal broadcast carries no task text.** `POST /runs`
  carries kind, mode, switches, the folder's name and state; the task
  stays on the computer (the mirror, opt-in per device, is where turns
  go). A dispatched run is linked by its action id.
- **CC-D9 One daemon, its own login.** `kriya daemon install` writes a
  launchd agent (macOS) or a systemd user unit (Linux) for the person's
  login, with the folders and flags given; `kriya daemon uninstall`
  removes it.

## 3. Data (migration `20270801000000_harness_control.sql`)

- `kriya.harness_device_state`: per device: daemon version, capabilities,
  offered folders, rules, last poll.
- `kriya.harness_dispatches`: the actions: kind, payload, status, result,
  expiry.
- `kriya.harness_runs`: what kriya processes run, one row per
  (device, local id).

Owner-only reads; no shared access. Rollback in `supabase/rollback/`.

## 4. API (device token; 404 while the switch is off)

| Route | Purpose |
| --- | --- |
| `POST /daemon/hello` | capabilities, folders, rules |
| `GET /dispatch/next?wait=0…25` | the next action (claimed) and the ones to stop |
| `POST /dispatch/{id}` | running, done, failed or canceled, with a result |
| `POST /runs` | a kriya process's state |

## 5. Not built (and why)

- WebSocket transport: long polling meets the need without a new service
  (CC-D7); revisit if many computers per person need sub-second dispatch.
- Typing a new folder in Kriya: by design (CC-D2).
- Windows service install: `kriya daemon` runs in a terminal there.
