import type { EvidenceSpec, GrantTool, Pins } from "@/db/schema"
import type { Rule } from "@/lib/schedules"

// Playbooks (track O, O7; docs/operator/PLAYBOOKS.md, OD-09): common Indian
// jobs as versioned data. A playbook only fills a job proposal: the work
// prompt, default done lines, grant templates and a check-in. Its grants
// pin targets the person typed into the slots, never anything a model
// wrote. Editing one never changes an existing job (it stores the version).

export type Need =
  | "google.gmail"
  | "google.calendar"
  | "google.sheets"
  | "ledger"
  | "web"
  // obligation_add exists only with agents.radar on
  | "radar"

export type Slots = {
  invoices?: string[]
  emails?: string[]
  sheet?: { spreadsheetId: string; range: string }
  text?: string
  // A month, YYYY-MM
  date?: string
}

export type SlotKind = keyof Slots

export type Playbook = {
  id: `OP-${string}`
  version: number
  title: string
  summary: string
  // Role packs that show it (track A ROLE_PLAYBOOKS.md); not filtered on yet
  roles: string[]
  needs: Need[]
  slots: { kind: SlotKind; label: string; optional?: boolean; hint?: string }[]
  dueInDays: number
  checkIn: Rule
  // Drafted ledger entries join the job as it runs (lib/operator/loop.ts)
  growsLedger?: boolean
  fill: (slots: Slots) => {
    title: string
    prompt: string
    criteria: { text: string; evidence: EvidenceSpec }[]
    grants: { tool: GrantTool; pins: Pins; maxUses: number; why: string }[]
    subjects?: { invoices?: string[] }
  }
}

const DAILY_10 = { freq: "daily", at: "10:00" } as const
const list = (items: string[] = []) => items.join(", ")

export const PLAYBOOKS: Playbook[] = [
  {
    id: "OP-COLLECT",
    version: 1,
    title: "Get overdue invoices paid",
    summary:
      "Reminder drafts to each client, follow-ups, and a call when you approve one.",
    roles: ["FL-05", "FD-03"],
    needs: ["google.gmail", "ledger"],
    slots: [
      { kind: "invoices", label: "Overdue invoices" },
      {
        kind: "emails",
        label: "The clients' email addresses",
        hint: "Kriya may only draft to these addresses; anyone else asks you first.",
      },
    ],
    dueInDays: 21,
    checkIn: DAILY_10,
    fill: ({ invoices = [], emails = [] }) => ({
      title: `Get ${invoices.length} overdue ${invoices.length === 1 ? "invoice" : "invoices"} paid`,
      prompt: `Get these overdue invoices paid: ${list(invoices)}. Clients: ${list(emails)}. Read them with ledger_list. For each, find the last thread with the client (gmail_search) and save a polite reminder draft in the person's language with the amount, invoice number and due date exactly as the ledger shows them; never compute amounts. If a client hasn't replied two check-ins after a draft, offer a call with propose_call; the person confirms every call. When a call outcome gives a promised date, propose a one-time check on that date. Say plainly what is still unpaid. Only the person marks an invoice paid.`,
      criteria: [
        {
          text: "A reminder draft is ready for each client",
          evidence: {
            kind: "tool_verified",
            tool: "gmail_draft",
            atLeast: emails.length,
          },
        },
        { text: "Each invoice is paid", evidence: { kind: "invoice_paid" } },
      ],
      grants: [
        {
          tool: "gmail_draft",
          pins: { to: emails },
          maxUses: Math.min(50, 3 * emails.length),
          why: "Reminder drafts you send yourself",
        },
      ],
      subjects: { invoices },
    }),
  },
  {
    id: "OP-BOOKS",
    version: 2,
    title: "Close this month's books",
    summary: "Bills into the ledger for you to confirm, then the month's report.",
    roles: ["FD-01", "FD-02", "BZ-02", "FD-09"],
    needs: ["ledger"],
    slots: [
      { kind: "date", label: "Month" },
      { kind: "emails", label: "Your CA's email (optional)", optional: true },
    ],
    dueInDays: 10,
    checkIn: DAILY_10,
    growsLedger: true,
    fill: ({ date = "", emails = [] }) => ({
      title: `Close the books for ${date}`,
      prompt:
        `Close the books for ${date}. Look through the person's files and mail attachments for that month's bills and income, and draft ledger entries with ledger_draft_entry; Kriya computes GST and marks anything that doesn't add up for review. Tell the person which entries need their review. Once every entry is confirmed, write the month's summary in your reply for the person to review. ${emails.length ? `The person wants to share it with ${list(emails)}; suggest a share link, which only they can create.` : ""}`.trim(),
      criteria: [
        {
          text: "Every bill this month is in the ledger, confirmed",
          evidence: { kind: "ledger_confirmed" },
        },
        // OF-19: no agent tool makes a file, so the person marks it
        {
          text: "You reviewed the month's summary (you mark it)",
          evidence: { kind: "person_confirmed" },
        },
        { text: "Your CA has the report", evidence: { kind: "person_confirmed" } },
      ],
      grants: [],
    }),
  },
  {
    id: "OP-COMPARE",
    version: 2,
    title: "Compare and track a price",
    summary: "Sourced prices with checked-at times, and a watcher at your limit.",
    roles: [],
    needs: ["web"],
    slots: [
      { kind: "text", label: "What to compare, and your limit in ₹" },
      { kind: "sheet", label: "A sheet to fill (optional)", optional: true },
    ],
    dueInDays: 7,
    // shortcut: PLAYBOOKS.md says no check-in after the first run; a job's
    // schedules always include one, so weekly until jobs can go without
    checkIn: { freq: "weekly", at: "10:00", days: [1] },
    fill: ({ text = "", sheet }) => ({
      title: `Compare: ${text}`.slice(0, 200),
      prompt: `Compare prices for: ${text}. Use official or authorised sources only (web_search, web_fetch, facts_lookup). Every row needs the source URL, when it was checked (IST) and whether taxes and fees are included; never present an old result as live. ${sheet ? `Add the rows to the sheet with sheets_append (range ${sheet.range}).` : "Put the comparison in your reply as a table."} Then propose a watcher on the best option at the person's limit. Never book or pay.`,
      criteria: [
        {
          text: sheet
            ? "A comparison with a source and checked-at time per row"
            : "A comparison with a source and checked-at time per row (you mark it)",
          evidence: sheet
            ? { kind: "tool_verified", tool: "sheets_append" }
            : { kind: "person_confirmed" },
        },
        {
          text: "A watcher on the best option is running",
          evidence: { kind: "person_confirmed" },
        },
      ],
      grants: sheet
        ? [
            {
              tool: "sheets_append",
              pins: { spreadsheetId: sheet.spreadsheetId, range: sheet.range },
              maxUses: 5,
              why: "Rows in the sheet you named",
            },
          ]
        : [],
    }),
  },
  {
    id: "OP-COMPLY",
    version: 1,
    title: "Keep my compliance dates",
    summary: "This quarter's GST, TDS and ROC dates on your Radar, each quoted.",
    roles: ["FD-04"],
    needs: ["radar"],
    slots: [],
    dueInDays: 30,
    checkIn: { freq: "weekly", at: "10:00", days: [1] },
    fill: () => ({
      title: "Keep this quarter's compliance dates",
      prompt:
        "Put this quarter's GST, TDS and ROC due dates that apply to the person on their Radar with obligation_add, each with the exact words of the official source (facts_lookup and official pages). Don't guess a date; say which ones you couldn't confirm.",
      criteria: [
        {
          text: "This quarter's due dates are on the Radar, quoted",
          evidence: { kind: "person_confirmed" },
        },
      ],
      grants: [],
    }),
  },
  {
    id: "OP-MEET",
    version: 2,
    title: "Prepare me for this week's meetings",
    summary:
      "A one-page brief per meeting; private follow-up reminders if you want them.",
    roles: ["FD-06"],
    needs: ["google.calendar"],
    slots: [],
    dueInDays: 7,
    checkIn: { freq: "daily", at: "08:00" },
    fill: () => ({
      title: "Prepare for this week's meetings",
      prompt:
        "Look at this week's meetings on the person's calendar and prepare a one-page brief for each in your reply: who, why, what was last agreed, what to decide. If the person asks for follow-ups, add them as private reminders on their own calendar with no guests.",
      criteria: [
        {
          text: "A one-page brief for each meeting (you mark it)",
          evidence: { kind: "person_confirmed" },
        },
      ],
      grants: [
        {
          tool: "calendar_create_event",
          pins: { attendees: [] },
          maxUses: 10,
          why: "Private reminders on your own calendar, no guests",
        },
      ],
    }),
  },
]

export const playbookById = (id: string | undefined) => PLAYBOOKS.find((p) => p.id === id)

// What the picker may show: every need met (no dead buttons)
export const runnable = (have: Set<Need>) =>
  PLAYBOOKS.filter((p) => p.needs.every((need) => have.has(need)))

// The job proposal a playbook makes from the person's slots
export function fillPlaybook(playbook: Playbook, slots: Slots) {
  const missing = playbook.slots.filter(({ kind, optional }) => {
    if (optional) return false
    const value = slots[kind]
    return Array.isArray(value) ? value.length === 0 : !value
  })
  if (missing.length > 0)
    return { error: `Fill in: ${missing.map((s) => s.label.toLowerCase()).join(", ")}.` }
  const filled = playbook.fill(slots)
  return {
    title: filled.title,
    objective: filled.prompt.slice(0, 2000),
    playbookId: playbook.id,
    criteria: filled.criteria,
    grants: filled.grants,
    dueInDays: playbook.dueInDays,
    checkIn: playbook.checkIn,
    ...(filled.subjects && { subjects: filled.subjects }),
  }
}
