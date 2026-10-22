# O5 browser verification (2026-10-22)

Same stack and job as O3, plus `operator.reports` and `agents.files`, the local
`kriya-files` bucket and a local `kriya-browser` (installed Google Chrome) for the PDF.

| File                                        | Shows                                                                 |
| ------------------------------------------- | --------------------------------------------------------------------- |
| 01_thread-mandate-report_1280_light         | `mandate_report` in the job's thread (stub `op-report` script)        |
| 02_job-panel-report-ready_360_light         | "Make the report (PDF)" done, "Open the report" link                  |
| 03_handover-report.pdf                      | The generated report (before the due-date format fix; see status.md)  |
| 04–07 job-panel-reports                     | Job panel with the live verdict (360/1280, light/dark)                |
| 08_job-panel-full_360_{light,dark}          | Whole panel: "Not confirmed", "confirmed by you", Report button       |

Checks: console errors 0, failed requests 0, no horizontal scroll, unnamed controls 0.

## Report sharing (K8, owner-approved 2026-10-22)

| File                                   | Shows                                                         |
| -------------------------------------- | ------------------------------------------------------------- |
| 09_share-report-dialog_360_light       | "Share this job's report?" with what is shared and the expiry |
| 11_share-report-opened-signed-out_360  | The link opened signed out: the read-only snapshot page       |

The screenshot of the link itself was deleted so no share token is kept on disk.
