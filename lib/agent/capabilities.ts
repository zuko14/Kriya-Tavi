import { type RiskClass, TOOL_CLASSES, TOOL_WRITES } from "@/lib/agent/policy"
import { SIDE_EFFECT_TOOLS } from "@/lib/agent/tools"

// The capability registry (track O, docs/operator/ARCHITECTURE.md §4): one
// entry per classified tool. Risk, side effect and writes are read from the
// policy tables, never restated here; the rest is what those tables don't
// say. `propose_call` has no class and so no entry (OF-12); voice in-call
// tools run only in kriya-voice and aren't agent tools.

export type System = "kriya" | "web" | "browser" | "google" | "notion" | "github" | "meta"

// How a pinned input field must match a grant (DATA_MODEL §2.2)
export type Pin = "subset" | "equals"

export type Capability = {
  tool: string
  risk: RiskClass
  sideEffect: boolean
  writes: string[]
  system: System
  // How the tool checks what it did (Verification.method), "none" if it doesn't
  verification: "api_readback" | "page_check" | "file" | "none"
  // lib/undo.ts has a compensation for it (K3)
  undoable: boolean
  // A job may grant it (OD-03): R2/R3 only, and only these
  grantable: boolean
  pins?: Record<string, Pin>
}

type Facts = Pick<Capability, "system"> &
  Partial<Pick<Capability, "verification" | "undoable" | "pins">>

const kriya: Facts = { system: "kriya" }
const web: Facts = { system: "web" }
const browser: Facts = { system: "browser" }
const google: Facts = { system: "google" }
const readBack = { verification: "api_readback" } as const

const FACTS: Record<string, Facts> = {
  memory_write: kriya,
  memory_update: kriya,
  memory_forget: kriya,
  memory_search: kriya,
  web_search: web,
  web_fetch: web,
  browser_open: browser,
  browser_snapshot: browser,
  browser_click: browser,
  browser_scroll: browser,
  browser_handoff: browser,
  browser_close: browser,
  calendar_events: google,
  // Both read back what they made (OF-13, lib/connectors.ts)
  calendar_create_event: {
    ...google,
    ...readBack,
    undoable: true,
    pins: { attendees: "subset" },
  },
  gmail_search: google,
  gmail_read: google,
  gmail_draft: {
    ...google,
    ...readBack,
    undoable: true,
    pins: { to: "subset", cc: "subset" },
  },
  drive_search: google,
  drive_read: google,
  notion_search: { system: "notion" },
  notion_read: { system: "notion" },
  delegate: kriya,
  assign: kriya,
  goal_create: kriya,
  goal_update: kriya,
  schedule_create: { ...kriya, ...readBack },
  schedule_update: kriya,
  github_search: { system: "github" },
  github_read_issue: { system: "github" },
  github_read_pr: { system: "github" },
  github_comment: { system: "github", ...readBack, undoable: true },
  github_create_issue: { system: "github", ...readBack, undoable: true },
  github_label: { system: "github", ...readBack, undoable: true },
  github_open_pr: { system: "github", ...readBack },
  sheets_read: google,
  sheets_append: {
    ...google,
    ...readBack,
    pins: { spreadsheetId: "equals", range: "equals" },
  },
  sheets_update: {
    ...google,
    ...readBack,
    pins: { spreadsheetId: "equals", range: "equals" },
  },
  sheets_create: { ...google, ...readBack },
  sheets_total: google,
  youtube_stats: google,
  instagram_insights: { system: "meta" },
  instagram_publish: { system: "meta", ...readBack },
  skill_propose: kriya,
  skill_list: kriya,
  skill_run: kriya,
  ledger_list: kriya,
  ledger_draft_entry: kriya,
  invoice_draft: kriya,
  facts_lookup: kriya,
  obligation_add: kriya,
  obligation_list: kriya,
  kit_prepare: kriya,
  kit_check: { system: "browser", verification: "page_check" },
  mandate_propose: kriya,
  mandate_status: kriya,
  mandate_report: kriya,
  crew_dispatch: kriya,
  file_read: kriya,
  file_list: kriya,
  file_save_attachment: { ...google, verification: "file" },
  document_render: { ...kriya, verification: "file" },
  // G2: never grantable (R4); share reads its permissions back and can be undone
  drive_import: { ...google, verification: "file" },
  drive_share: { ...google, ...readBack, undoable: true },
  gmail_send_draft: { ...google, ...readBack },
  // Reads back that the event is gone; no pins, so never grantable
  calendar_delete_event: { ...google, ...readBack },
}

export const CAPABILITIES: Record<string, Capability> = Object.fromEntries(
  Object.entries(TOOL_CLASSES).map(([tool, risk]) => {
    const facts = FACTS[tool]
    if (!facts) throw new Error(`No capability facts for the tool ${tool}.`)
    return [
      tool,
      {
        tool,
        risk,
        sideEffect: SIDE_EFFECT_TOOLS.has(tool),
        writes: TOOL_WRITES[tool],
        system: facts.system,
        verification: facts.verification ?? "none",
        undoable: facts.undoable ?? false,
        grantable: Boolean(facts.pins),
        ...(facts.pins && { pins: facts.pins }),
      },
    ]
  })
)

export const GRANTABLE = new Set(
  Object.values(CAPABILITIES)
    .filter((capability) => capability.grantable)
    .map((capability) => capability.tool)
)

// The owner's kill list (operator.disabledTools): names, comma-separated
export const disabledTools = (setting: string | undefined) =>
  new Set(
    (setting ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean)
  )
