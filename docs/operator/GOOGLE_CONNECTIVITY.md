# Google connectivity: making it live (track O, phases G1–G3)

Written 2026-10-21. Every Google fact below was read from Google's own pages
that day (§7). Every code fact was read in the repository that day.

## 1. Why the Account page says "Not available on this server yet"

The code is built and tested on fixtures (OAuth, sealed tokens, refresh,
revoke, Calendar, Gmail, Drive, Sheets, YouTube). The page shows "Not
available" when `isProviderConfigured("google")` is false
(`lib/connectors.ts`): it needs `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
**and** `KRIYA_TOKEN_KEY` on the server.

Checked 2026-10-21 (variable names only, never values):

| Where                          | `GOOGLE_CLIENT_ID` / `SECRET`                                                                                                                     | `KRIYA_TOKEN_KEY` |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| Local `.env`                   | absent                                                                                                                                            | set               |
| Local `.env.local`             | absent                                                                                                                                            | set               |
| `render.yaml` (web and worker) | declared, `sync: false`                                                                                                                           | declared          |
| Render dashboard values        | **unknown** (agents can't see them); the phone screenshot shows Google unavailable on `kriya-web.onrender.com`, so at least one is missing on web | unknown           |
| Live DB `kriya.connections`    | 0 rows                                                                                                                                            | —                 |

So going live is mostly **Google Cloud and Render setup by the owner**,
plus a small amount of code (§4).

## 2. What Google allows, and what it costs us

| Fact (Google docs, 2026-10-21)                                                                                                 | Consequence for Kriya                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| An External app in **Testing** status gets refresh tokens that **expire in 7 days** (unless only name/email/profile)           | In the pilot, every connected person must reconnect weekly. Background jobs fail on day 8 unless the person reconnects (§4.2)                          |
| Testing status is limited to **100 test users** listed on the consent screen                                                   | Fine for the O10 pilot                                                                                                                                 |
| Unverified apps in production: **100 new users in total**, for the project's lifetime, after the unverified-app screen         | Never publish unverified; go from Testing straight to verified (G3)                                                                                    |
| `gmail.readonly`, `gmail.compose`: **Restricted**. `gmail.send`: Sensitive                                                     | Reading mail and saving drafts (what Kriya does today) need a **security assessment** before public use, because Kriya handles the data on its servers |
| `drive.readonly`, `drive`, `drive.metadata.readonly`: **Restricted**. `drive.file`: **Non-sensitive** (with the Google Picker) | Searching the whole Drive is Restricted; working only on files the person picks is Non-sensitive                                                       |
| `calendar.events`: the Calendar page doesn't classify it                                                                       | **Unknown**: read its class in the Cloud console's scope list when adding it (G1 step 3) and record it in `status.md`                                  |
| Max 100 refresh tokens per Google account per client id                                                                        | Irrelevant at our scale; reconnects replace the old token                                                                                              |

## 3. Plan

| Phase | Name                        | Who does it                                                | Result                                                                                                                                                  |
| ----- | --------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1    | Google live in Testing mode | Owner (console, Render) + agent (small code, verification) | The owner and up to 100 listed testers connect real Google accounts on staging; Calendar, Gmail drafts and Drive reads work; a dead token is visible    |
| G2    | Google actions v2           | Agent                                                      | Import Drive PDFs/Word files into Kriya files; share a Drive file with a person (exact approval, undo); optional Gmail send of a reviewed draft (OD-16) |
| G3    | Verification for public use | Owner + Google + an assessor                               | Brand and sensitive-scope verification; restricted scopes either assessed or replaced (OD-15)                                                           |

### 3.1 G1 owner checklist (Google Cloud console and Render)

Each step's result is written into `status.md` (no ids or secrets, just
"done" with the date).

1. Create (or pick) a Google Cloud project for Kriya Tavi. Enable the
   Gmail API, Google Calendar API and Google Drive API (and Sheets API if
   `agents.connectors` or `google.sheets` will be on).
2. OAuth consent screen: User type **External**; publishing status
   **Testing**; app name "Kriya Tavi"; support email; developer contact.
3. Scopes: add exactly what `lib/connectors.ts` requests: `openid`,
   `email`, `…/auth/calendar.events`, `…/auth/gmail.readonly`,
   `…/auth/gmail.compose`, `…/auth/drive.readonly` (plus
   `…/auth/spreadsheets` if A8 or `google.sheets` is on, `…/auth/youtube.readonly`
   only if A8 is on).
   Record the class the console shows for each (closes the
   `calendar.events` unknown).
4. Test users: the owner's Google account and each pilot tester (≤ 100).
5. Credentials → OAuth client ID → Web application. Authorised redirect
   URIs, exactly:
   - `https://<the KRIYA_APP_URL host of staging>/api/connect/google/callback`
     (the route builds `${appUrl()}/api/connect/google/callback`);
   - `http://127.0.0.1:6796/api/connect/google/callback` (local
     verification, UI_VERIFICATION.md).
6. Render: set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` on **both**
   `kriya-web` (connect, callback, Account page) and `kriya-worker` (tool
   calls and refresh). Confirm `KRIYA_TOKEN_KEY` is set on both with the
   **same** value. Redeploy both.
7. Locally (for verification only): put the same two values in
   `.env.verify` (git-ignored, UI_VERIFICATION.md §2), never in `.env` or
   `.env.local`, never in chat or `status.md`.

### 3.2 G1 agent work (code, behind no new switch: it only adds visibility)

| Change                                                                                                                                                                                                                                                           | Files                                                                                                                                                                       | Test     |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| **Readiness lines** for Google: client id and secret present on this service; token key present; `KRIYA_APP_URL` is https in production. Names only                                                                                                              | `lib/readiness.ts` (`configChecks`)                                                                                                                                         | OT-G1-01 |
| **Connection health, derived** (no change to `kriya.connections`, which is protected): a connection is "needs reconnect" when its provider's latest tool execution for this person failed with the `reconnect()` message **after** the connection's `updated_at` | new `queries/connections.ts`; `app/(workspace)/account/page.tsx`, `components/account/connections.tsx` (a "Reconnect" state and button that runs the existing connect flow) | OT-G1-02 |
| **Inbox line** "Google stopped working: reconnect to keep your jobs running" when an active mandate's thread had that failure (behind `operator.mandates`)                                                                                                       | `queries/inbox.ts` (O3 rows already allow it)                                                                                                                               | OT-G1-03 |
| **Testing-mode note** on the Account card while the app is in Testing: "Google asks you to reconnect every 7 days during the pilot". Shown when setting `google.testingMode` = `on` (new setting, default `off`)                                                 | `lib/config.ts`, `components/account/connections.tsx`                                                                                                                       | OT-G1-04 |

### 3.3 G1 verification (live, with the owner present)

1. Agent: `npm run readiness` on staging config shows the Google lines
   green (output pasted, names only).
2. Agent, on the **isolated local stack** (UI_VERIFICATION.md) with the
   owner's go-ahead: Playwright opens Account at 360 px, "Connect Google"
   is enabled, clicking it reaches Google's consent page (screenshot). The
   **owner** signs in and consents; an agent never types a Google password
   (track-A rule 4).
3. Back on Account: Google shows the account email and the three services
   (screenshot). Disconnect revokes and the row is gone (query count only).
4. With the owner's go-ahead for real Google reads (free) and the stub
   model (UI_VERIFICATION.md §4, no model cost): one task each runs
   `calendar_events`, `gmail_search`, `drive_search`; tool executions
   `succeeded`; nothing written to the account.
5. With an explicit go-ahead for a write on the owner's own account: one
   `calendar_create_event` with no attendees, approved in the Inbox,
   verified by read-back, then undone (K3) and verified gone.
6. Repeat 2–3 on staging with the owner's phone (real Android, Chrome).

**G1 exit:** steps 1–6 recorded with screenshots and dates; OT-G1-01…04
pass; `npm run check` and `npm run build` exit 0.

## 4. G2: Google actions v2

### 4.1 New tools (all in `lib/agent/tools.ts`, Google functions in `lib/connectors.ts`)

`lib/connectors.ts` is protected (track-A CHANGE_IMPACT §2). These
**additive** functions need the owner's approval at G2 start, as A8 had.

| Tool               | Class | Input                                                             | Does                                                                                                                                                                                                               | Verification                        | Undo (K3)                                          |
| ------------------ | ----- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------- | -------------------------------------------------- |
| `drive_import`     | R1    | `{ fileId }`                                                      | Downloads a PDF, Word, image or Google file (exported as PDF) up to the A5 size limit into `kriya.files` (private bucket); the A5 extraction loop reads it; `file_read` then works. Needs `agents.files` and AB-05 | `file` (row + storage object exist) | Delete the Kriya copy (person)                     |
| `drive_share`      | R4    | `{ fileId, emails: email[1..10], role: "reader" \| "commenter" }` | Adds Drive permissions. Google emails the recipients; the approval card says so. **Never grantable** (R4)                                                                                                          | `api_readback` (permissions list)   | Remove the permissions it added                    |
| `gmail_send_draft` | R4    | `{ draftId }` (a draft Kriya saved and the person saw)            | Sends that exact draft. **Only if OD-16 is approved.** Never grantable                                                                                                                                             | `api_readback` (message in Sent)    | None (sent mail can't be unsent); the card says so |

Each new tool: entry in `TOOL_CLASSES`, `TOOL_WRITES`, `SIDE_EFFECT_TOOLS`
(`drive_share`, `gmail_send_draft`), the registry (O1), `actionTitle`, the
tool-call renderer and activity label; `UndoSpec` gains
`{ kind: "drive_permissions"; fileId; permissionIds }`.

`gmail_send_draft` also needs the verifier's claim table
(`lib/agent/verify.ts`, protected) to treat "I sent …" as backed by a
verified `gmail_send_draft` run. That one-line change needs the owner's
approval with OD-16.

### 4.2 Scope strategy for Drive (OD-15)

| Mode                           | Scope                                | Class         | Agent can                                                                                |
| ------------------------------ | ------------------------------------ | ------------- | ---------------------------------------------------------------------------------------- |
| "Files I choose" (default)     | `drive.file`                         | Non-sensitive | Read, import and share **only** files the person picked with Google Picker               |
| "Search all my Drive" (opt-in) | `drive.readonly` + `drive` for share | Restricted    | Search and read everything; share any file. Needs the security assessment for public use |

**Unknown to verify first in G2:** whether a file picked in the browser
with Google Picker (Google Identity Services token client, same OAuth
client id, `drive.file`) is then accessible to the **server's** stored
token for that person. If not, "Files I choose" needs another design. G2's
first test is a manual check on the owner's account, recorded in
`status.md`. The browser never receives Kriya's stored token (invariant 4):
Picker uses its own short-lived browser token from Google.

### 4.3 Calendar "mark the date and remind me"

Already possible: `calendar_create_event` (R3) with no attendees puts it
on the person's calendar (the person approves, or a job grant with
`attendees: []` covers it). Kriya does **not** set the event's notification
fields, so the person's own Google Calendar defaults apply (OD-18). A Kriya
reminder the person asks for is a phone call through the Radar (voice rule
10), live only after voice phase 5.

## 5. G3: verification for public use (owner, Google, assessor)

1. A domain Kriya owns for the homepage, privacy policy and terms (the
   `onrender.com` host can't be verified as yours). Authorised domain on the
   consent screen.
2. Brand verification.
3. Sensitive-scope verification (`calendar.events` if sensitive,
   `gmail.send` if OD-16).
4. Restricted scopes (`gmail.readonly`, `gmail.compose`, `drive.readonly`,
   `drive`): either complete Google's security assessment with an approved
   assessor (cost and timeline: **unknown**; get a quote), or launch
   publicly without them (Calendar + "Files I choose" Drive only) and keep
   Gmail for listed testers.
5. Only then switch the consent screen to "In production".

Nothing in G3 is agent work except the privacy-policy text, which counsel
reviews.

## 6. Tests

| Id       | Proves                                                                                                                                                            |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OT-G1-01 | Readiness reports Google config by name, never by value                                                                                                           |
| OT-G1-02 | Health is "needs reconnect" only after a reconnect-class failure newer than the connection's `updated_at`; reconnecting clears it                                 |
| OT-G1-03 | The Inbox line appears only for active mandates with the failure                                                                                                  |
| OT-G1-04 | The Testing-mode note follows the setting                                                                                                                         |
| OT-G2-01 | `drive_import` stores the file privately, enqueues extraction, refuses over-size and unsupported types (fixtures)                                                 |
| OT-G2-02 | `drive_share` is R4, asks every time even inside a job with grants, verifies by read-back, undo removes only the permissions it added                             |
| OT-G2-03 | `gmail_send_draft` (if OD-16) sends only a draft id saved by Kriya in this person's account; asks every time; the verifier backs "sent" only after a verified run |
| OT-G2-04 | With `operator.*` and G2 switches off, the tool set and prompt are unchanged (OT-REG-01)                                                                          |

All on `tests/connectors/fixtures.ts`; no real Google call in `npm test`.

## 7. Sources (read 2026-10-21)

- https://developers.google.com/identity/protocols/oauth2 (7-day refresh tokens in Testing)
- https://support.google.com/cloud/answer/15549945 (100 test users; 100 new-user lifetime cap when unverified)
- https://developers.google.com/workspace/gmail/api/auth/scopes (Gmail scope classes; security assessment)
- https://developers.google.com/workspace/drive/api/guides/api-specific-auth (Drive scope classes; Picker)
- https://developers.google.com/workspace/calendar/api/auth (Calendar scopes; class not stated)
