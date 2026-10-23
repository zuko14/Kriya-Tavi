# Design system: target spec

The rules every screen follows after the upgrade. Tokens live in
`app/globals.css` and primitives in `components/ui/`. Nothing on a screen may
use a raw pixel size, radius or shadow that isn't listed here. A lint rule
enforces this (U1).

Principle: **quiet chrome, loud content, one way to do each thing.**

## 1. Typography

Two families only.

| Family | Use |
| --- | --- |
| Inter (variable, `font-feature-settings: "cv11","ss01","tnum"` for numbers) | All UI text. |
| Fraunces | Page titles (`display` and `title` steps) and the call-result headline only. Never body, never buttons. |

JetBrains Mono stays for code blocks only. **Drop Geist.** `label-mono` becomes
Inter 12/16 medium with `tracking-wide` (sentence case by default; caps only
for the section header of a list).

Scale (size / line-height, Tailwind name):

| Token | Size | Use |
| --- | --- | --- |
| `text-display` | 32/38 (28/34 < 640 px) | Home greeting, page H1 |
| `text-title` | 22/28 | Card headline, dialog title |
| `text-heading` | 16/24 semibold | Section heading, list-row title |
| `text-body` | 15/24 | Messages, paragraphs |
| `text-ui` | 14/20 | Buttons, inputs, nav, row subtitles |
| `text-meta` | 12/16 | Timestamps, counts, captions |

Six steps. Every `text-[N px]` in `components/` and `app/` maps to one of these.

## 2. Space, radius, elevation

- Space: the 4 px Tailwind grid only. Card padding 16 (mobile) / 20 (desktop).
  Section gap 32. Row gap 8.
- Radius: **3 values.** `--radius-sm` 8 px (chips, inputs, small buttons),
  `--radius-md` 12 px (buttons, rows, popovers), `--radius-lg` 16 px (cards,
  dialogs, composer). `rounded-full` only for avatars, toggles and status dots.
- Elevation: **3 levels**, each meaningful.

| Level | Look | Use |
| --- | --- | --- |
| `flat` | background colour, 1 px `--border` | Rows, cards on the page (default) |
| `raised` | `0 1px 2px` + `0 4px 12px -4px` at 6–8% | Composer, the one hero card per screen |
| `overlay` | `0 16px 48px -12px` at 18% + backdrop | Dialogs, popovers, command palette, toasts |

**Glass (blur + rim) is allowed only on `overlay`, the mobile tab bar and the
sticky header**, where something actually scrolls behind it. Remove it from
cards, chips, inputs and buttons. Remove `gel`, `btn-liquid`, sheen and
`--gloss` gradients from buttons. Keep `.aura` behind the page, but at half
its current opacity.

## 3. Colour roles

Keep the palette and assign each colour one job:

| Role | Token | Rule |
| --- | --- | --- |
| Primary action | `--rigel` solid, cream text | One per view. |
| Accent / highlight | `--betelgeuse` | Attention only: "needs you" count, live call dot, verified-by-records chip. Never a button fill. (Today dark-mode "New task" is saffron; make it `rigel` like light.) |
| Danger | `--destructive` | Text or outline by default; solid only in the confirm dialog. |
| Success / verified | teal-soft background + check | Status only. |
| Neutral surfaces | `--background`, `--card`, `--muted` | Cards are `--card` with a border, not translucent. |

Contrast: body text ≥ 4.5:1, meta ≥ 4.5:1 (today's grey meta on cream is about
3:1; darken it).

## 4. Buttons

One primitive (`components/ui/button.tsx`) with these variants and sizes. No
screen-level button styling.

| Variant | Look | Use |
| --- | --- | --- |
| `primary` | solid `rigel`, no gradient, no inner highlight | The single main action |
| `secondary` | `--card` + 1 px border | Alternatives (Decline, Cancel, Make PDF) |
| `ghost` | text only, hover `--muted` | Toolbar, tertiary |
| `danger` | destructive text + border; solid in confirm dialogs | Stop, Delete |
| `link` | rigel text, underline on hover | Inline navigation |

| Size | Height | Use |
| --- | --- | --- |
| `md` (default) | **44 px** on touch (`pointer: coarse`), 36 px on fine pointer | Everything |
| `sm` | 32 px visual, **44 px hit area** via `::after` inset | Dense desktop rows only |
| `icon` | 44 / 36 px square, icon 20 px | Toolbars, composer |

Rules:

- Order: primary on the right on desktop. On mobile, full-width primary on top
  and secondary below, or side by side when both are short. Danger is never
  first and never next to primary without a gap.
- Dialog footer: `[Delete (ghost-danger, left)] … [Cancel] [Save]`. On mobile,
  Save and Cancel are full width and Delete moves to the dialog's overflow
  menu.
- The send button is `primary` the moment there is text, and `secondary`
  (not grey-disabled) when empty.
- Pressed state: 1 px translate and 98% scale, 80 ms. No glow.

## 5. Icons

- Lucide only. Stroke `1.75`. Sizes: 16 (inline with text-ui), 20 (buttons,
  nav), 24 (empty states). Nothing else.
- One icon per concept, listed in `components/icons.ts` (a re-export map:
  `Job`, `Approval`, `Call`, `Memory`, `Schedule`, `Verified`, …). A new
  concept gets a new entry rather than a reused icon.
- No ✨ sparkles for model tiers. Tiers are words (Everyday / Balanced /
  Expert), optionally with a 3-dot meter.

## 6. Avatars and identity

- Agents: a **monogram on a solid tint** from a fixed set of 8 role colours
  (derived from the existing palette), or a mascot pose per role pack
  (researcher, follow-ups, notes, accounts…). Replace the random gradient orbs
  (`Glyph`) everywhere. Squads: overlapping 2–3 agent avatars, not a quilt.
- Contacts (calls): initials in sans on `--muted`, not a serif letter.
- The mascot appears in: Home greeting, empty states, call status, success
  moments. Always at ≥ 32 px with a crisp asset (`public/tavi/*` at 2× sizes).
  Never in the 20 px header slot; use `LogoMark` there.

## 7. Core patterns (build once in `components/ui/`)

| Primitive | Replaces |
| --- | --- |
| `PageHeader` (title, one-line description, primary action slot) | Ad-hoc H1 + paragraph + button stacks |
| `Section` (heading in `text-heading`, optional count + action) | 67 `label-mono` eyebrows; small caps only for list group labels |
| `Card` (flat/raised, optional header/footer) | `glass`, `rounded-[20px]` and friends |
| `ListRow` (leading avatar/icon, title, subtitle, trailing meta/chevron, 56 px min) | Home job rows, Calls rows, Inbox, sidebar items |
| `StatusBadge` (neutral, live, needs-you, done, failed, verified) | "Done", "achieved", "Starts a scheduled job", ad-hoc pills |
| `EmptyState` (mascot pose, one sentence, one action, not clickable as a whole) | "Nothing waiting for you" card, blank Calls page |
| `KeyValue` (label/value grid, tabular numbers) | Activity tables, approval details |
| `Disclosure` ("Details" toggle) | Inline telemetry, raw prompts, schedule bodies |
| `Toggle` (Base UI Switch) | "on"/"off" text fields in owner config and settings |

## 8. Copy

Write for the person, not the spec. Glossary (UI word → never show):

| Show | Not |
| --- | --- |
| Job, goal | mandate |
| Permission you gave / "Allowed without asking" | grant, R2/R3, authority |
| Team | crew (or keep "crew" once, explained) |
| Check-in | schedule run |
| Steps / what I did | tool calls, model calls, tokens |
| Model: Everyday | everyday model, stub/budget |

Rules:

- Sentence case everywhere, including badges ("Achieved", not "achieved").
- Lead with the outcome: "Meets you Wed 21 at 3 PM" before "Call: done".
- No internal ids, tool names, file paths, `[verify:…]` tags or prompt text in
  any person-facing string. Verify tags are stripped in fixture titles too.
- Safety and consent copy is **not** shortened or softened: AI disclosure,
  "Nobody is called until you confirm", approval consequences, costs. Rewording
  keeps the meaning word for word and needs owner sign-off (voice rule 11).

## 9. Motion

- Durations: 120 ms (hover/press), 200 ms (enter), 280 ms (dialogs/sheets).
  One easing: `cubic-bezier(0.2, 0, 0, 1)`.
- Animate opacity and transform only. Respect `prefers-reduced-motion` (it
  already has a screenshot; keep it passing).
- One signature motion: the mascot's small "working" loop while an agent runs.
  Nothing else bounces.

## 10. Layout

- Desktop: sidebar 248 px, content max 720 px (reading) or 960 px (lists and
  tables), activity panel 320 px and closed by default for new users.
- Mobile 360 px: 16 px gutters, sticky header 56 px, tab bar 64 px plus safe
  area, primary action reachable by thumb (bottom sheet or FAB on list pages).
- Status bar (desktop only): plan usage and cost as one quiet item
  ("6 of 20 tasks today · ₹0.00"). Connection state shows only when broken.
  Notifications prompt moves to Account.
