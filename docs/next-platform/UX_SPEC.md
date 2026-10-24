# UX spec (next platform, track N)

Mobile first, tested at 360 px (AGENTS.md): 44 px touch targets, tokens
from `app/globals.css` (`rigel` indigo for primary, `betelgeuse` saffron
for attention, `label-mono` for small caps metadata), Base UI primitives
from `components/ui` (links as buttons need `nativeButton={false}`), Lite
mode (K10): text first. Track U's design system (`docs/ui-upgrade/`)
applies; track N adds no new primitive and no new UI dependency. Every
screen answers: **What did I ask? What is Kriya doing? What does it need
from me? What proves it's done?**

People see "apps" and "delivered"; "MCP", "pin", "drift" and "re-check"
are internal words.

## 1. Delivery line on "What I did" (N2, `next.delivery`)

Added at the top of the existing card (`components/thread/what-i-did.tsx`),
nothing else on the card moves:

```
┌──────────────────────────────────────────┐
│ ● DELIVERED · checked by Kriya           │  label-mono; ● rigel
│ Added "Maths exam" to your calendar  ✓   │  existing done lines
│ Saved a draft email: "Invoice 14"    ✓   │
└──────────────────────────────────────────┘
┌──────────────────────────────────────────┐
│ ◐ PARTLY DELIVERED                        │  ◐ betelgeuse
│ Created the issue "GST rounding"     ✓   │
│ Not confirmed: "Invited Ravi"            │  existing "Not confirmed" list
│   Ran, but wasn't checked.               │
│   Kriya will check again by 4:10 pm      │  only when a re-check is due
└──────────────────────────────────────────┘
```

| Status               | Label                        | Mark           |
| -------------------- | ---------------------------- | -------------- |
| `delivered`          | Delivered · checked by Kriya | ● `rigel`      |
| `partly`             | Partly delivered             | ◐ `betelgeuse` |
| `not_confirmed`      | Not confirmed                | ○ `betelgeuse` |
| `nothing_to_deliver` | (no line)                    | —              |

- A line verified later says "Checked again at 4:06 pm ✓"; a `gone` one
  says "Was added; it's no longer there".
- The status is text, never colour alone; the mark has an `aria-label`.
- With the switch off the card renders exactly as today (NT-DLV-03).

## 2. Approval card for an app action (N5)

The existing approval card (`components/thread/tool-call.tsx`, Inbox rows)
with app details:

```
┌──────────────────────────────────────────┐
│ ASKS YOU FIRST · TRACKER (tracker.example)│  app name + domain
│ Create an item in Tracker                 │  Kriya-side description
│ Title: GST rounding bug                   │  exact input, every field
│ Team: Accounts                            │
│ This happens in Tracker, outside Kriya.   │
├──────────────────────────────────────────┤
│ [ Decline ]                  [ Approve ]  │  44 px; Approve = rigel
└──────────────────────────────────────────┘
```

- Long inputs collapse after 6 lines with "Show all" (never hidden from
  the decision: the full input is one tap away and is what is approved).
- No "always allow" control (ND-25).

## 3. Account → Apps (N6, `next.mcpConnect`)

Below the existing Connections section (`components/account/connections.tsx`
is untouched; the new `components/account/apps.tsx` renders after it):

```
APPS
┌──────────────────────────────────────────┐
│ Tracker · tracker.example     [Connect]  │
│ Reads: search items                      │
│ Asks you first: create item, comment     │
│ Uses your Tracker account                │
└──────────────────────────────────────────┘
┌──────────────────────────────────────────┐
│ Notes · notes.example   Connected ✓      │
│ Used by: All agents  [Change]            │
│ Needs reconnect  [Reconnect]             │  only when refresh failed
│ [Disconnect]                             │
└──────────────────────────────────────────┘
```

- "Change" opens a dialog with "All my agents" or a checklist of agents
  (Base UI checkbox rows, 44 px).
- A suspended app shows "Paused by Kriya" and no Connect button.
- Disconnect uses the existing confirm dialog pattern (`components/confirm.tsx`).

## 4. Owner → Apps (`/owner/apps`, N7) and Delivery (`/owner/delivery`, N2)

- **Apps**: servers (status chip, domain, review note), pinned tools (Kriya
  name, risk, idempotent, verify spec yes/no, status), **Drifted** section
  with old vs new definition side by side and "Approve new definition",
  per-server connection count and calls in 7 days (counts only).
- **Delivery**: NM1–NM10 for 7 and 30 days, n beside every rate, the
  "not priced" count beside NM6. Read-only.
- Both added to `components/owner/nav.tsx`; `/owner` is already in
  `proxy.ts` `PROTECTED`.

## 5. Agent dialog (N6)

When the person has connected apps, the agent dialog shows an **Apps**
section like Skills: each connected app with a checkbox "This agent may
use it" (writes `mcp_enablements` through `actions/apps.ts`). Absent with
the switch off.

## 6. Copy rules

- Never "Kriya did it" for something the person approved and the app did:
  "Created in Tracker after you approved".
- Never "verified" for a person's own tick; "confirmed by you" (OD-05).
- Hand-offs say who does the step: "You pay this one; Kriya will remind
  you by phone on 18 Oct" (voice rule 10).

## 7. Acceptance (NT-UI-01…03)

NT-UI-01 (N2): the delivery line at 360 and 1280 px, light and dark, every
status; the card without the switch identical to a baseline screenshot.
NT-UI-02 (N6): Apps section and dialog: no horizontal scroll at 360, every
control ≥ 44 px and named ("Disconnect Tracker"), keyboard reachable.
NT-UI-03 (N7): owner pages render with 0 console errors; a non-owner gets
the existing owner-route behaviour. Screenshots in
`screenshots/next-platform/<phase>/` with a README; results table in the
phase's Session result in `status.md`.
