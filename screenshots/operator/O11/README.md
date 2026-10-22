# O11 crew execution: browser verification (2026-10-22)

Isolated P-3 stack only: local Supabase (Postgres 17, migration
`20261201000100` applied locally), `verify:guard` OK, stub model on 6797
(session scripts: the repo's `op-crew-*.json` plus a session-only
`op-crew-dispatch.json` naming the seeded agent ids), `next dev` on 6796,
worker via `npx tsx worker/index.ts`. Signed in as the local test person
"Asha". The squad (Meera leads, Ravi, Mira) was seeded in the local
database; everything O11 touches was driven through the UI.

| File                                     | Shows                                                                                       |
| ---------------------------------------- | ------------------------------------------------------------------------------------------- |
| `01_crew-card_1280_dark.png`             | Job thread after the lead's `crew_dispatch` (collapsed card); part threads not in the list |
| `02_crew-card-open_1280_dark.png`        | The crew card: each member · key, its brief, a link to its part thread                     |
| `03_job-panel-crew_1280_dark.png`        | Job page: "Crew · round 1", Ravi "Needs your approval", Mira "Done", Stop crew, 1 waiting  |
| `04_inbox-part-approval_1280_dark.png`   | The part's own approval (Ravi's schedule) in the Inbox                                     |
| `05_crew-results_1280_dark.png`          | The single join in the job thread, labelled "Crew results", with both reports              |
| `06_job-panel-crew_360_dark.png`         | Job page at 360 px, dark, both parts done                                                  |
| `07_job-panel-crew_360_light.png`        | Same, light                                                                                |
| `08_part-thread_360_light.png`           | Ravi's part thread: "Your part of a job", the approved schedule, his report                |
| `09_lead-thread-round2_360_light.png`    | A second round dispatched from the job thread at 360 px                                    |
| `10_stop-crew-confirm_360_light.png`     | The Stop crew confirmation                                                                 |
| `11_crew-stopped_360_light.png`          | After Stop crew: round 2 waiting part stopped, finished part kept, job still active        |

Checks: console errors 0, failed requests 0, no horizontal scroll at 360,
0 unnamed controls, job panel controls all ≥ 44 px, worker log 0 errors.

Open: Inbox approvals don't say "for job: … · member" yet (they show the
member); person-2 isolation in the browser not run (no second session's
password); covered by OT-CREW-10 (RLS) in `npm test`.
