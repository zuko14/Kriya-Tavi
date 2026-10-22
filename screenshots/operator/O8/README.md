# O8 browser verification (2026-10-22), and the OF-18 config groups

Local Supabase stack, signed in as the local owner `asha@example.com`.

| File                                   | Shows                                                                     |
| -------------------------------------- | ------------------------------------------------------------------------- |
| 01_config-operator-group_1280_light    | `/owner/config` "Operator (jobs)" group (OF-18), with `operator.maxActive` saved as 4 through the UI (then cleared back to the default) |
| 02–05 owner-operator                   | `/owner/operator`: OM1–OM8 for 7 and 30 days, jobs by status, grants by tool, kill list |
| 06–09 owner-config                     | The whole config page with the new "Agent features" and "Operator (jobs)" groups |

Checks: `/owner/operator` console errors 0, failed requests 0, no horizontal scroll, unnamed
controls 0, no undersized targets. `/owner/config` at 360 px scrolls sideways because of the
existing "Model registry" table (517 px wide) and its Save buttons are 28 px tall (the existing
settings form); both predate this change.
