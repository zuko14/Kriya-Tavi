# Runbook: incidents

For anything that harms people using Kriya or their data: data exposed or
lost, a secret leaked, an agent doing something it shouldn't, the agent
browser misbehaving, payments wrong, or Kriya down. Kriya is run by a small
team, so one person (the **incident lead**, by default the owner) decides
and records; everyone else helps.

## Severity

| Level | Examples                                                                                                                                                                                           | Respond          |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| SEV-1 | Personal data exposed to someone else (another account, the public, a site); a leaked `KRIYA_TOKEN_KEY` or database credential; an agent acted outside Kriya without approval; money taken wrongly | Now, any hour    |
| SEV-2 | Kriya down or tasks failing for everyone; data lost but not exposed; a kill switch had to be used                                                                                                  | Within an hour   |
| SEV-3 | One feature broken; one person affected, nothing exposed                                                                                                                                           | Next working day |

When unsure, pick the higher level.

## First 15 minutes: contain

Every `agents.*` switch in `/owner/config` takes effect within 15 s (the
settings cache). Use the narrowest switch that stops the harm.

| Harm                                                   | Do first                                                                                                                                                                              |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent browser doing something wrong                    | `agents.browser` off; or unset `KRIYA_BROWSER_URL` on the worker (every browser tool stops)                                                                                           |
| Saved logins misused                                   | `agents.loginProfiles` off (no task loads a login); then the emergency key rotation if exposure is possible (`key-rotation.md`)                                                       |
| Connected accounts misused                             | `agents.connectors` off (GitHub, Sheets, YouTube, Instagram); for Google and Notion, unset `KRIYA_TOKEN_KEY` on the worker (no connection is offered to agents) or suspend the worker |
| Background work running away (spend, repeated actions) | Unset `KRIYA_SCHEDULES_ENABLED` on the worker; `agents.watchers` off                                                                                                                  |
| Memory being poisoned                                  | `agents.memoryV2` off; the person can pause each agent's memory                                                                                                                       |
| A kit exposing something                               | `agents.kits` off                                                                                                                                                                     |
| A shared link exposing something                       | The person revokes it (Account → Shared links), or it expires. **Gap:** share pages check no switch and the owner has no revoke; `agents.files` off stops only new shares             |
| Anything wider, or unclear                             | Suspend `kriya-worker` (no task runs). Suspend `kriya-web` only if the web itself exposes data                                                                                        |
| A secret leaked                                        | Rotate it (`key-rotation.md`, "Other secrets"); for `KRIYA_TOKEN_KEY`, the emergency rotation                                                                                         |

Write down the time and what you switched. Don't delete logs, rows or
projects: they're evidence.

## Investigate

- **What happened, to whom, since when.** Logs (structured JSON on Render;
  they don't contain message content, tokens, cookies or session state),
  `/owner/operations`, `kriya.audit_events` (every owner action), the
  affected people's tasks and tool executions (`kriya.tool_executions`,
  "What I did" receipts) and browser sessions (`kriya.browser_sessions`).
- **Owner access to content.** The owner console shows counts, statuses
  and costs, never content (S15). Reading a person's content to investigate
  needs their consent or a legal reason; record which in the incident log.
- **Personal data?** List the categories (account, messages, memory, files,
  saved logins, connections, ledger) and how many people. This decides the
  breach steps below.

## Breach intimation (personal data)

Under the DPDP Act 2023, Kriya must tell the Data Protection Board of India
and each affected person about a personal data breach. **What exactly, in
what form and how fast is set by the DPDP Rules 2025, whose text hasn't been
read yet** (RESEARCH §5: the breach provisions are phased in, reportedly
around May 2027; a 72-hour figure is reported by secondary sources and is
unverified). Until counsel confirms (GA-7, AQ-2):

1. Treat any SEV-1 with personal data as reportable.
2. Within 24 hours, tell the affected people in plain words what happened,
   what data, what Kriya has done, and what they should do (sign out other
   sessions on a site, reconnect an account, change a password they reused).
3. Ask counsel the same day whether and how to report to the Board, and
   record their answer and the time.
4. Keep a record of every breach (what, when, who was told, when), whether
   reported or not.

Contacts (owner to fill in before launch): incident lead, counsel, Supabase
and Render support, Razorpay (payments), the grievance officer named in the
privacy notice.

## Recover

- Fix the cause; deploy; turn switches back on one at a time, watching
  `/owner/operations` and the logs.
- Data lost: `restore.md`.
- Undo what agents did where possible (K3 Undo within its window, or by hand
  with the person).

## Review (within a week, for SEV-1 and SEV-2)

Write it down (in `status.md` or the incident log the owner keeps):
timeline, cause, what contained it, what people were told and when, and
what changes so it can't recur (each with an owner and a test). No blame;
facts only. If a safety rule failed (a risk class, a site mode, an R5
refusal, quarantine), add the case to AS-SEC before closing.

## Rehearse

Twice a year on staging: pick a SEV-1 scenario (e.g. "an agent posted on
GitHub without approval"), run the first 15 minutes with the switches, time
it, and record the time and any gap in `status.md`.
