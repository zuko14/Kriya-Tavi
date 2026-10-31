# UX spec (track C)

Cloud workspaces appear inside the thread the person already uses. No new
dashboard, no terminal emulator in v1, no new navigation tab. Mobile first:
360 px wide, 44 px touch targets, tokens from `app/globals.css` (`rigel`,
`betelgeuse`, `label-mono`), UI primitives from `components/ui` (Base UI;
link buttons with `nativeButton={false}`). Track U's copy rules apply
(`docs/ui-upgrade/`): plain words, no internal ids or class names.

## 1. Where things appear

| Surface | File (phase C7) | When |
| --- | --- | --- |
| Workspace strip, top of the thread | `components/thread/cloud-strip.tsx`, rendered by `thread-page.tsx` | The thread has a workspace (any status but `closed`) |
| Tool cards in the transcript | `components/thread/tool-call.tsx` (cases for `tool-workspace_*`) | Each workspace tool call |
| Activity labels | `components/workbench/activity.tsx` | Each workspace tool call |
| Approval card | Existing approval UI; content from `actionTitle` and the card case | `workspace_publish` waiting |
| Usage line | `app/(workspace)/usage/page.tsx` | Plan has `workspace_minutes > 0` |
| Owner config group "Cloud workspaces" | `app/owner/config/page.tsx` `GROUPS` (prefix `cloud.`) | Always (owner) |
| Owner page | `app/owner/cloud/page.tsx` + link in `components/owner/nav.tsx` | Always (owner) |
| Plan form field | `components/owner/forms.tsx`, `actions/owner.ts` | Always (owner) |

## 2. Workspace strip

One line, collapsible to a chip on 360 px:

```
[code icon] acme/web · main @ a1b2c3d · 3 files changed      Paused ▾
```

Expanded (tap the chip):

- Status in words: "Working now", "Paused, ready to continue", "Restored from
  the last save", "Couldn't start: <reason>".
- Changed files with +/− counts (from `workspaces.changes`), up to 10, then
  "and N more".
- "Cloud minutes this month: 42 of 300".
- **Close workspace** (secondary, destructive style) → confirm dialog
  (`components/confirm`): "Close this workspace? Its saved changes are
  deleted. Pull requests already opened stay on GitHub." → `actions/cloud.ts`
  `closeWorkspace` sets `close_requested_at`; the strip shows "Closing…".

No pause/resume buttons: compute runs only while a task runs; the next
message resumes it. Stop is the existing cancel control of the task.

## 3. Tool cards

| Tool | Collapsed (one line) | Expanded |
| --- | --- | --- |
| `workspace_open` | "Opened acme/web at main (a1b2c3d)" / "Continued the workspace" / "Restored the workspace from the last save" | Base commit, size, network ("Package registries only" / "No internet") |
| `workspace_run` | `$ npm test` · ✓ exit 0 · 14 s, or ✗ exit 1 | Monospace output (head and tail, "… 1 240 lines not shown …"), live tail while running (preliminary results), "Full log saved in the workspace" |
| `workspace_read` | "Read src/date.ts (lines 1–120)" | First lines, monospace |
| `workspace_edit` / `write` / `patch` | "Edited src/date.ts" | Small unified diff (green/red, not colour alone: `+`/`−` prefixes) |
| `workspace_search`, `workspace_list` | "Searched for parseDate (12 matches)" | Matches as path:line |
| `workspace_changes` | "3 files changed, +24 −6" | File list with counts; diff collapsed per file |
| `workspace_publish` | Approval: "Open a draft pull request in acme/web: “Fix date parsing”" | Branch `kriya/fix-date`, base `main`, the files and counts from the change set, consequence line: "Kriya will create this branch and a draft pull request on GitHub as you. Nothing is merged." Buttons: Approve / Decline (existing). Done: link to the PR, "Checked on GitHub: the draft pull request is open." |

Output is never rendered as HTML; long lines wrap; horizontal scroll only
inside the code block, never the page.

## 4. Copy rules

- Say "cloud workspace", "saved changes", "paused"; never "sandbox",
  "provider", "runner", "generation", "microVM" to the person.
- A test result is described only from the card's exit code.
- Minutes used up: "This month's cloud workspace minutes are used up. They
  reset on the 1st (India time), or upgrade your plan."
- Busy: "Cloud workspaces are busy right now. Try again in a few minutes."

## 5. Owner page `/owner/cloud`

Tiles (`Tile`, `Tiles` from `components/owner/ui.tsx`): running now / cap, paused, minutes this
month, platform cost this month (₹ when `fx.usdInr` and
`cloud.costMicroUsdPerHour` are set, otherwise "unpriced"). Table: person
(owner view uses ids, as other owner pages), repo, status, last active,
minutes, checkpoint size. No access to code or outputs from this page.

## 6. Browser checks (operator rule 7, C7)

On the isolated stack (`docs/operator/UI_VERIFICATION.md`), 360×800 and
1280×800, light and dark, with the `local` provider and the stub model:
strip in each status; every card collapsed and expanded; the publish
approval card; the close dialog; `/usage` line; owner page and config
group. Console clean; targets ≥ 44 px; neighbouring cards unchanged
(CT-UI-01…04). Screenshots in `screenshots/cloud-execution/C7/`.
