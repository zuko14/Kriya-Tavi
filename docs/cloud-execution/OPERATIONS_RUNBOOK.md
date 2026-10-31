# Operations runbook (track C)

Owner procedures for cloud workspaces. Sections marked **(C8)** or **(C9)**
are completed with real commands and outputs in that phase; until then
they state the procedure and what must be verified. Never run any of this
against production before it has been rehearsed on staging.

## 1. Image build and registration (C2, C8)

1. On a machine with Docker (OB-06): `docker build -f runner/Dockerfile -t kriya-runner:<yyyymmdd> .`
2. Produce the SBOM: `syft kriya-runner:<yyyymmdd> -o spdx-json > runner-sbom-<yyyymmdd>.json`;
   keep it with the release notes (not in the repository).
3. Smoke test locally: start the container with a token, call
   `/v1/health`, `/v1/exec` (`git --version`, `node --version`, `rg --version`).
4. **(C8)** Register the image as the provider's template with the
   provider's documented command; record the template id.
5. Set `cloud.image` to the template id in `/owner/config` (staging first).
6. Monthly: rebuild for security patches; repeat 1–5; keep the previous
   template id for one week as rollback.

## 2. Turning it on (staging, then production)

1. Migration applied (`npm run db:migrate` with `MIGRATION_DATABASE_URL` for
   that project).
2. Worker env: `KRIYA_WORKSPACE_SECRET` (`openssl rand -base64 32`), the
   provider key. Same worker service only; the web service needs neither.
3. `/owner/config` → Cloud workspaces: provider, image, size, network,
   `cloud.costMicroUsdPerHour` from the provider's rate card for the size
   (micro-USD per hour, e.g. $0.1656/h → `165600`), `cloud.maxRunning`.
4. `/owner/config` → the plan forms (`PlanForm`): set cloud workspace
   minutes on the test plan only (the field C7 adds).
5. `cloud.workspaces = on`. Check `/owner/cloud`: zero running.
6. Publish later: connect a test GitHub repository the owner controls;
   `cloud.publish = on`.

## 3. Rotating `KRIYA_WORKSPACE_SECRET`

1. `cloud.workspaces = off`; wait until `/owner/cloud` shows no running
   workspace (the janitor pauses them with checkpoints).
2. Replace the secret on the worker; redeploy the worker.
3. `cloud.workspaces = on`. Paused sandboxes now reject the new tokens;
   `TaskWorkspace` treats that as "gone" and restores from the checkpoint
   with a new generation (CT-WS-09). Verify one restore on staging.

## 4. Rotating the provider key

Create the new key in the provider console; replace it on the worker;
redeploy; revoke the old key; confirm `/owner/cloud` loads and one
workspace resumes.

## 5. Cost runaway or orphaned sandboxes

1. Symptoms: provider dashboard spend rising, `/owner/cloud` running count
   above zero with no running tasks, janitor errors in worker logs.
2. Immediate: `cloud.workspaces = off` (the janitor keeps pausing).
3. If the janitor itself fails: `cloud.provider` stays set; in the provider
   console stop every sandbox tagged with this deployment's `kriya_env`.
4. Find the cause in worker logs (`workspace` events carry ids only);
   record it in `status.md`.

## 6. Provider outage

`workspace_open` and resumes fail with a plain message; the rest of Kriya is
unaffected. Optionally set `cloud.workspaces = off` to remove the tools
until the provider recovers. No data is lost: checkpoints are in Supabase
Storage.

## 7. Deleting a person's code on request

1. In `/owner/cloud`, find the person's workspaces (ids).
2. Ask the person to close them, or set `close_requested_at` for them
   through the owner tools that exist at that time (an owner action is a
   later addition; until then SQL on the project with the owner's approval).
3. Verify: the janitor moved each to `closed`; the provider lists no
   sandbox with those workspace ids; `kriya-files` has no objects under
   `workspaces/<user_id>/`.

## 8. Deploying the worker while long tasks run

A deploy releases running tasks and each release uses one of the task's
attempts (CF-04). Prefer deploying when `/owner/operations` shows no long
task; running sandboxes are paused (not lost) and resumed by the next
attempt.

## 9. Drills (C9, recorded in `status.md`)

| Drill | Pass |
| --- | --- |
| Kill the worker mid-task | Task resumes on another worker or fails cleanly; sandbox paused by the janitor within 150 s; no duplicate publish |
| Destroy the sandbox in the provider console mid-task | Next workspace call restores from the checkpoint; the reply says what was restored |
| Block Storage writes (wrong key on staging) | `checkpoint_failed_at` set; sandbox paused, never destroyed |
| Switch off with running workspaces | All paused within one janitor cycle |
| Rollback migration on a staging copy | DATA_MODEL §8 order works; usage rows exported first |
