import type { EvidenceSpec, MandateStatus, Pins } from "@/db/schema"

// The person's words for jobs (UX_SPEC §1–2). Pure strings: client
// components import this file, never lib/operator's server modules.

export const STATUS_LABEL: Record<MandateStatus, string> = {
  proposed: "Proposed",
  declined: "Declined",
  active: "Active",
  needs_person: "Needs you",
  paused: "Paused",
  completed: "Done (verified)",
  expired: "Expired",
  revoked: "Revoked",
  closed: "Closed",
}

const TOOL_WORDS: Record<string, string> = {
  gmail_draft: "an email draft",
  calendar_create_event: "a calendar event",
  sheets_append: "rows added to a sheet",
  sheets_update: "a sheet update",
}

// How a criterion gets met
export function evidenceLabel(spec: EvidenceSpec) {
  switch (spec.kind) {
    case "tool_verified":
      return `Kriya checks ${spec.atLeast && spec.atLeast > 1 ? `${spec.atLeast}× ` : ""}${TOOL_WORDS[spec.tool] ?? spec.tool.replaceAll("_", " ")}`
    case "call_outcome":
      return "A checked call outcome"
    case "invoice_paid":
      return "You mark each invoice paid"
    case "ledger_confirmed":
      return "You confirm each entry"
    case "file_created":
      return "A file Kriya made"
    case "person_confirmed":
      return "You mark it"
  }
}

// "Save up to 9 email drafts to a@…, b@…": what a grant lets Kriya do
export function grantLine(tool: string, pins: Pins, maxUses: number) {
  const list = (emails: string[] | undefined) => (emails ?? []).join(", ")
  if (tool === "gmail_draft" && "to" in pins)
    return `Save up to ${maxUses} email drafts to ${list(pins.to)}${pins.cc?.length ? ` (cc ${list(pins.cc)})` : ""}`
  if (tool === "calendar_create_event" && "attendees" in pins)
    return `Add up to ${maxUses} calendar events${pins.attendees.length ? ` with ${list(pins.attendees)}` : " with no guests"}`
  if ((tool === "sheets_append" || tool === "sheets_update") && "range" in pins)
    return `${tool === "sheets_append" ? "Add rows to" : "Update"} ${pins.range} in one sheet, up to ${maxUses} times`
  return `${tool.replaceAll("_", " ")}, up to ${maxUses} times`
}
