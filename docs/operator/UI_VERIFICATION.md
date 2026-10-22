# UI verification on a local server (all tracks; prerequisite P-3)

Every phase that changes a screen ends with a coding agent (Claude Code or
another with browser automation) **running the app locally and checking it
in a real browser**: the new screens, the old screens around them, phones
and desktops, light and dark, and the flows end to end. Unit tests prove
logic; this proves what the person actually sees.

## 1. The rule that comes first: never the live database

Checked 2026-10-21 (hosts only, no credentials): `.env` (`DATABASE_URL`,
`MIGRATION_DATABASE_URL`) and `.env.local` (`NEXT_PUBLIC_SUPABASE_URL`)
all point at the live Supabase project `kriya-tavi`
(`…xkechnzeeluhtv`). `npm run dev:worker` loads `.env`
(`--env-file-if-exists=.env`). So running the app locally **as it is set up
today** creates users, threads, tasks and charges **in the live
database**. AGENTS.md voice rule 3 forbids modifying production data.

Therefore:

1. UI verification runs only against an **isolated** database: the local
   Supabase CLI stack (recommended, free) or a separate staging project
   the owner names in `status.md`.
2. The agent's first command is the guard (§3). If it fails, stop.
3. Nobody edits the owner's `.env` or `.env.local`. Verification uses its
   own git-ignored file `.env.verify` (`.gitignore` has `.env.*`; checked
   with `git check-ignore`), exported into the process so it wins over every
   file (Next.js 16 load order: `process.env` first;
   `node_modules/next/dist/docs/01-app/02-guides/environment-variables.md`).

## 2. P-3: one-time setup (owner + agent)

**Owner (needs installs and accounts):**

1. Install Docker Desktop and the Supabase CLI (`brew install
supabase/tap/supabase`). On 2026-10-21 neither was available on this
   machine (`which supabase` empty; Docker not running).
2. Approve P-3 in `status.md`.

**Agent:**

1. `supabase init` if `supabase/config.toml` doesn't exist (it doesn't on
   2026-10-21); keep the migrations folder as is. Commit-ready, no secrets.
2. `supabase start`. It applies `supabase/migrations/*` in order. Record
   the printed **local** URLs (API, DB, Studio, Mailpit) in `status.md`;
   the local anon/service keys are well-known local defaults but still go
   only into `.env.verify`.
3. Write `.env.verify` with **names** from §2.1 (values: local stack,
   `http://127.0.0.1:6796`, a fresh local `KRIYA_TOKEN_KEY`, the stub model).
4. Add `scripts/verify-guard.ts` and `scripts/verify-model-stub.ts` (§3, §4)
   and two package scripts: `"verify:guard"`, `"verify:stub"`.

### 2.1 `.env.verify` (names only; never paste values anywhere)

| Name                                                               | Value source                                                                                           |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `DATABASE_URL`, `MIGRATION_DATABASE_URL`                           | Local stack DB URL from `supabase start`                                                               |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Local stack API URL and anon key                                                                       |
| `KRIYA_APP_URL`                                                    | `http://127.0.0.1:6796`                                                                                |
| `KRIYA_TOKEN_KEY`                                                  | A new local key (never the production one)                                                             |
| `OPENROUTER_BASE_URL`, `OPENROUTER_API_KEY`                        | `http://127.0.0.1:6797/v1` and `stub` (§4); a real key only with the owner's go-ahead for that session |
| `KRIYA_SCHEDULES_ENABLED`                                          | `1` when the phase needs background runs                                                               |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`                         | Only for G1/G2 checks, from the owner (GOOGLE_CONNECTIVITY §3.1 step 7)                                |
| `KRIYA_BROWSER_URL`, `KRIYA_BROWSER_SECRET`                        | Only when a phase checks the browser; local `npm run dev:browser`                                      |

Voice variables stay **unset** (no real calls; voice rule 5).

## 3. The guard: `npm run verify:guard`

`scripts/verify-guard.ts` reads `process.env` and exits 1, printing only
the reason, when any of these holds:

- `DATABASE_URL`, `MIGRATION_DATABASE_URL` or `NEXT_PUBLIC_SUPABASE_URL`
  contains the live project ref `kiyfofxkechnzeeluhtv`, or any host that
  isn't `127.0.0.1`/`localhost`, unless `KRIYA_VERIFY_STAGING_REF` names
  that exact ref and the owner recorded it in `status.md`;
- `KRIYA_VOICE_LIVE` is set, or any `EXOTEL_*` is set;
- `OPENROUTER_BASE_URL` is unset while `OPENROUTER_API_KEY` is set (would
  spend real money) and `KRIYA_VERIFY_PAID` isn't `1`.

It prints hosts with the ref masked and never prints a value. A unit test
(OT-UIV-01) covers each case. The guard runs before the web server, the
worker, `db:migrate` and `owner:grant` in every verification session.

## 4. The stub model: `npm run verify:stub`

`lib/models.ts` already reads `OPENROUTER_BASE_URL`. The stub is a small
OpenAI-compatible HTTP server on `127.0.0.1:6797` (Node `http`, no new
dependency) that answers chat completions from **scripts**:
`tests/operator/verify-scripts/<name>.json`, each a list of turns (text,
tool calls with exact inputs). The script is picked by a marker in the
person's message (`[verify:op-collect]`), so a verification session can
drive a whole job (proposal → approval → grant use → verdict) with **no
model cost** and the same result every time. It reports no `usage.cost`,
so charges come out `unpriced`, which the UI must show honestly.

Paid real-model checks happen only with the owner's go-ahead in that
session (`KRIYA_VERIFY_PAID=1`), and the cost is recorded.

## 5. A verification session, step by step

```bash
set -a; source .env.verify; set +a     # the verify values win over .env files
npm run verify:guard                    # must print OK
supabase status                         # local stack up
npm run db:migrate                      # local only (guard passed)
npm run verify:stub &                   # if the phase drives the model
npm run dev &                           # web on 127.0.0.1:6796
npx tsx worker/index.ts &               # worker with the same env (NOT npm run dev:worker, which loads .env)
```

Then, with the browser automation tools (Claude Code: the Playwright
plugin's `browser_*` tools):

1. **Accounts**: sign up two people through the UI; confirm each through
   the local Mailpit; make the first owner (`npm run owner:grant -- <local
email>`, guard passed). Turn on the phase's switches in `/owner/config`
   (records the owner path) and note which were on.
2. **Viewports**: 360×800 (phone) and 1280×800 (desktop); light and dark
   (`browser_emulate_media` colour scheme).
3. **For each screen the phase touched, and the screens next to it**:
   `browser_navigate` → `browser_snapshot` (accessible names present for
   every control) → `browser_take_screenshot` → interact
   (`browser_click`, `browser_fill_form`, `browser_type`) through the real
   flow → screenshot of each state.
4. **Checks recorded per screen** (a table in `status.md`):

   | Check                       | How                                                                                               | Pass                             |
   | --------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------- |
   | Console errors              | `browser_console_messages` (error level)                                                          | 0                                |
   | Failed requests             | `browser_network_requests` (status ≥ 400, excluding expected 401/404 tests)                       | 0 unexpected                     |
   | No horizontal scroll at 360 | `browser_evaluate`: `document.documentElement.scrollWidth <= innerWidth`                          | true                             |
   | Touch targets               | `browser_evaluate`: every visible `button, a, [role=button], input` ≥ 44×44 CSS px at 360         | 0 smaller (list any exceptions)  |
   | Labels                      | Snapshot shows a name for every control                                                           | 0 unnamed                        |
   | Dark/light                  | Screenshot both; text readable                                                                    | Reviewed                         |
   | Regression                  | Home, a thread, Inbox, Account, Tasks, Usage, `/owner` render as before (switches off **and** on) | Same as the baseline screenshots |
   | Isolation                   | Person 2 can't open person 1's job, part thread or share (expect 404)                             | 404                              |

5. **Screenshots** go to `screenshots/<track>/<phase>/` (e.g.
   `screenshots/operator/O3/`), named `NN_<screen>_<viewport>_<theme>.png`,
   with a `README.md` listing what each shows. No real names, emails or
   phone numbers on screen (use `asha@example.com` style test data).
6. **Stop everything** (`kill` the background jobs), `supabase stop` if
   the owner wants it stopped. Nothing to clean in the live database,
   because nothing touched it.

A phase with UI is `COMPLETE` only when this table is filled for every
screen it touched, or an item is recorded as open with the reason (e.g.
"real Android + TalkBack needs the owner's phone").

## 6. After the local check: staging and the real phone

When staging exists (OB-01), the owner opens the same screens on their
Android phone (Chrome) and with TalkBack; the agent records the owner's
result. Local Playwright can't replace a real device's microphone,
keyboard or screen reader.

## 7. Tests

| Id        | Proves                                                                                                                         |
| --------- | ------------------------------------------------------------------------------------------------------------------------------ |
| OT-UIV-01 | The guard refuses each case in §3 and prints no value                                                                          |
| OT-UIV-02 | The stub answers a scripted tool call in the shape `createOpenAICompatible` accepts (one runner test drives a task through it) |
