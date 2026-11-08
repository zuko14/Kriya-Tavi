# Operations runbook (track E)

Owner procedures. Sections marked with a phase are completed with real commands
and output in that phase; until then they state the procedure and what must be
verified. Never run any of this against production before it has been rehearsed
on staging. Local runs export `.env.verify` and pass `npm run verify:guard` first
(operator rule 6).

## 1. Turning it on (ED2, ED14)

Staging first, then production.

0. **Deploy the server before any client that needs it** (FORENSIC_AUDIT §3).
1. Migration applied (`npm run db:migrate` with `MIGRATION_DATABASE_URL` for that project) (ED14).
2. Publish a runtime (§2). Set `editing.runtimeChannel`.
3. `/owner/config` → Editing Studio: `editing.studio = on`.
4. On a test device: `kriya --edit`, then `kriya edit setup`, then `kriya edit doctor`.
5. Edit a fixture. Check the report.
6. `editing.skills = on`; confirm the `kriya-edit-*` group on the Skills page.
7. Create the private bucket `kriya-edit-previews` with a 45 MiB file limit and video, image and JSON types only. Plan form: set a small preview limit on the test plan only. `editing.previews = on`.
8. On the device: turn on Remote Control, then **Allow editing from Kriya**.
9. `editing.tavi = on`. From a phone: ask a test agent for an edit; approve; watch it finish.
10. `editing.review = on` (Review Room, decision cards, notes). `editing.watchFolders = on`, and on the device `kriya edit watch <folder>`, in a folder the daemon offers (ED15).
11. Record each step's result in `status.md`.

## 2. Publishing a Media Runtime (ED2)

1. Update `lib/editing/runtime/manifest.<version>.json`: version, artifact URLs, sizes, sha256 and licence for each, and the hash-locked Python requirements (`uv pip compile --generate-hashes --only-binary :all:` for that platform). List it in `RUNTIMES` in `lib/editing/manifest.ts`. FFmpeg isn't an artifact for the alpha (EDD-06): the manifest names a minimum version and the `brew` fix.
2. For each new artifact: read its licence and record it; compute sha256 on a clean machine; add it to the notices.
3. Run `npm run test:media` on each supported platform against the new runtime.
4. Keep the previous version listed for rollback.
5. Sign it on your own machine, never on a server. The first time, `npx tsx lib/editing/sign.ts keygen <key file>` writes a private key outside every repository and prints the public key for `TRUSTED_KEYS` in the client's `src/edit/runtime/manifest.js`. Each time, `npx tsx lib/editing/sign.ts sign <key file>` prints the signature for `RUNTIMES`. Until both are in place, `kriya edit setup` refuses the runtime.
6. Owner approves; point `CHANNELS` at it, `beta` first, then `stable`.
7. Security update of FFmpeg or Chrome: same steps, within days of the upstream notice. Keep a monthly check in the owner's calendar.

## 3. Rollback

IMPLEMENTATION_PLAN §6. Fastest first: the switch. Nothing in a rollback touches
a person's footage or projects.

## 4. Support: reading a failed job

| Where | What it shows |
| --- | --- |
| `kriya edit doctor` | Runtime, encoders, hardware tier, disk |
| Studio → Report | Gates with numbers |
| `~/.kriya/edit/<id>/journal.sqlite` | Steps, attempts, typed failures; call counts with no prompts |
| `kriya edit verify <file>` | Re-measures an export against its receipt |
| `kriya edit replay <job>` | Re-runs a job from its flight recorder with no model cost |
| `/harness` | Dispatch and job status for Tavi jobs |

The person shares these only if they choose to. There is no automatic upload of
logs or footage.

| Symptom | Likely cause | Action |
| --- | --- | --- |
| "Tools aren't installed" | Runtime missing or a failed hash | `kriya edit setup` |
| Stuck at a percent | A hung step: its timeout will fire | Wait for the timeout; then read the journal |
| Words wrong | Language or accents | Correct in the transcript; check EX-04's table |
| Captions on a face | Faces layer missing | Doctor; install Standard |
| Render much slower than expected | No hardware encoder, or the Chrome path | Doctor; report the hardware tier |
| Footage offline | Moved or on an unplugged drive | Relink |
| Tavi says the computer isn't listening | Daemon or Remote Control off | Turn on Remote Control |
| Everything re-indexes | The source was re-saved, so it's a new file | Expected |
| "This project's index was damaged and set aside" | A bad disk or a crash damaged `index.sqlite`; it was moved to `index.sqlite.damaged-<ms>` (ED17) | Index the footage again; the old file holds any transcript corrections |
| An asset shows offline | The file moved or its drive is unplugged | Put it back, or relink (relinking in the Studio isn't built) |
| The cache stays under its cap | Older renders are pruned after each render (ED17) | Expected; `KRIYA_EDIT_CACHE_BYTES` sets the cap per project (20 GB) |
| Chat gets "too many answers" during an edit | Governor set too high | Check the journal's `calls`; file a bug: this must not happen (ET-GOV-02) |

## 5. Keeping platform specs true (ED13, then each release)

Safe zones, resolutions and loudness targets are data that platforms change
without notice.

1. At each runtime release, compare the tables with ffmpeg-skill's current ones and the platforms' own pages.
2. Record the date and source of each value.
3. Never write a platform's number from memory.

## 6. Model changes

The owner maps tiers in `/owner/config`. Before changing `routing.budget`:

1. Check the model takes tools and structured output; check images if frame vision is on.
2. Run bench-M with the model's recorded behaviour, and EX-08's script on staging.
3. Run the regression subset of KriyaEditBench-R, with a paid go-ahead.
4. Change staging, then production. Record the model id per run.

## 7. Incidents

| Incident | First move |
| --- | --- |
| Bad runtime release | Point the manifest back; clients pick it up at next start |
| A vulnerability in FFmpeg or Chrome | Publish a fixed runtime; set a minimum runtime version |
| Licence complaint about a bundled item | Remove it in a client and runtime update; record it |
| Preview storage abuse | `editing.previews` off; delete by `edit_deliverables`; review |
| A takedown request for a preview | Delete the object and row; the person's local files aren't Kriya's to touch |
| Model provider outage | Director pauses; hand editing continues; no action needed |

## 8. Checks the owner should keep doing

- Monthly: runtime security check; expired previews are being deleted; spend per job.
- Each release: `npm run check` in both repositories; ET-LIC-01; bench-M; `npm run release:check` and `node scripts/audit-secrets.js` on the test device (ED17).
- Before any public copy: RG-9, EG-7, EG-8.
