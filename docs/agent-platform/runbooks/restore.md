# Runbook: database and file restore (GA-4)

What to do when data is lost or corrupted, and how to rehearse it. Gate
GA-4 needs one rehearsal on **staging** with RPO and RTO measured and written
in `status.md`. Never rehearse on production. Not yet rehearsed (2026-10-18).

| Term | Meaning here                                                                                     |
| ---- | ------------------------------------------------------------------------------------------------ |
| RPO  | How much recent data a restore loses: time between the last write that survived and the incident |
| RTO  | How long from "we decided to restore" to "people can use Kriya again"                            |

## What has to come back

| Data                                                                                                                                         | Where                                        | Backed up by                                                                                                                          | Notes                                                                                                            |
| -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Accounts, agents, threads, messages, memory, tasks, goals, schedules, ledger, login profiles (sealed), connections (sealed), kits, audit log | Supabase Postgres, schema `kriya` (+ `auth`) | Supabase backups (daily on paid plans; point-in-time recovery is an add-on)                                                           | **To verify on the project:** which plan, which backup kind, how far back                                        |
| Uploaded files, generated PDFs, screenshots, share snapshots                                                                                 | Supabase Storage bucket `kriya-files`        | **To verify:** whether the project's backups include Storage objects. Assume not until checked; if not, copy the bucket on a schedule | A restored database can point at objects that no longer exist; those `kriya.files` rows then fail to download    |
| Encryption key `KRIYA_TOKEN_KEY` (and `KRIYA_TOKEN_KEY_PREVIOUS` during a rotation)                                                          | Render environment (web and worker)          | The owner's password manager. **Never** in the database or a backup of it                                                             | Restored sealed values open only with the key that sealed them: restore the key that was live at the backup time |
| Settings changed in `/owner/config`                                                                                                          | `kriya.platform_settings`                    | With the database                                                                                                                     | —                                                                                                                |
| Code and configuration                                                                                                                       | Git, `render.yaml`                           | Git                                                                                                                                   | Roll back with Render's _Events → Rollback_                                                                      |

## Decide

1. Is the data actually gone, or is it a bug showing the wrong data? Check
   `/owner/operations` and the logs first; a code rollback may be enough.
2. Pick the restore point: the last moment before the damage (from logs,
   `kriya.audit_events`, task times).
3. Write down the time you decided (the RTO clock starts).

## Restore

1. **Stop writes.** Render: suspend `kriya-worker` (stops tasks, schedules,
   watchers and the janitor) and suspend `kriya-web` (there is no
   maintenance page yet; people see Render's "service unavailable"). Turn
   off every `agents.*` switch you can in `/owner/config` before suspending
   web. `kriya-browser` holds no data; leave it.
2. **Restore Postgres** into a **new** Supabase project (or a branch) from
   the chosen backup or point in time. Don't overwrite the damaged project:
   it's the evidence.
3. **Check the restored database** before pointing anything at it:
   - `DATABASE_URL=<restored> npm run db:migrate -- --status`: every
     migration `applied` (apply pending ones only if the backup predates them).
   - `DATABASE_URL=<restored> KRIYA_TOKEN_KEY=<key at backup time> npm run readiness`:
     `db.migrations`, `db.rls` and `db.anon` pass; `keys.sealed` shows the
     key ids you expect.
   - Spot checks: counts of `auth.users`, `kriya.threads`, `kriya.messages`
     close to what you expect at the restore point.
4. **Storage.** Restore or copy the `kriya-files` objects to the restored
   project's bucket. List `kriya.files` rows whose objects are missing:
   those files are lost; note them for the people affected.
5. **Point the services at it.** Set `DATABASE_URL`,
   `NEXT_PUBLIC_SUPABASE_URL` and the publishable and secret keys on web and
   worker. Keep `KRIYA_TOKEN_KEY` as it was at the backup time.
6. **Start.** Web first: check sign-in and one thread. Then the worker.
   Turn switches back on one at a time.
7. Write down when people could use Kriya again (RTO) and the restore point
   (RPO).

## After

- Tell the people affected what was lost (messages after the restore point,
  files whose objects were missing). If personal data was lost or exposed,
  follow `incident.md`: it may be a breach to report.
- Keep the damaged project read-only until the incident review is done, then
  delete it.

## Drill (staging only)

| Step                                                                                                                                                 | Record                     |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| Seed staging with a test account, a thread, a memory, an uploaded file, a saved login on a fixture-like test site, a connection (test accounts only) | What was seeded and when   |
| Note the time T0, then add one more message                                                                                                          | T0                         |
| Restore staging's database to a point just before that message, into a new project                                                                   | Start and end times        |
| Run the checks in Restore §3 and the Storage step                                                                                                    | `npm run readiness` output |
| Sign in, open the thread, download the file; run a task that uses the saved login and the connection                                                 | Pass/fail each             |
| RPO = T0 − restore point; RTO = decision → usable                                                                                                    | Both, in minutes           |

Record the drill in `status.md` under A11 (date, who, numbers, problems).
Repeat it after any change to backups or Storage.
