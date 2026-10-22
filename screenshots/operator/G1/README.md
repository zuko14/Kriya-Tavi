# G1 code half: browser check (2026-10-22)

Isolated P-3 stack (`verify:guard` OK, local Supabase, `next dev` on 6796).
No Google client id on this local server, so "Connect"/"Reconnect" stay
disabled; the live sign-in is GOOGLE_CONNECTIVITY §3.3, with the owner.
Seeded locally for the check, then deleted: a placeholder Google connection
row (token never opened) and one failed `gmail_search` run in the active
job's thread with the connector's "Google access has stopped working"
message; `google.testingMode` set on in local settings.

| File                                     | Shows                                                                     |
| ---------------------------------------- | ------------------------------------------------------------------------- |
| `01_account-reconnect_360_light.png`     | Google card: "stopped working", Reconnect Google, the Testing-mode note   |
| `02_inbox-google-stopped_360_light.png`  | Inbox line naming the affected job, linking to Account → Connected accounts |
| `03_inbox-google-stopped_1280_dark.png`  | Same, 1280 dark                                                           |
| `04_account-reconnect_1280_dark.png`     | Google card, 1280 dark                                                    |

Checks: console errors 0 on these pages, failed requests 0, no horizontal
scroll at 360, Reconnect button 44 px tall at 360.
