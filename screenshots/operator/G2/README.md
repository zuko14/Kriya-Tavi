# G2 Google actions v2: browser check (2026-10-22)

Isolated P-3 stack only (`verify:guard` OK, local Supabase with migration
`20261201000200` applied, stub model, `next dev` on 6796). **No request
reached Google**: the worker ran only until the share approval was
requested (an approval runs nothing) and was stopped before Undo was
clicked, so the queued reversal was never sent; it and the placeholder
Google connection (token never opened) were deleted afterwards.

Switches set in local settings: `operator.driveShare`, `agents.connectors`,
`agents.undo`. The finished share in shots 03–05 was recorded through the
real `writeEpisode` from a local seed (a verified `drive_share` run with its
undo record), since running the share itself would call Google.

| File                                      | Shows                                                                                 |
| ----------------------------------------- | ------------------------------------------------------------------------------------- |
| `01_share-approval_360_dark.png`          | The share approval in the thread: file, people, access, "Google emails each of them" |
| `02_share-approval-inbox_1280_light.png`  | The same approval in the Inbox, R4 ("Will act publicly")                             |
| `03_share-undo_1280_light.png`            | "What I did" with the verified share and its Undo button                             |
| `04_share-undo-confirm_1280_light.png`    | "Undo this? Remove the access it gave."                                              |
| `05_share-undo-queued_1280_light.png`     | After confirming: "undoing…" (the reversal is queued for the worker)                 |

Checks: console errors 0, every request to 127.0.0.1 with 2xx, no
horizontal scroll at 360, Approve/Decline 44 px. The existing "What I did"
Undo button is 24 px tall (K3 component, not changed here): recorded.
