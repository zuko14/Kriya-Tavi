# Developer cockpit: the harness's Developer tab and provider tools

Owner decisions, 2026-11-24 in chat (`status.md`):

- **connectors through each provider's own CLI first**; remote MCP servers
  that sign in on the device come later, as their own phase;
- this phase builds the GitHub panel, connections, running servers, project
  health and a UI/UX polish pass;
- for Supabase and Render, **reads are free and writes need approval**.

It builds on `upgrade_2.0/GROUNDING_AND_CONNECTORS.md` §1–3 (credentials stay
in the provider's own CLI; repository states) and keeps every rule there.

## 1. Why GitHub didn't show

There were two causes:

- The repository tools (`plugins/repo`) were off unless `kriya` was started
  with `--repo-tools`, and nothing in the Web UI said so or could turn them
  on.
- Overview only printed "No remote": the repository states and actions of
  GROUNDING_AND_CONNECTORS §3 were never built. MCP servers reach a device
  only from the owner's registry, and only if they need no sign-in; the
  registry is empty.

## 2. The Developer tab (`plugins/cockpit`, `src/cockpit.js`)

It's a right-sidebar page beside Overview, on only with the owner's
`harness.cockpit` (`GET /models` `cockpit: 1` turns on `KRIYA_COCKPIT`,
unless the person passed `--no-cockpit`).

| Section | Shows | The person can |
| --- | --- | --- |
| GitHub | Branch, changed count, remote (host/path only), the branch's pull request and its checks, committed secret files | Start a git repository (`git init -b main`, never in home or a drive root); sign in to GitHub (§3); create a **private** repository and set it as origin (`gh repo create <name> --private --source . --remote origin`, no push); turn **Repository tools** on or off |
| Connections | GitHub, Supabase, Render and Vercel: installed, version, signed in (GitHub's account name) | Copy the install command, or the provider's own login command; check again; turn **Supabase and Render tools** on or off |
| Running servers | Processes listening on TCP whose working folder is inside the project (lsof), with their ports as links | Stop one (SIGTERM, only to a pid the list shows now; never Kriya Harness itself) |
| Project health | Stack (Node and its package manager, Python, Go, Rust, Supabase, Render, Vercel), scripts, the confirmed check | Add not-yet-ignored secret files (`.env*` except examples, `*.pem`, `*.key`, `*.p12`, `*.pfx`) to `.gitignore`. Committed ones are named, with the fix, but never changed |

- **Confirmations.** Every change asks first, in an inline bar (no native
  dialog).
- **No content leaves the files.** Secret files are found by name; no value
  is read.
- **Switches.** Repository tools and Supabase and Render tools are saved per
  computer in `~/.kriya/switches.json` (mode 600). They apply at the next
  start, and a flag or variable of the person's still wins.

## 3. Credentials

- **GitHub.** "Sign in to GitHub" runs `gh auth login --web --hostname
  github.com --git-protocol https --skip-ssh-key`. It shows the one-time code
  gh prints for the person to enter on github.com, and presses Enter so gh
  opens the browser. The token stays in gh's own store. It runs one at a
  time, with a 10-minute timeout, and can be cancelled.
- **Supabase, Render and Vercel.** These CLIs ask for a code typed back into
  the terminal, so Kriya shows their login command to copy instead. Kriya
  never relays a login code.
- **Status checks.** They are fixed argv with stdin closed, prompts and
  telemetry off, and results cached for 60 s. Supabase's makes a network call.
  Render's `whoami` exit code isn't documented, so a non-zero exit reads as
  "not signed in or not checked".

## 4. Supabase and Render tools (`plugins/providers`)

They're off unless `--provider-tools` or the Developer tab's switch is on.
The output is untrusted (`FOREIGN`) and redacted.

| Tool | Runs | Kind |
| --- | --- | --- |
| `supabase_projects` | `supabase projects list -o json` (name, id, ref, region, status only) | read |
| `supabase_migrations` | `supabase migration list --local` | read |
| `supabase_migrate_local` | `supabase migration up --local` | write: the person approves; refused in Read only; Auto refuses |
| `render_services` | `render services -o json` (id, name, type, suspended, region) | read |
| `render_deploys` | `render deploys list <srv-id> -o json` | read |
| `render_logs` | `render logs -r <srv-id> --limit 1…200 -o text` | read |

- **No remote write.** No tool writes a remote or linked database, deploys,
  restarts or deletes; the test pins the exact list.
- **Render deploys** stay with `plugins/deploy` (G-RELEASE, approvals).
- **Render CLI.** The commands follow render.com/docs/cli-reference. The
  page's usage examples didn't render, so the exact invocations are
  unverified on a real Render CLI (none is installed on the verify machine).

## 5. Not built, and known limits

- **Remote MCP servers that sign in on the device** (Supabase, Render, GitHub,
  Sentry, Linear MCP from the owner's registry): the next phase, after spike
  W15 S1.
- **Push and pull request from the tab.** They stay agent tools, each asking
  first.
- **Restarting a server,** and its logs (Kriya doesn't know how an arbitrary
  process was started).
- **The "dsh web authentication required" page.** It's hard-coded in
  `dsh-client-connection` (`writeUnauthorized`), with no seam, so it stays
  until DSH offers one (HD-02: no DSH edits). It shows only when the app is
  opened without the link `kriya` prints.

## 6. Tests

- **Client:**
  - `tests/cockpit.test.js` CK-01…08 and PV-01, 02;
  - `tests/providers-run.test.js` PV-RUN-01 (real DSH: the six tools are
    offered only when on).
- **Server:** `tests/harness/cockpit.test.ts` HT-CKP-01, and HT-REG-01.
