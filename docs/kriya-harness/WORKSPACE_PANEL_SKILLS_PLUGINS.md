# Kriya Harness: workspace panel, Kriya default skills, MCP and plugins (H19)

Status: **P1 built (client, uncommitted), P2 and P3 planned** (2026-11-04).
Owner request in chat (2026-11-04), with screenshots of a coding-agent
desktop app: "the folder looking and also the file editing changes and the
browser using, and also the context window display … the background tasks …
the outputs and the context and connectors and the environment … the Kriya
default skills … the plugins … 100% compatible". Track H rules and
AGENTS.md apply in full; DSH is composed through its seams, never edited
(track H rule 5).

## 1. Owner decisions (chat, 2026-11-04)

| # | Question | Decision |
| --- | --- | --- |
| WP-D1 | Where MCP servers and plugins come from | **Registry + own (off):** the owner's reviewed registry by default; a person may add their own (including local stdio) only behind a switch that defaults off, approving each one. Needs the AGENTS.md amendment in §5.2 (wording to approve) |
| WP-D2 | How default skills present superpowers, ponytail, ECC | **`kriya-*` with credit:** curated, rewritten, renamed; each keeps "based on X by Y, licence" and the licence text in a notices file |
| WP-D3 | Delivery | **Kriya library, served:** `skills/<id>/SKILL.md` + `kriya.json`, served to the harness by `/api/harness/v1/skills`; the owner approves each version |
| WP-D4 | First phase | **Workspace panel** |

## 2. What already existed (checked in the running Web UI, 2026-11-04)

Run against the test fake Kriya in a throwaway home and project
(nothing touched `~/.kriya`):

| In the screenshots | Kriya Harness Web UI before P1 |
| --- | --- |
| Folder tree, file viewer | Yes: DSH's **Workspace files** tab (right sidebar) |
| File changes | Yes: Kriya's **Changes** tab (H14 era) |
| Terminal | Yes: DSH's **New terminal** tab |
| Context and usage | Partly: the strip under the input (turns, steps, tokens, cache hits, %) |
| Background tasks | Partly: DSH's jobs control in the session header |
| Projects, folders | Yes: Kriya's **Projects** page |
| Skills | Yes: Kriya's **Skills** page (H7) |
| Environment, repository, branch, connectors in one place | **No** |
| Browser pane | **No:** DSH's `dsh-client-ui-sidebar-browser` uses Electron `webview` and is enabled only in DSH's desktop profile; it can't run in a browser tab |
| MCP servers, plugins | **No:** DSH's `dsh-mcp-client` isn't in Kriya's bundle; DSH's plugin manager is off by design ("one product", bundle comment) |

## 3. P1: the Overview tab (built)

A right-sidebar tab, first in the sidebar's start list, for the open session:

| Section | Source | Notes |
| --- | --- | --- |
| Environment | `os.platform()`; session header `cwd`; read-only git (`rev-parse`, `config --get remote.origin.url`) | Remote parsed to host and path; a user name or token in the URL never leaves `src/overview.js` (WP-OV-01, -03) |
| Context | DSH token meter projections (`contextPressure`, `tokenUsage`) via `ctx.sessionProjections.snapshot` | The same figures as the strip; live sessions only ("Open this session to measure") |
| Changes | `src/changes.js` `listChanges` (the Changes tab's own reader) | First 8 files, `+/−` |
| Background tasks | `ctx.jobs.list(sessionId)` (owner-scoped by DSH) | Newest 20; label, age, status |
| Connectors | Signed-in Kriya host (never the token); MCP list (empty until P3) | |

Files (client repo): `plugins/overview/{index.js,client.js,package.json}`,
`src/overview.js`, `src/profiles.js` (link), `bundle/cordis.patch.yml`
(`kriya-overview` row), `expected/*.dump.yml` (one row each, reviewed),
`tests/overview.test.js` (WP-OV-01…04).

Evidence: client `npm run check` **218/218, exit 0** (pins, seams, notices,
brand ok). Browser check on the real Web UI: git project shows `example/demo
· GitHub`, `main`, `Changes · 1 sum.js +1 −1`, `10 of 262k tokens`, Kriya
connector; non-git folder shows "Not a git repository"; 1280 px dark and
light, 360 px; console clean; refresh button 44 px.

Not built in P1:
- **Browser pane:** needs a seam that DSH's Web UI doesn't have (an Electron
  webview). Options: ask DSH upstream for a web-capable browser pane, or
  show the agent's own browser sessions (track A's `kriya-browser`) as
  read-only screenshots. Neither is started.
- **Outputs** (files the agent wrote this session, separate from all
  changes): needs per-session write events; the checkpoint ref
  (`refs/kriya/checkpoints/<session>`) can supply them. Next small step.

## 3a. P1c: Progress and Preview tabs (built, 2026-11-04)

Owner in chat (2026-11-04): "how the tasks are doing, like planning … setting
a goal to verifying testing … finally reaching the goal", and the browser
pane "for the testing and reviewing … from the local host browser only";
decision: "Both, previews first".

| Tab | What it shows | Source | Tests |
| --- | --- | --- | --- |
| **Progress** | Goal → Plan → Build → Verify → Done; the verdict (Verified, Failing, Blocked, Not checked, Changed since the last pass); the confirmed check; each plan step with status, attempts and dependencies; every check run (exit code, failure class, time) | The loop's own records (`readProgress`, `planStatus`, `currentVerdict`): verified runs only, never model text (track-A rule 7) | WP-PG-01/02, WP-TAB-01 |
| **Preview** (browser stage 1) | An app on this computer in a frame, with address bar, reload, open in your browser | Loopback http(s) only; never the Web UI's own port; no user:password; `referrerPolicy: no-referrer` | WP-TAB-01/02 |

Browser check: a real loop run in the Web UI (scripted model, real
`kriya_plan`, `kriya_step`, builders and `npm test`) showed Verified, step 1
"passed on run 2", runs exit 1 → 0 → 0; Preview refused the harness's own
port and rendered `localhost:8765`; console clean. Client `npm run check`
**222/222, exit 0**.

## 3b. Browser stage 2: the agent's localhost browser (built, 2026-11-04)

Owner in chat: "Yes, build it". As built: `src/browser.js` (engine),
`plugins/browser/index.js` (tools and the view's routes), the Preview tab's
"Agent's browser" mode, switch `--browser-tools` (`KRIYA_BROWSER`, default
off; not `--browser`, which `kriya login --no-browser` already uses),
`playwright-core` 1.64.1 pinned (Apache-2.0, notices regenerated). The
worktree's `node_modules` was a link into the person's `../kriya-harness`;
it was unlinked (the link only) and installed locally, so the person's
checkout is unchanged.

Evidence: WP-BR-01…04 (engine on the installed Chrome against a fixture
page: open, read, click, type, console, network, screenshot; a link to
`https://example.com` refused before it is sent and the page kept; the view's
routes; Read only refuses acting tools), WP-BR-RUN-01/02 (real pinned DSH,
scripted model: open → read "Counter: 0" → click → read "Counter: 1" →
`https://example.com` refused; off → no `browser_*` tool). Browser check:
the Preview tab's Agent's browser showed `localhost:8765` from the headless
Chrome, a click in the view changed the page; console clean; no Chrome left
running after stop. Client `npm run check` **228/228, exit 0**;
`release:check` ok.

Found only by the browser check: the view's routes first registered
through `ctx.get("connection")`, which is empty at start, so they answered
404; fixed with `ctx.inject(["connection"], …)`. No automated test covers
the route wiring on the real Web UI yet.

Limits: one browser and page per harness process, shared by all sessions;
screenshots reach the model only when its route declares image input
(otherwise the tool says so and points to `browser_read`); the view polls
frames (about 2.5 per second), not a CDP screencast; needs Google Chrome.

### Design (as planned)

So the agent can test and review a local app as it builds it:

1. **Engine** (`src/browser.js`): `playwright-core` (Apache-2.0, exact pin,
   notices) driving the Chrome already installed (`channel: "chrome"`, no
   browser download), headless, its own profile in `~/.kriya/browser/`, one
   per harness process, closed on exit.
2. **Localhost only:** every top-level navigation is checked by the same
   rule as Preview (loopback http(s), not the Web UI's port); others are
   aborted. Page subresources are allowed (a local app may load fonts or
   call its own APIs).
3. **Agent tools** (`plugins/browser`, behind `KRIYA_BROWSER=on`, default
   off): `browser_open`, `browser_screenshot`, `browser_read` (text and an
   element list with refs), `browser_console`, `browser_network` (reads);
   `browser_click`, `browser_type`, `browser_press` (act on the local app:
   shown as execute, so Ask mode asks). No passwords, payments or file
   uploads; no other site.
4. **Shared view:** the Preview tab gets an "Agent's browser" mode that
   streams the engine's frames (CDP screencast) and forwards the person's
   clicks, so both see and drive the same page.
5. **Tests:** a fixture page served by the test on a random loopback port;
   a navigation to a non-loopback address is refused; real DSH run with a
   scripted model opening, reading and clicking the fixture.

## 4. P2: Kriya default skills (built, 2026-11-04)

Owner in chat (2026-11-04): "default skills set should be appeared from the
Kriya Harness team … so that any new one can download and activate it
immediately".

**As built.** Ten skills in `skills-harness/` (`SKILL.md` + `kriya.json`,
validated by the library's own `buildCatalog`), written for Kriya Harness's
tools and credited to their sources:

| Skill | Based on (all MIT) |
| --- | --- |
| `kriya-brainstorm` | superpowers brainstorming |
| `kriya-plan` | superpowers writing-plans, executing-plans |
| `kriya-tdd` | superpowers test-driven-development |
| `kriya-debug` | superpowers systematic-debugging; ECC agent-introspection-debugging |
| `kriya-verify` | superpowers verification-before-completion; ECC verification-loop |
| `kriya-lean` | ponytail |
| `kriya-review` | superpowers requesting-code-review; ponytail-review |
| `kriya-browser-test` | ECC browser-qa, e2e-testing |
| `kriya-security` | ECC security-review |
| `kriya-git` | superpowers finishing-a-development-branch; ECC git-workflow |

Licences checked: superpowers © 2025 Jesse Vincent, ponytail © 2026
DietrichGebert, ECC © 2026 Affaan Mustafa (upstream `LICENSE`, read
2026-11-04), all MIT; full texts in `skills-harness/NOTICES.md`.

**Delivery.** `lib/harness/default-skills.ts`; `deviceSkills`
(`lib/harness/skills.ts`) puts them first in `GET /api/harness/v1/skills`
for every device when the new setting **`harness.defaultSkills`** is on
(default off, track H rule 2; the owner turns it on in `/owner/config`).
The owner's `skills.disabled` applies; an assigned library skill of the
same id wins. No contract change (same fields).

**In the harness.** The Skills page lists Kriya's served skills first, in
a **Kriya default skills** group (and "From your Kriya agent" for the
account's own), read-only, tagged "from the Kriya Harness team" and their
version, with the same On / Off in this project / Off everywhere switch.
The agent already received Kriya's skills (H7, `kriya-tools`); the page
only showed local folders before.

Evidence: Kriya HT-DS-01/02 (set, credits, evals against keywords, only
real tool names; off by default, on for every device, `skills.disabled`
honoured, bodies served); client WP-SK-01/02. Browser check with the real
ten skills served by the fake Kriya: group first, read view, switch "off
everywhere" took effect ("15 on, 1 off"), console clean after reload.

Not done: measuring the set (the skill-selection eval on a real model and
KriyaBench with and without it are paid runs).

## 4a. P2 plan (as written before building)

**Sources and licences** (read from the installed copies):

| Set | Author | Licence | Check |
| --- | --- | --- | --- |
| superpowers 6.4.2 | Jesse Vincent | MIT | `LICENSE` in the installed plugin |
| ponytail 5.3.2 | DietrichGebert | MIT | `LICENSE` in the installed plugin |
| ECC (everything-claude-code) | — | **Unknown**: the installed skills carry no licence file | Verify on the upstream repository before any ECC text is used |

**Plan:**
1. Choose about 12 skills that matter for coding agents, merging overlaps
   (for example superpowers' `systematic-debugging` and ECC's
   `agent-introspection-debugging` become one `kriya-debug`).
   Candidates: `kriya-plan`, `kriya-tdd`, `kriya-debug`, `kriya-verify`,
   `kriya-review`, `kriya-lean` (ponytail), `kriya-git`, `kriya-security`,
   `kriya-refactor`, `kriya-docs`, `kriya-research`, `kriya-handoff`.
2. Rewrite each against today's Kriya: name the real tools (`kriya_verify`,
   `kriya_plan`, `kriya_step`, `kriya undo`, `kriya rules`), drop advice that
   the loop now enforces in code, keep the source's rule-of-thumb wording
   only where it is the clearest.
3. Each becomes a library skill: `skills/kriya-<name>/SKILL.md` +
   `kriya.json` with `license: "MIT"` and `source: [{ name, author,
   url, licence }]`, plus the full licence text in a notices file.
4. Served by the existing `/api/harness/v1/skills` route (H7); the harness's
   Skills page shows them as "Kriya" skills. Owner approves each version
   (WP-D3).
5. Measured, not assumed: the H7 skill-selection eval
   (`skill-eval.test.js` style) checks each is picked for its tasks and not
   for others; KriyaBench with and without the set is a paid run.

## 5. P3: MCP servers and Claude Code-compatible plugins (planned)

### 5.1 What "compatible" means here

A Claude Code plugin is a folder with `.claude-plugin/plugin.json` and any
of: skills, commands, agents, hooks, MCP server definitions. Kriya Harness
already reads SKILL.md skills (H7). P3 adds, in order:

1. **MCP client** in the harness: DSH's `dsh-mcp-client` composed through a
   bundle row, behind `KRIYA_MCP=on` (default off). Servers from the
   owner's registry (track N's `kriya.mcp_servers`, remote HTTPS, tools
   pinned by hash), delivered through a new harness API route.
2. **Person-added servers** (WP-D1), behind a second switch, default off:
   each server shown with its command or URL and approved by the person
   once; local stdio servers run under the session's sandbox policy.
3. **Plugin import:** `kriya plugins add <folder>` reads a Claude Code
   plugin's skills and MCP definitions only; commands, agents and hooks
   wait for seams (DSH presets, `dsh-hooks-claude-code`).
4. **Connectors section** of the Overview tab lists connected servers and
   their status.

Every MCP tool keeps track N's classification (`classifyMcpTool`), and R2
to R4 calls still need the person's approval of the exact call.

### 5.2 AGENTS.md amendment needed (for the owner to approve; not applied)

Track N rule 4 applies to the harness and forbids stdio servers and servers
a person types. WP-D1 needs this added under "Kriya Harness (track H)":

> 7. MCP in the harness is off by default (`KRIYA_MCP`). Servers come from
>    the owner's registry (track N rule 4). Only with a second switch that
>    defaults off (`KRIYA_MCP_OWN`) may a person add their own server,
>    including a local stdio one: the harness shows its command or URL and
>    the person approves it once; it runs under the session's sandbox
>    policy, its tools are classified by `classifyMcpTool` (never lower than
>    R2 for unknown tools), and every R2–R4 call still needs the person's
>    approval. No content, agent or server may add a server. Track N rule 4
>    otherwise applies to the harness unchanged.

## 6. Phases and exits

| Phase | Content | Exit |
| --- | --- | --- |
| P1 | Overview tab | Done: WP-OV-01…04; browser check (§3) |
| P1b | Outputs per session from checkpoint refs | Test on a fixture repo; browser check |
| P1c | Progress and Preview tabs | Done (§3a) |
| B2 | The agent's localhost browser (§3b) | Done: WP-BR-*, browser check |
| P2 | Kriya default skills | Built (§4): ECC licence settled (MIT); 10 skills with notices; served behind `harness.defaultSkills`; paid eval open |
| P3a | MCP from the registry, behind `KRIYA_MCP` | Fixture MCP server (no real site); tools classified; approvals unchanged; default-off regression test |
| P3b | Person-added servers, behind `KRIYA_MCP_OWN` | AGENTS.md amendment approved first; approval UI; sandbox test |
| P3c | Claude Code plugin import (skills + MCP) | Import of a fixture plugin; nothing else loaded |
