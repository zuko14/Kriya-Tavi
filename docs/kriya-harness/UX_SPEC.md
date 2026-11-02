# UX spec (track H)

Kriya-side screens follow the existing design system (`app/globals.css`
tokens, `components/ui`, 44 px targets, 360 px first) and track U's copy
rules. The harness UI itself is DSH's Web UI with Kriya plugins; Kriya adds
no UI inside it in v1 beyond what plugins render through DSH's own surfaces
(approval prompts, sign-in prompts, notices).

## 1. Kriya screens

| Screen | File (phase) | Content |
| --- | --- | --- |
| Connect a device | `app/connect/device/page.tsx` (H2) | "Sign in Kriya Harness on <device name> (<platform>)?" · request time · code to compare `ABCD-1234` · agent picker ("Work as: Arjun (engineer)") · **Approve** / **Deny**. After approve: "You can close this tab and return to your terminal." Expired/used codes: plain message |
| Account → Devices | `components/account/devices.tsx` in `app/(workspace)/account/page.tsx` (H2) | List: name, platform, agent, last used, client version, mirror mode (Off / Summaries / Full, with one line each), this month's harness spend; **Rename**, **Revoke** (confirm dialog: "This device signs out immediately.") |
| Harness approval in the Inbox | `components/inbox/harness-approval.tsx`, listed by `queries/inbox.ts` (H5) | "Your laptop agent wants to run:" · tool · exact input in monospace (redacted) · folder · device · expires in · **Approve once** / **Decline** |
| Kriya Harness page | `app/(workspace)/harness/page.tsx` (owner 2026-11-02), sidebar "Kriya Harness", palette, Home | Header (Beta) with computers, sessions and this month's spend of the plan's cap · **Waiting for you**: the device approvals (the Inbox card, answered here too) · **Sessions**: mirrored device sessions (→ their thread) and open workspaces, cloud or this computer (`provider = device`) · **Your computers**: the Devices list · **Get started**: install (the owner's `harness.installCommand`, else a private-beta line), `kriya login` → Connect a device, `kriya` · **Modes** (HD-20: Ask, Auto, Read only, Plan, Full access with `--mode`) · **Commands**, each only when its switch is on · **Skills and memory** links. The Beta label and line follow `harness.releaseStage`. Only with `harness.api` on (404 otherwise) |
| Mirror thread | Existing thread view (H6) | Thread titled "<device> · <project>"; each turn's text and a compact tool list ("bash ✓ 1.2 s, edit ✓"); a label "Mirrored from Kriya Harness (summary)" |
| Usage | `app/(workspace)/usage/page.tsx` (H3) | A "Kriya Harness" line: this month's charge, cap, unpriced count |
| Owner config | `app/owner/config/page.tsx` `GROUPS` "Kriya Harness" (`harness.`) (H2) | Switches and limits |
| Owner plan form | `components/owner/forms.tsx`, `actions/owner.ts` (H3) | "Kriya Harness monthly limit (₹)" field |

## 2. The command line (client repository)

| Moment | Output |
| --- | --- |
| First run | Kriya's safety notice (HF-05) and "Run `kriya login` to connect your Kriya account." |
| `kriya login` | "Open https://<kriya>/connect/device and enter ABCD-1234 (expires in 10 minutes)." then "Signed in as <name> · working as Arjun." |
| `kriya` | "Kriya Harness (beta) is running at http://127.0.0.1:<port>" and opens the browser |
| Cap reached | "This month's Kriya Harness limit (₹500) is reached. It resets on 1 December (India time), or raise it in your plan." |
| Approval pending on phone | In DSH's approval prompt: "Waiting for your answer here or in Kriya on your phone." |
| `kriya handoff` | "Uploaded your changes (3 files) on top of a1b2c3d. Follow it on your phone: <link>" |
| `kriya pull` | "Applied the workspace's changes on branch kriya/pull-7f3a." |

## 3. Browser checks (H2, H3, H5, H6)

Isolated stack only (`docs/operator/UI_VERIFICATION.md`), 360×800 and
1280×800, light and dark: connect page (approve, deny, expired), Devices
list (rename, revoke), Inbox harness approval, mirror thread, usage line,
owner group and plan field. Screenshots in `screenshots/kriya-harness/<phase>/`.
