import { and, count, desc, eq, gte, lte } from "drizzle-orm"

import { withUser } from "@/db"
import { invoices, ledgerEntries, LEDGER_STATUSES } from "@/db/schema"
import { summarize } from "@/lib/ledger"

// Reads for the Accounts pages (A7), as the person (withUser). Numbers come
// from SQL sums of confirmed entries (lib/ledger.ts summarize).

export async function listEntries(
  userId: string,
  filter: {
    from?: string
    to?: string
    status?: (typeof LEDGER_STATUSES)[number]
    kind?: "expense" | "income"
  } = {},
  limit = 200
) {
  return withUser(userId, (tx) =>
    tx
      .select()
      .from(ledgerEntries)
      .where(
        and(
          filter.from ? gte(ledgerEntries.entryDate, filter.from) : undefined,
          filter.to ? lte(ledgerEntries.entryDate, filter.to) : undefined,
          filter.status ? eq(ledgerEntries.status, filter.status) : undefined,
          filter.kind ? eq(ledgerEntries.kind, filter.kind) : undefined
        )
      )
      .orderBy(desc(ledgerEntries.entryDate), desc(ledgerEntries.createdAt))
      .limit(limit)
  )
}

export async function listInvoices(userId: string, limit = 100) {
  return withUser(userId, (tx) =>
    tx.select().from(invoices).orderBy(desc(invoices.createdAt)).limit(limit)
  )
}

// India's financial year containing `day` (YYYY-MM-DD): April to March
export function fyBounds(day: string) {
  const [y, m] = day.split("-").map(Number)
  const start = m >= 4 ? y : y - 1
  return { from: `${start}-04-01`, to: `${start + 1}-03-31` }
}

// UX_SPEC §9 Overview: this month and the FY so far, and what waits for review
export async function accountsOverview(userId: string, today: string) {
  const month = { from: `${today.slice(0, 7)}-01`, to: today }
  const fy = { ...fyBounds(today), to: today }
  const [review] = await withUser(userId, (tx) =>
    tx
      .select({ n: count() })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.status, "needs_review"))
  )
  return {
    month: await summarize(userId, month),
    fy: await summarize(userId, fy),
    needsReview: review.n,
  }
}
