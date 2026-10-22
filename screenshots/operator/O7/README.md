# O7 browser verification (2026-10-22)

Local Supabase stack, stub model, web and worker (`KRIYA_SCHEDULES_ENABLED=1`). Switches on:
`agents.inbox`, `agents.goals`, `agents.ledger`, `agents.radar`, `operator.mandates`,
`operator.playbooks`, `operator.grants`, `operator.checkIns`, `operator.reports`. No Google
account and no web search key locally, so OP-COLLECT, OP-MEET and OP-COMPARE are hidden.

| File                               | Shows                                                                          |
| ---------------------------------- | ------------------------------------------------------------------------------ |
| 01_home-hand-a-job_360_light       | "Hand Kriya a job": only OP-BOOKS and OP-COMPLY (their needs are met)         |
| 03_comply-card_360_light           | The person's OP-COMPLY proposal as the usual job card in the Inbox            |
| 04_comply-job-active_360_light     | After approval, before the person's tick                                      |
| 05_comply-job-done_360_light       | Completed by the worker's review pass (taken before the chip fix below)       |
| 06–09 home-playbooks               | Home with the list (360/1280, light/dark)                                     |
| 10–13 job-done                     | The finished job's page (taken before the chip fix)                           |
| 15_job-done-fixed_360_{light,dark} | After the fix: "Done" (a person's tick is never "verified"), check-ins ended  |
| 16_books-form_{360,1280}_{light,dark} | The OP-BOOKS slot form (after removing the drafting hint that didn't apply) |

Checks on every battery screen: console errors 0, failed requests 0, no horizontal scroll at
360, unnamed controls 0. Form controls 44 px tall; the dialog's own close button is 28 px
(the shared Dialog component).
