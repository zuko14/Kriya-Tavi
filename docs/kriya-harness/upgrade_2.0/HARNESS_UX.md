# The Kriya Harness interface, redesigned around proof

Part of Harness 2.0 (second round, 2026-11-23). Owner: "the colours would
be the same, but positioning and everything … top 1%". Colours, fonts and
the glass-over-cloth material stay exactly as `plugins/brand/DESIGN.md`
defines them (Paper, Leaf-sheet, Loom, Ink, Teal for action, Saffron for the
agent at work; Geist and JetBrains Mono). What changes is **what is where,
and why**.

## 1. The idea

Other screens in this category are built around the conversation. Kriya
Harness's difference is that code decides what is true (verified steps,
gates, receipts), so its interface is built around **the state of the work
and its proof**, with the conversation as the way to steer it. Three
questions must be answerable at a glance, from anywhere, at any width:

1. What is it doing right now? (the Run strip)
2. Is what it did actually true? (gate chips, the Proof track)
3. What do I need to decide? (approvals, Explore picks, "not checked")

## 2. Seams (nothing in DSH is edited)

Verified in the pinned `dsh-client-ui-layout` README (2026-11-23): a
three-column AppFrame (sidebar 264–420 px, collapses below 1024 px to a
56 px rail; centre ≥ 400 px; right column opening at 45%, capped at 70%),
global panels in the `main` keyed slot (`ctx.layout.selectPanel`), a
full-width `shell.bottom` slot whose occupant controls its height, a
`shell.overlay` slot over the frame, and `openRightbar(track, fullscreen)`.
Kriya already uses right-column tracks (Overview, Progress, Preview,
Changes) and tool presentation cards (`presentCall`). Everything below uses
only these. Seams not verified yet (sidebar sections, DSH's command UI) are
spikes in W18 and have fallbacks.

## 3. Layout

```
≥ 1280 px
┌─ Loom pane ─────┬──────────── Paper: conversation ─────────────┬─── right column ───────────────┐
│ ◆ Kriya Harness │  Plan card: goal · steps with gate chips      │ Live │ Proof │ Changes │ Project│
│ Sessions        │  ─────────────────────────────────────────── │                                │
│  • current  ●   │  messages (agent at work = saffron stitch)    │  Live: the app or the agent's  │
│ Missions (W18)  │  approval card (saffron edge, waits)          │  browser, gate overlays        │
│ Projects        │  Explore card: 3 takes → pick                 │  Proof: verdict, gates,        │
│ Skills          │                                               │  receipt, release readiness    │
│                 │  ┌ composer (thick pane, teal focus) ───────┐ │  Changes: diff + time scrubber │
│                 │  └──────────────────────────────────────────┘ │  Project: repo, connectors,    │
│                 │                                               │  capability matrix             │
└─────────────────┴───────────────────────────────────────────────┴────────────────────────────────┘
┌ shell.bottom · Run strip 44 px: Milestone 2/5 › Step 3 "Orders API" · try 3/4 · Head · ●●◐○ · 6m · ₹4.20 · Stop ┐
└────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### 3.1 The Run strip (`shell.bottom`, new plugin `plugins/runstrip`)

- Always visible while a task runs; 44 px tall; empty (0 px) when nothing
  runs, so idle sessions are unchanged.
- Left to right, in reading priority: milestone `n/q` → step number and
  title → attempt `t/4` → tier badge (**Worker** / **Head**, with the
  model's name from `/models` `name` on hover) → gate chips → elapsed →
  this task's spend (₹, the difference of the device's usage total from
  `GET /me` since the task started, read at most once per builder; labelled
  "estimated" while any request is unsettled) → **Stop**.
- Click or `⌥↑` expands it to a 240 px timeline: every attempt as a row
  (tier, failure class, gate chips, duration), so escalation and recovery
  are visible as they happen.
- Source of truth: the loop's ledger and progress files only (track-A rule
  7). The strip never shows model text as a status.

### 3.2 Gate chips (one component, used everywhere)

| State | Look (brand tokens only) | Text (always present; colour never alone) |
| --- | --- | --- |
| Waiting | Ink 45% outline | "UI · waiting" |
| Running | Saffron running stitch around the chip (static under reduced motion) | "UI · checking" |
| Passed | Teal fill, check glyph | "UI · passed" |
| Failed | Error red outline, × glyph | "UI · failed: overflow at 390 px" |
| Not checked | Ink 45% dashed outline, "–" | "UI · not checked: no dev server" |

Chips reserve their width up front (no layout shift); state changes
cross-fade in 160 ms.

### 3.3 Right column: four tracks instead of six

| Track | Replaces / joins | Content |
| --- | --- | --- |
| **Live** | Preview (+ agent's browser) | The app at the confirmed URL or the agent's browser frames; a viewport switcher (360 / 390 / 1440); gate overlays drawn on the frame (overflow box, failing contrast element, small touch target) from the gate's own evidence |
| **Proof** | Progress | Verdict banner (Verified / Failing / Blocked / Not checked / Changed since last pass); plan steps with chips and attempts; release readiness (DELIVERY §2) line by line; the receipt (DIFFERENTIATORS §1) with "Copy" and "Verify" |
| **Changes** | Changes | Diff by file; a **time scrubber** over the session's checkpoints (`refs/kriya/…`), each tick a step attempt with its verdict; "Restore this point" = `kriya undo` to that checkpoint (confirmation) |
| **Project** | Overview | Environment, repository connection states (GROUNDING §3), connectors, MCP servers, the `kriya doctor` capability matrix, house rules (confirmed v2 rules) |

DSH's Files and Terminal tracks stay as they are, after these four. Order
is fixed so muscle memory holds; Live opens first when a dev server is
confirmed, else Proof.

### 3.4 Cards in the conversation (tool presentation)

- **Plan card** (from `kriya_plan`): goal, steps with roles as small labels
  ("Database", "Frontend"), dependency hints, chips; updates in place.
- **Approval card** (existing, saffron edge): adds the exact target for
  outward actions (branch, PR base, deploy target and commit).
- **Explore card**: 2–3 takes side by side (frames from three angles for
  3D), each with its chips and the critic's notes; pick with click or
  `1`/`2`/`3`; "Keep exploring" is not offered (the bound is fixed).
- **Receipt card** at the end of a task: verdict, gate summary, cost by
  tier, "Open in Proof".

### 3.5 Mission Control (`main` panel, `plugins/missions`)

A global panel for everything running on this machine: projects ×
missions (milestone ledgers), each with its verdict, what it is waiting
for (approval, pick, not-checked decision), spend today and this month,
and the device's sign-in. The same data the phone sees in Kriya's
`/harness` Control Center (existing), so the two read alike.

## 4. Narrow widths

| Width | Behaviour |
| --- | --- |
| 1024–1279 | DSH collapses the sidebar to its rail when the right column opens; the Run strip keeps every field |
| 768–1023 | Right column opens fullscreen over the centre (DSH's own rule); the strip drops elapsed and spend into its expanded view |
| 360–767 | Strip shows step number, chips as "3/5 passed", Stop; Explore card stacks takes vertically with swipe; approval card's buttons full-width, 44 px |

## 5. States every new surface defines

Each of Run strip, Live, Proof, Changes scrubber, Project, Mission Control
and the Explore card has an explicit loading, empty, partial, error and
populated state (the frontend cartridge's own rule, applied to ourselves).
Examples: Proof empty = "No plan yet. Ask for something with more than one
step and the plan appears here."; Live error = "Nothing answers at
localhost:3000. Start your dev server, or confirm another with `kriya stack
use`."

## 6. Motion and sound

The stitch is the only decorative motion and means only "the agent is
working". Everything else moves to explain a change (chip cross-fade, the
strip expanding) in 120–240 ms with ease-out; all of it honours
`prefers-reduced-motion`. No sounds.

## 7. Accessibility

- Every target ≥ 44 px on touch widths; full keyboard path (strip
  `⌥↑`, tracks `⌥1…4`, Explore `1…3`, Stop `⌥.`); visible focus in Teal.
- Verdict changes announced in a polite live region, once per change, not
  per chip.
- Contrast: text on glass panes checked by the dogfood G-A11Y run with the
  backdrop-sampling rule (CARTRIDGES §4.3); the brand's existing
  reduced-transparency fallback stays.

## 8. How it is checked

The harness's own CI runs G-UI and G-A11Y on the Web UI with a scripted
model session that exercises every state above (DELIVERY §5), at 360 and
1440, light and dark; a browser check with screenshots is recorded in
`status.md` per phase (operator rule 7). The brand test
(`tests/brand.test.js`) keeps guarding DSH class drift; new components are
Kriya's own and don't depend on DSH's hashed classes.
