# UX and interaction (track S: Flows)

## 1. Design audit, and which source is true

| Source | State | Used? |
| --- | --- | --- |
| `app/globals.css` | Shipping tokens: cream and deep teal (`rigel`), terracotta (`betelgeuse`), Inter, Fraunces display, Geist labels, JetBrains code, glass | **Yes: this is the truth** |
| `components/ui/*`, `components/workspace/*` | Base UI primitives, `label-mono`, `hairline-b`, `btn-liquid`, `bg-grid` | Yes |
| `tavi_design/KRIYA_AI_DESIGN_SYSTEM.md` | Describes "Clinical Depth", IBM Plex and a green-blue gradient that the app no longer uses | No: stale |
| `AGENTS.md` "rigel = Kriya indigo, betelgeuse = saffron" | The tokens are teal and terracotta now | Stale wording |
| `plugins/brand/DESIGN.md` (client) | Same palette mapped on DSH tokens | Yes, for the Graph tab |

## 2. Information architecture

One sidebar entry, **Flows** (Tools section), also in the palette and Home.

| Route | What | Phone |
| --- | --- | --- |
| `/flows` | Describe box, your flows with last run, starting points | Same, stacked |
| `/flows/[id]` | Editor: canvas, inspector, tabs **Build · Runs · Versions · Improve** | Outline, Runs, Versions |
| `/flows/[id]/runs/[run]` | Run inspector | Timeline first |

No screens for Loop Studio, Harness Studio or Evaluation Lab: a loop is a node,
harness settings are the flow's inspector, Compare is in Improve.

## 3. The canvas

The page is `bg-grid` engineering paper, already Kriya's. Nodes are drawn with a
ruler: nothing glows, nothing floats.

**Node.** Fixed 248 × 76, on an 8 px grid. Surface `--surface`, 1 px `--border`,
radius `--radius-lg`. Left: a 28 px glyph tile. Then `label-mono` type, a 13 px
medium title, one quiet line of detail (agent name, rule, "at most 3 rounds").
Only the type's glyph carries colour.

| Type | Glyph | Tint |
| --- | --- | --- |
| Start, End | Play, Flag | `foreground` |
| Agent | The agent's own avatar | `rigel` |
| Check | CheckCheck | `ok` |
| Approval | UserCheck | `betelgeuse` |
| Merge | Merge | `muted` |
| Loop | Repeat, as a region | `rigel` |
| Step | ListChecks | `rigel` |

**Direction.** Top to bottom (SD-15). A chain is one straight line.

**Ports.** 10 px dots: in on the top edge, out on the bottom. The good path
leaves from the centre, so a chain stays straight; the other way out sits at
five-sixths of the width, labelled beside its wire. An agent's unused error port
stays hidden until you hover or select. Hit areas are 26 px; only desktop drags
wires.

**Edges.** Orthogonal, 12 px corner radius, 1.5 px, arrowhead at the target.

| Port | Edge |
| --- | --- |
| `out`, `pass`, `approved`, `done` | Solid, `--muted-foreground` |
| `fail`, `declined`, `exhausted` | Solid, `--betelgeuse` at 70 %, label on the line |
| `error` | Dashed, `--destructive` |
| Data overlay on selection | Dotted `--rigel`, not selectable |
| Loop return | Drawn by the region: a quiet arc with "next round" |

**Loop region.** A rounded rectangle with a dashed `--border`, `--rigel-soft`
at 40 %, the header carrying "Up to 3 rounds · until *check*". It's a
container, so moving it moves its body.

**States.** One language in editor and run. Colour is never alone: each state
has an icon too.

| State | Marker |
| --- | --- |
| Not reached | Muted card, 60 % |
| Running | `rigel` ring, `animate-pulse-dot` dot (static with reduced motion) |
| Waiting for you | `betelgeuse` ring, hand icon, "Needs you" |
| Done | `ok` tick, duration |
| Failed | `destructive` ring, reason |
| Didn't pass | Terracotta cross. It ran, and the answer was no: a failed check, a decline, out of rounds. Never a green tick |
| Skipped | Dashed card, "Skipped" |
| Reused | Tick with a link icon: "From an earlier run" |

Taken edges go solid `rigel` during a run; dead paths fade.

**Controls.** Bottom-left zoom, fit, Tidy, in a gutter the fit keeps clear. The
minimap appears only past 12 nodes. Top bar: name, save state, sections, Run.
Add steps from the left rail: with a step selected, the new one goes after it,
in line.

## 4. Inspector

Right, 360 px, `glass-strong`, per selection:

- Title, then what the node needs, in plain words. "Limits and recovery" folds
  away retries and expiry.
- Agent: agent picker, prompt with a reference picker.
- Check: value, rule, what "pass" means, in one sentence.
- Flow (nothing selected): inputs, ₹ cap, the **bound**: "At most 7 agent runs;
  about ₹X at your plan's per-task limit".

## 5. Journeys (brief §3.4)

| # | Journey | Path | State |
| --- | --- | --- | --- |
| 1 | Beginner describes a goal | `/flows` → describe → preview → Use this → Run | Built |
| 2 | Approval process with integrations | Starting point or draw; agent uses connected accounts; per-call approvals as in chat; flow gate | Built |
| 3 | Parallel research and merge | Starting point; two agents from Start into Merge | Built |
| 4 | Custom harness, nested loops | Loop in a loop; device flow for coding | Built |
| 5 | Failed run | Run page opens on the failure; Retry, or Re-run from here | Built |
| 6 | Compare versions and roll back | Versions tab diff; Restore | Built |
| 7 | Optimise | Improve tab: moves with evidence; Compare gives a verdict | Built |
| 8 | Harness inspection | Device run page; Graph tab in the client | Built |
| 9 | Phone | Run timeline, approve at top | Built |

## 6. Accessibility

- Every node, edge and control has a name (`ariaLabelConfig`, custom labels).
- **Outline** (the same data as a list, in order, with state) is the screen
  reader and keyboard path, and the phone path.
- Keyboard: Tab through nodes, arrows move, Enter opens the inspector,
  Delete removes, `Cmd+Z`/`Shift+Cmd+Z` undo and redo.
- `prefers-reduced-motion`: no pulsing, no animated viewport.
- 44 px targets at 360 px. Canvas handles are the desktop exception; phones have
  no wire-dragging.
- Contrast from existing tokens, in both themes.
