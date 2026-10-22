# Visual baseline (P-3), every `agents.*` and `operator.*` switch off

Taken 2026-10-22 on the local Supabase stack with the stub model (UI_VERIFICATION.md §5),
signed in as the local test owner `asha@example.com`. Files are
`NN_<screen>_<viewport>_<theme>.png`; viewports 360×800 and 1280×800, light and dark.

| NN    | Screen                           | Note                                                                    |
| ----- | -------------------------------- | ----------------------------------------------------------------------- |
| 01–04 | Home                             |                                                                         |
| 05–08 | A thread with one stub reply     |                                                                         |
| 09–12 | Inbox                            | Not found: the Inbox is off with `agents.inbox` off                     |
| 13–16 | Account                          |                                                                         |
| 17–20 | Tasks                            |                                                                         |
| 21–24 | Usage                            |                                                                         |
| 25–28 | Owner overview (`/owner`)        |                                                                         |
| 29–32 | `/settings`                      | Redirects to Account, as before (`operator.mandates` off)               |

Checks on all 32: console errors 0, failed requests 0, no horizontal scroll at 360, unnamed
controls 0. Undersized touch targets at 360, all in existing screens: the logo link (103×28),
"Upgrade" (49×18), Account's service checkboxes (20×20) and "Sign out of this device" (137×20),
the not-found "back home" link (102×32), the thread header's agent button (128×38).
