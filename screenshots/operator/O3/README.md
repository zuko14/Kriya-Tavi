# O3 browser verification (2026-10-22)

Local Supabase stack, stub model (`tests/operator/verify-scripts/op-propose.json`), web,
worker with `KRIYA_SCHEDULES_ENABLED=1`. Switches on: `agents.inbox`, `agents.goals`,
`operator.mandates`. Test people: `asha@example.com` (owner) and `ravi@example.com`.

| File                                   | Shows                                                                     |
| -------------------------------------- | ------------------------------------------------------------------------- |
| 00_thread-proposal_1280_dark           | The agent's `mandate_propose` call in the thread and its reply            |
| 01–04 inbox-proposal                   | "Jobs to review" with the job card, badge 1 (360/1280, light/dark)       |
| 05_mandate-card-full_360_{light,dark}  | The whole card: done lines, pinned recipients, reduce-only controls       |
| 06–09 job-panel                        | Goal page with the Job panel after approval (grant lowered 6 → 5)        |
| 10–13 settings-jobs                    | `/settings` as the Jobs page (OF-15)                                      |
| 14–17 inbox-after                      | Inbox once the proposal was approved                                      |
| 18–41 *-on                             | Home, thread, Account, Tasks, Usage, `/owner` with the switches on        |
| 42_job-panel-full_360_{light,dark}     | Whole Job panel                                                           |
| 43_settings-jobs-full_360_{light,dark} | Whole Jobs page                                                           |
| 44_job-paused_360_light                | After Pause                                                               |
| 45_job-ticked-grant-revoked_360_light  | After Resume, Mark done and revoking the grant                            |
| 46_isolation-other-person-job_360_dark | Ravi opening Asha's job: not found                                        |
| 47/48 stop-all                         | Stop all: confirm dialog, then "No jobs are running"                      |

Checks (every battery screen): console errors 0, failed requests 0, no horizontal scroll at
360, unnamed controls 0; new controls all ≥ 44 px tall and named after what they change.
