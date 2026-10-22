import { z } from "zod"

import type { GrantTool, Pins } from "@/db/schema"

// The targets a standing grant pins, per tool (track O, OD-04;
// DATA_MODEL_AND_STATE_MACHINES.md §2.2), checked when a job is proposed.
// lib/operator/grants.ts matches tool calls against them.

// Emails compare lower-cased and trimmed
const email = z.string().trim().toLowerCase().pipe(z.email().max(320))
// lib/connectors/sheets.ts SPREADSHEET_ID; restated, lib/operator stays off connectors
const sheet = z.strictObject({
  spreadsheetId: z.string().regex(/^[A-Za-z0-9_-]{20,100}$/),
  range: z.string().min(1).max(200),
})

// Unknown pin fields are refused, so a grant never pins less than it says
export const PIN_SCHEMAS = {
  gmail_draft: z.strictObject({
    to: z.array(email).min(1).max(20),
    cc: z.array(email).max(20).optional(),
  }),
  // An empty list allows events with no attendees only
  calendar_create_event: z.strictObject({ attendees: z.array(email).max(20) }),
  sheets_append: sheet,
  sheets_update: sheet,
} satisfies Record<GrantTool, z.ZodType<Pins>>
