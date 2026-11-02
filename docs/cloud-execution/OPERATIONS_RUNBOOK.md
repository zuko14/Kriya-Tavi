# Operations runbook (track C)

Owner procedures for cloud workspaces. Sections marked **(C8)** or **(C9)**
are completed with real commands and outputs in that phase; until then
they state the procedure and what must be verified. Never run any of this
against production before it has been rehearsed on staging.

## 1. Image build and registration (C2, C8)

1. On a machine with Docker (OB-06): `docker build -f runner/Dockerfile -t kriya-runner:<yyyymmdd> .`
2. Produce the SBOM: `syft kriya-runner:<yyyymmdd> -o spdx-json > runner-sbom-<yyyymmdd>.json`;
   keep it with the release notes (not in the repository).
3. Smoke test locally: start the container with a token and
   `--cap-add NET_ADMIN` (the runner installs its egress firewall, CD-12,
   and refuses to start without it), call `/v1/health`, `/v1/exec`
   (`git --version`, `node --version`, `rg --version`); then run the
   isolation probes (§9).
4. The provider must give the sandbox's root CAP_NET_ADMIN (iptables) and
   a pids limit; check both in its template settings before registering.
5. **(C8)** Register the image as the provider's template with the
   provider's documented command; record the template id.
6. Set `cloud.image` to the template id in `/owner/config` (staging first).
7. Monthly: rebuild for security patches; repeat 1–6; keep the previous
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

## 3. Rotating `KRIYA_WORKSPACE_SECRET` (C9, drilled)

Runner tokens are `HMAC(secret, "<workspace id>:<generation>")`, never
stored. After a rotation every existing sandbox refuses the worker; Kriya
rebuilds each workspace from Git and its checkpoint at the next generation
(C9 fix: a resumed sandbox's token is checked before use). Work after a
workspace's last checkpoint is lost, so checkpoint first.

1. `/owner/config`: `cloud.workspaces = off`. The janitor keeps running
   while any workspace is open and pauses each with a checkpoint.
2. Wait until `/owner/cloud` shows no running workspace, then check that no
   checkpoint is failing (SQL editor, read-only):
   `select count(*) from kriya.workspaces where status not in ('closed','new') and checkpoint_failed_at is not null;`
   must be `0`. Otherwise fix storage first (§6) and wait one janitor
   cycle (30 s; failed checkpoints retry every 10 min).
3. New secret: `openssl rand -base64 48` (≥ 32 characters). Set it on
   **`kriya-worker` only** (Render → Environment); the web service has
   none. Redeploy the worker.
4. `cloud.workspaces = on`.
5. What happens next, by itself: a task that resumes an old sandbox logs
   `workspace token refused; rebuilding` and restores it at generation
   + 1; an idle one past `cloud.pausedHours` has `provider_ref` cleared by
   the janitor instead of a failed checkpoint. The janitor's reconcile
   (every 10 min) destroys the old sandboxes nobody owns any more.
6. Verify on staging: open one existing workspace from a task; the reply
   says it was restored; within 10 min the provider console lists no
   sandbox from before the rotation.

Drills: `tests/cloud/recovery.test.ts` "Runbook §3" (a resume after the
rotation, and the janitor after it); both fail without the C9 fix.

## 4. Rotating the provider key

Create the new key in the provider console; replace it on the worker;
redeploy; revoke the old key; confirm `/owner/cloud` loads and one
workspace resumes.

## 5. Cost runaway or orphaned sandboxes (C9)

What the janitor does on its own (`workspaceJanitor`, every scheduler poll,
30 s, in `kriya-worker`; still running with `cloud.workspaces = off` while
anything is open):

| Step | Catches | When |
| --- | --- | --- |
| Orphan sweep | A session whose worker died (no heartbeat for `cloud.orphanSeconds`, default 120 s): checkpoint, pause, meter to the last heartbeat, once | Every poll |
| Idle | Paused past `cloud.pausedHours` (default 24): checkpoint, then destroy; a failing checkpoint keeps the sandbox and retries every 10 min | Every poll |
| Close | Close requested, or unused past `cloud.retentionDays` (default 14): destroy, delete checkpoints | Every poll |
| Reconcile | Sandboxes the provider runs for no open workspace row (deleted account, old generation, lost bookkeeping): destroy | Every 10 min |
| Storage sweep | Checkpoints under `workspaces/` with no open workspace: delete | Every 10 min |

Backstop: every sandbox is created with the provider's auto-stop
(`timeoutSeconds` 600) and only stays up while a task's heartbeat extends it.

1. Symptoms: provider spend rising; `/owner/cloud` running count above
   zero with no running task; `workspace … failed` errors in worker logs.
2. Immediate: `cloud.workspaces = off` (no new sandboxes; the janitor keeps
   pausing).
3. Look (read-only SQL):
   `select status, count(*) from kriya.workspace_sessions where status = 'open' group by 1;`
   and stale ones
   `select id, workspace_id, heartbeat_at from kriya.workspace_sessions where status = 'open' and heartbeat_at < now() - interval '5 minutes';`
   A stale session that stays open over two polls means the janitor is
   failing: read its error in the worker logs.
4. To shut idle sandboxes sooner: `cloud.pausedHours = 1` (they're
   checkpointed first), then put it back.
5. If the janitor itself fails: in the provider console stop every
   sandbox tagged with this deployment's `kriya_env`; `cloud.provider`
   stays set so the next reconcile can clean up.
6. Account for it: `select user_id, sum(quantity) from kriya.resource_usage where kind = 'workspace_seconds' and created_at > now() - interval '1 day' group by 1 order by 2 desc;`
   Record cause and numbers in `status.md`.

Drills: CR-5 drill 1 (`tests/cloud/recovery.test.ts`: a dead worker's
session is closed once and metered once; the retry resumes the sandbox);
CT-JAN-01…05 (`tests/cloud/janitor.test.ts`).

## 6. Provider outage

`workspace_open` and resumes fail with a plain message; the rest of Kriya is
unaffected. Optionally set `cloud.workspaces = off` to remove the tools
until the provider recovers. No data is lost: checkpoints are in Supabase
Storage.

## 7. Deleting a person's code (request or account closure) (C9)

**Account closure** (the person's `auth.users` row is deleted): rows go by
cascade (`kriya.workspaces`, `kriya.workspace_sessions`); usage rows in
`kriya.resource_usage` stay with `user_id` set to null (billing history,
no content). The rest is the janitor's, within 10 minutes: the reconcile
destroys every sandbox whose workspace row is gone, and the storage sweep
deletes `workspaces/<user_id>/…` checkpoints (up to 1 000 objects a pass).

**A request without closing the account:**

1. `/owner/cloud`: note the person's workspace ids.
2. Ask the person to close them in the thread strip, or, with the owner's
   approval, request the close in SQL (the person's only write column):
   `update kriya.workspaces set close_requested_at = now() where user_id = '<user id>' and status <> 'closed';`
3. The janitor destroys each sandbox and deletes its checkpoints, then
   marks it `closed` (next poll).

**Verify, either way** (read-only):

- `select count(*) from kriya.workspaces where user_id = '<user id>' and status <> 'closed';` → `0`
- `select count(*) from storage.objects where bucket_id = 'kriya-files' and name like 'workspaces/<user id>/%';` → `0`
- The provider console lists no sandbox with those workspace ids.

Record the request, the time and the three results in `status.md`
(ids only). Drill: CT-JAN-04 (`tests/cloud/janitor.test.ts`).

## 8. Deploying the worker while long tasks run

A deploy releases running tasks and each release uses one of the task's
attempts (CF-04). Prefer deploying when `/owner/operations` shows no long
task; running sandboxes are paused (not lost) and resumed by the next
attempt.

## 9. Drills (C9, recorded in `status.md`)

Automated drills run in `npm test` (PGlite, the real runner in-process
behind the fake provider). The staging rows need the owner (CB-05).

| Drill | Pass | Where |
| --- | --- | --- |
| Kill the worker mid-command | The command stops with its caller; no other attempt can open the workspace while the dead session is open; the janitor closes it once (`orphan`), checkpoints and pauses; metered once; the retry resumes the same sandbox and generation, nothing duplicated | `recovery.test.ts` drill 1 |
| The sandbox died with the worker | The retry rebuilds at generation + 1 from the checkpoint; the old token is refused (401) | `recovery.test.ts` drill 1 |
| Destroy the sandbox mid-task | The running command and later calls return errors (no success); the end sets `checkpoint_failed_at`; the janitor clears the lost `provider_ref`; the next task restores the last checkpoint (later work is lost, CS-14) | `recovery.test.ts` drill 2 |
| Storage fails before a publish | Nothing reaches GitHub; the workspace is marked and kept with the approved change set intact; once storage is back the same change set publishes once | `recovery.test.ts` drill 3 |
| Rotate `KRIYA_WORKSPACE_SECRET` | §3 | `recovery.test.ts` "Runbook §3" |
| Switch off with running workspaces | All paused within one janitor cycle | CT-JAN-05 |
| Isolation probes | CT-ISO-01, -03…-08 and fail-closed on the real image (14) | `isolation.test.ts`, `KRIYA_ISO_TARGET=docker` |
| The same on staging, and CT-ISO-01…08 on the chosen provider (CR-2) | As above | Owner: CB-02, CB-05 |
| Rollback migration on a staging copy | DATA_MODEL §8 order works; usage rows exported first | Owner |

Run the isolation probes against the image on a machine with Docker:

```bash
docker build -f runner/Dockerfile -t kriya-runner:c9 <a folder holding only runner/>
KRIYA_ISO_TARGET=docker KRIYA_ISO_REPORT=screenshots/cloud-execution/C9/isolation-docker.json \
  npx vitest run tests/cloud/isolation.test.ts
```

and against the chosen provider (owner-approved, paid; with the worker's
provider settings): `KRIYA_ISO_TARGET=provider`. The build context needs
only `runner/` and `browser/egress.ts`.
