import { and, eq, gte, inArray, lte, ne, sql } from "drizzle-orm"
import { z } from "zod"

import { rowsOf, withUser } from "@/db"
import {
  invoices,
  ledgerEntries,
  type Invoice,
  type InvoiceItem,
  type LedgerLine,
} from "@/db/schema"
import { savePdf } from "@/lib/documents/render"
import { renderLedgerReport, renderTaxInvoice } from "@/lib/documents/templates"
import { saveGenerated } from "@/lib/files"
import {
  gstinProblems,
  normaliseGstin,
  percentOf,
  stateTaxLabel,
  taxSplit,
} from "@/lib/gst"
import { formatPaise } from "@/lib/money"

// Accounts (A7, AD-16): models only extract a bill's fields; every sum and
// tax here is computed by code in integer paise and checked again in SQL.
// Anything that doesn't reconcile becomes `needs_review` with the reason.
// Only the person confirms (confirmEntries is called from their action;
// no agent tool writes that status, AT-POL-07). Reports count confirmed
// entries only and say "Review with your CA". Single-entry by design
// (owner, 2026-10-18). No next/* imports: the worker can use this too.

// ≤ ₹100 crore per amount, so sums of 200 lines stay exact (< 2^53)
const paise = z.number().int().min(0).max(1_000_000_000_000)
const stateCode = z.string().regex(/^[0-9]{2}$/)

// What a model reads off a bill (or the person types)
export const billSchema = z.object({
  kind: z.enum(["expense", "income"]).default("expense"),
  date: z.iso.date(),
  counterparty: z.string().trim().max(200).optional(),
  gstin: z.string().trim().max(20).optional(),
  documentNo: z.string().trim().max(40).optional(),
  category: z.string().trim().max(60).optional(),
  placeOfSupply: stateCode.optional(),
  lines: z
    .array(
      z.object({
        description: z.string().trim().min(1).max(300),
        hsnSac: z.string().trim().max(10).optional(),
        qtyMilli: z.number().int().min(0).optional(),
        ratePaise: paise.optional(),
        amountPaise: paise,
        taxRateBps: z.number().int().min(0).max(10_000).optional(),
      })
    )
    .max(200)
    .default([]),
  taxablePaise: paise.optional(),
  cgstPaise: paise.optional(),
  sgstPaise: paise.optional(),
  igstPaise: paise.optional(),
  cessPaise: paise.optional(),
  totalPaise: paise,
  // The extractor's confidence per field, 0–1
  confidence: z.record(z.string(), z.number().min(0).max(1)).default({}),
})
export type Bill = z.input<typeof billSchema>

export const CONFIDENCE_MIN = 0.9
const CONFIDENCE_LABELS: Record<string, string> = {
  totalPaise: "total",
  taxablePaise: "value before tax",
  date: "date",
  gstin: "GSTIN",
  documentNo: "bill number",
  cgstPaise: "CGST",
  sgstPaise: "SGST",
  igstPaise: "IGST",
}

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0)
const rs = (value: number) => formatPaise(value)

// The person's own state (for an expense, where it's supplied to; for
// income, where they supply from). Unknown → the State/IGST check is skipped.
export function reconcile(input: Bill, my: { stateCode?: string | null } = {}) {
  const bill = billSchema.parse(input)
  const reasons: string[] = []
  const gstin = bill.gstin ? normaliseGstin(bill.gstin) : null
  if (gstin) reasons.push(...gstinProblems(gstin))
  const gstinOk = gstin !== null && /^[0-9]{2}[0-9A-Z]{13}$/.test(gstin)
  const theirState = gstinOk ? gstin!.slice(0, 2) : null
  const supplierState = bill.kind === "expense" ? theirState : (my.stateCode ?? null)
  const placeOfSupply =
    bill.placeOfSupply ?? (bill.kind === "expense" ? my.stateCode : theirState) ?? null

  // Value before tax: the lines' sum when there are lines
  const linesTotal = sum(bill.lines.map((l) => l.amountPaise))
  const taxable = bill.lines.length ? linesTotal : (bill.taxablePaise ?? 0)
  if (
    bill.lines.length &&
    bill.taxablePaise != null &&
    bill.taxablePaise !== linesTotal
  ) {
    reasons.push(
      `The lines add up to ${rs(linesTotal)}; the bill says ${rs(bill.taxablePaise)} before tax.`
    )
  }
  if (!bill.lines.length && bill.taxablePaise == null) {
    reasons.push("The bill's value before tax wasn't found.")
  }

  // Taxes: from the lines' rates when every line has one and both states
  // are known; otherwise as stated, checked against the states
  const stated = {
    cgst: bill.cgstPaise ?? 0,
    sgst: bill.sgstPaise ?? 0,
    igst: bill.igstPaise ?? 0,
  }
  let taxes = stated
  const sgstLabel = placeOfSupply ? stateTaxLabel(placeOfSupply) : "SGST"
  if (
    bill.lines.length &&
    bill.lines.every((l) => l.taxRateBps != null) &&
    supplierState &&
    placeOfSupply
  ) {
    const split = bill.lines.map((l) =>
      taxSplit({
        supplierState,
        placeOfSupply,
        taxablePaise: l.amountPaise,
        rateBps: l.taxRateBps!,
      })
    )
    taxes = {
      cgst: sum(split.map((s) => s.cgst)),
      sgst: sum(split.map((s) => s.sgst)),
      igst: sum(split.map((s) => s.igst)),
    }
    const named = { cgst: "CGST", sgst: sgstLabel, igst: "IGST" } as const
    for (const key of ["cgst", "sgst", "igst"] as const) {
      const given = bill[`${key}Paise`]
      if (given != null && given !== taxes[key]) {
        reasons.push(
          `${named[key]} on the bill is ${rs(given)}; its rates give ${rs(taxes[key])}.`
        )
      }
    }
  } else if (supplierState && placeOfSupply) {
    const inter = supplierState !== placeOfSupply
    if (inter && (stated.cgst || stated.sgst)) {
      reasons.push(`CGST/${sgstLabel} on a supply between States; expected IGST.`)
    }
    if (!inter && stated.igst) {
      reasons.push(`IGST on a supply within one State; expected CGST and ${sgstLabel}.`)
    }
  }
  if (taxes.igst && (taxes.cgst || taxes.sgst)) {
    // Never both (SQL check): keep CGST/SGST; the total check below shows the gap
    reasons.push("The bill has both IGST and CGST/SGST.")
    taxes = { ...taxes, igst: 0 }
  }
  const cess = bill.cessPaise ?? 0
  const tax = taxes.cgst + taxes.sgst + taxes.igst + cess
  if (tax > 0 && !gstinOk) reasons.push("Tax is charged but the bill has no valid GSTIN.")

  // The bill's own total, when it's within ₹1 of value plus taxes
  let roundOff = bill.totalPaise - (taxable + tax)
  let total = bill.totalPaise
  if (Math.abs(roundOff) > 100) {
    reasons.push(
      `Value before tax plus taxes is ${rs(taxable + tax)}; the bill says ${rs(bill.totalPaise)}.`
    )
    roundOff = 0
    total = taxable + tax
  }

  for (const [field, label] of Object.entries(CONFIDENCE_LABELS)) {
    const c = bill.confidence[field]
    if (c != null && c < CONFIDENCE_MIN)
      reasons.push(`Kriya isn't sure it read the ${label} right.`)
  }

  return {
    status: (reasons.length ? "needs_review" : "draft") as "draft" | "needs_review",
    reasons,
    values: {
      kind: bill.kind,
      entryDate: bill.date,
      counterparty: bill.counterparty ?? null,
      counterpartyGstin: gstinOk ? gstin : null,
      documentNo: bill.documentNo ?? null,
      category: bill.category ?? null,
      placeOfSupply,
      taxablePaise: taxable,
      cgstPaise: taxes.cgst,
      sgstPaise: taxes.sgst,
      igstPaise: taxes.igst,
      cessPaise: cess,
      roundOffPaise: roundOff,
      totalPaise: total,
      lineItems: bill.lines.map((l): LedgerLine => ({
        description: l.description,
        hsn_sac: l.hsnSac,
        qty_milli: l.qtyMilli,
        rate_paise: l.ratePaise,
        amount_paise: l.amountPaise,
        tax_rate_bps: l.taxRateBps,
      })),
      extraction: { confidence: bill.confidence, gstinAsRead: bill.gstin ?? null },
    },
  }
}

/* ───────────────────────────── entries ──────────────────────────── */

// Adds reconciled entries as draft or needs_review (never confirmed). A
// bill already entered (same GSTIN and number) isn't added twice (AT-LED-04).
export async function addEntries(
  userId: string,
  bills: Bill[],
  options: {
    createdBy: "agent" | "user"
    stateCode?: string | null
    taskId?: string | null
    fileId?: string | null
  }
) {
  return withUser(userId, async (tx) => {
    const added: { id: string; status: string; reasons: string[] }[] = []
    const duplicates: { index: number; existingId: string }[] = []
    for (const [index, bill] of bills.entries()) {
      const { status, reasons, values } = reconcile(bill, options)
      if (values.counterpartyGstin && values.documentNo) {
        const [existing] = await tx
          .select({ id: ledgerEntries.id })
          .from(ledgerEntries)
          .where(
            and(
              eq(ledgerEntries.kind, values.kind),
              eq(ledgerEntries.counterpartyGstin, values.counterpartyGstin),
              eq(ledgerEntries.documentNo, values.documentNo),
              ne(ledgerEntries.status, "void")
            )
          )
        if (existing) {
          duplicates.push({ index, existingId: existing.id })
          continue
        }
      }
      const [row] = await tx
        .insert(ledgerEntries)
        .values({
          userId,
          ...values,
          status,
          reviewReasons: reasons,
          createdBy: options.createdBy,
          taskId: options.taskId ?? null,
          fileId: options.fileId ?? null,
        })
        .returning({ id: ledgerEntries.id })
      added.push({ id: row.id, status, reasons })
    }
    return { added, duplicates }
  })
}

// The person's confirmation (DATA_MODEL §3.5): drafts as they are; an
// entry that needed review only with their note
export async function confirmEntries(userId: string, ids: string[], note?: string) {
  const reviewed = note?.trim()
  return withUser(userId, (tx) =>
    tx
      .update(ledgerEntries)
      .set({ status: "confirmed", confirmedAt: new Date(), reviewNote: reviewed || null })
      .where(
        and(
          inArray(ledgerEntries.id, ids),
          reviewed
            ? inArray(ledgerEntries.status, ["draft", "needs_review"])
            : eq(ledgerEntries.status, "draft")
        )
      )
      .returning({ id: ledgerEntries.id })
  )
}

// Edits an unconfirmed entry: everything is reconciled again
export async function editEntry(
  userId: string,
  id: string,
  bill: Bill,
  stateCode?: string | null
) {
  const { status, reasons, values } = reconcile(bill, { stateCode })
  const rows = await withUser(userId, (tx) =>
    tx
      .update(ledgerEntries)
      .set({ ...values, status, reviewReasons: reasons })
      .where(
        and(
          eq(ledgerEntries.id, id),
          inArray(ledgerEntries.status, ["draft", "needs_review"])
        )
      )
      .returning({ id: ledgerEntries.id, status: ledgerEntries.status })
  )
  return rows[0] ?? null
}

export async function voidEntry(userId: string, id: string) {
  const rows = await withUser(userId, (tx) =>
    tx
      .update(ledgerEntries)
      .set({ status: "void" })
      .where(
        and(
          eq(ledgerEntries.id, id),
          inArray(ledgerEntries.status, ["draft", "confirmed"])
        )
      )
      .returning({ id: ledgerEntries.id })
  )
  return rows.length > 0
}

/* ──────────────────────────── summaries ─────────────────────────── */

const total = (column: unknown) =>
  sql<number>`coalesce(sum(${column}), 0)::bigint`.mapWith(Number)

// Confirmed entries only, summed in SQL (AT-LED-05)
export async function summarize(
  userId: string,
  period: { from: string; to: string },
  groupBy: "kind" | "category" | "counterparty" = "kind"
) {
  const key =
    groupBy === "kind"
      ? sql<string>`${ledgerEntries.kind}`
      : groupBy === "category"
        ? sql<string>`coalesce(${ledgerEntries.category}, 'Uncategorised')`
        : sql<string>`coalesce(${ledgerEntries.counterparty}, 'Unknown')`
  return withUser(userId, (tx) =>
    tx
      .select({
        kind: ledgerEntries.kind,
        key,
        entries: sql<number>`count(*)::int`.mapWith(Number),
        taxablePaise: total(ledgerEntries.taxablePaise),
        cgstPaise: total(ledgerEntries.cgstPaise),
        sgstPaise: total(ledgerEntries.sgstPaise),
        igstPaise: total(ledgerEntries.igstPaise),
        cessPaise: total(ledgerEntries.cessPaise),
        totalPaise: total(ledgerEntries.totalPaise),
      })
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.status, "confirmed"),
          gte(ledgerEntries.entryDate, period.from),
          lte(ledgerEntries.entryDate, period.to)
        )
      )
      .groupBy(ledgerEntries.kind, key)
      .orderBy(ledgerEntries.kind, key)
  )
}

export type SummaryRow = Awaited<ReturnType<typeof summarize>>[number]

/* ───────────────────────────── invoices ─────────────────────────── */

const party = z.object({
  name: z.string().trim().min(1).max(200),
  gstin: z.string().trim().max(20).optional(),
  address: z.string().trim().max(500).optional(),
  state_code: stateCode,
})

export const invoiceInputSchema = z.object({
  supplier: party,
  client: party,
  items: z
    .array(
      z.object({
        description: z.string().trim().min(1).max(300),
        hsnSac: z.string().trim().max(10).optional(),
        // Quantity in thousandths: 1.5 hours = 1500
        qtyMilli: z.number().int().min(1).max(1_000_000_000),
        ratePaise: z.number().int().min(0).max(10_000_000_000),
        taxRateBps: z.number().int().min(0).max(10_000),
      })
    )
    .min(1)
    .max(100),
  series: z
    .string()
    .regex(/^[A-Z0-9]{1,4}$/)
    .default("INV"),
  issueDate: z.iso.date().optional(),
  dueDate: z.iso.date().optional(),
  notes: z.string().trim().max(2000).optional(),
})
export type InvoiceInput = z.input<typeof invoiceInputSchema>

// Line amounts and taxes by code; place of supply is the client's state
export function computeInvoice(input: InvoiceInput) {
  const data = invoiceInputSchema.parse(input)
  const items: InvoiceItem[] = data.items.map((item) => {
    const amount = percentOf(item.qtyMilli, item.ratePaise * 10) // qty/1000 × rate
    const split = taxSplit({
      supplierState: data.supplier.state_code,
      placeOfSupply: data.client.state_code,
      taxablePaise: amount,
      rateBps: item.taxRateBps,
    })
    return {
      description: item.description,
      hsn_sac: item.hsnSac,
      qty_milli: item.qtyMilli,
      rate_paise: item.ratePaise,
      tax_rate_bps: item.taxRateBps,
      amount_paise: amount,
      cgst_paise: split.cgst,
      sgst_paise: split.sgst,
      igst_paise: split.igst,
    }
  })
  const taxable = sum(items.map((i) => i.amount_paise))
  const cgst = sum(items.map((i) => i.cgst_paise))
  const sgst = sum(items.map((i) => i.sgst_paise))
  const igst = sum(items.map((i) => i.igst_paise))
  return {
    data,
    items,
    taxablePaise: taxable,
    cgstPaise: cgst,
    sgstPaise: sgst,
    igstPaise: igst,
    totalPaise: taxable + cgst + sgst + igst,
  }
}

export async function createInvoiceDraft(userId: string, input: InvoiceInput) {
  const { data, items, ...amounts } = computeInvoice(input)
  const [row] = await withUser(userId, (tx) =>
    tx
      .insert(invoices)
      .values({
        userId,
        series: data.series,
        supplier: {
          ...data.supplier,
          gstin: data.supplier.gstin && normaliseGstin(data.supplier.gstin),
        },
        client: {
          ...data.client,
          gstin: data.client.gstin && normaliseGstin(data.client.gstin),
        },
        placeOfSupply: data.client.state_code,
        items,
        ...amounts,
        issueDate: data.issueDate ?? null,
        dueDate: data.dueDate ?? null,
        notes: data.notes ?? null,
      })
      .returning()
  )
  return row
}

// Issuing (AD-17): the number comes from issue_invoice(), which locks the
// series row. The same transaction records the income as a draft entry.
// The PDF is made afterwards; if that fails the invoice stays issued and
// the PDF can be made again (renderInvoicePdf).
export async function issueInvoice(userId: string, invoiceId: string) {
  const invoice = await withUser(userId, async (tx) => {
    const [issued] = rowsOf<{ id: string }>(
      await tx.execute(sql`select id from kriya.issue_invoice(${invoiceId}::uuid)`)
    )
    const [row] = await tx.select().from(invoices).where(eq(invoices.id, issued.id))
    if (row.ledgerEntryId) return row
    const [entry] = await tx
      .insert(ledgerEntries)
      .values({
        userId,
        kind: "income",
        status: "draft",
        entryDate: row.issueDate!,
        counterparty: row.client.name,
        counterpartyGstin: row.client.gstin ?? null,
        documentNo: row.numberText,
        placeOfSupply: row.placeOfSupply,
        taxablePaise: row.taxablePaise,
        cgstPaise: row.cgstPaise,
        sgstPaise: row.sgstPaise,
        igstPaise: row.igstPaise,
        cessPaise: row.cessPaise,
        roundOffPaise: row.roundOffPaise,
        totalPaise: row.totalPaise,
        lineItems: row.items.map((i) => ({
          description: i.description,
          hsn_sac: i.hsn_sac,
          qty_milli: i.qty_milli,
          rate_paise: i.rate_paise,
          amount_paise: i.amount_paise,
          tax_rate_bps: i.tax_rate_bps,
        })),
        createdBy: "user",
      })
      .returning({ id: ledgerEntries.id })
    const [linked] = await tx
      .update(invoices)
      .set({ ledgerEntryId: entry.id })
      .where(eq(invoices.id, row.id))
      .returning()
    return linked
  })
  return { invoice, ...(await renderInvoicePdf(userId, invoice)) }
}

export async function renderInvoicePdf(userId: string, invoice: Invoice) {
  if (invoice.status === "draft") return { pdfError: "Issue the invoice first." }
  try {
    const { html } = renderTaxInvoice(invoice)
    const file = await savePdf(userId, {
      html,
      name: invoice.numberText!.replace(/\//g, "-"),
    })
    await withUser(userId, (tx) =>
      tx.update(invoices).set({ pdfFileId: file.id }).where(eq(invoices.id, invoice.id))
    )
    return { pdfFileId: file.id }
  } catch (error) {
    return {
      pdfError: error instanceof Error ? error.message : "The PDF couldn't be made.",
    }
  }
}

export async function setInvoiceStatus(
  userId: string,
  id: string,
  status: "paid" | "void"
) {
  return withUser(userId, async (tx) => {
    const [row] = await tx
      .update(invoices)
      .set(status === "paid" ? { status, paidAt: new Date() } : { status })
      .where(and(eq(invoices.id, id), eq(invoices.status, "issued")))
      .returning()
    // A voided invoice's income goes too
    if (row && status === "void" && row.ledgerEntryId) {
      await tx
        .update(ledgerEntries)
        .set({ status: "void" })
        .where(
          and(
            eq(ledgerEntries.id, row.ledgerEntryId),
            inArray(ledgerEntries.status, ["draft", "confirmed"])
          )
        )
    }
    return row ?? null
  })
}

/* ───────────────────────────── export ───────────────────────────── */

// Spreadsheet formula injection: a cell starting like a formula is quoted
const cell = (value: unknown) => {
  let text = value == null ? "" : String(value)
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}
const rupees = (p: number) => (p / 100).toFixed(2)

export function entriesCsv(rows: Awaited<ReturnType<typeof confirmedEntries>>) {
  const header = [
    "Date",
    "Kind",
    "Counterparty",
    "GSTIN",
    "Document no.",
    "Category",
    "Place of supply",
    "Taxable",
    "CGST",
    "SGST/UTGST",
    "IGST",
    "Cess",
    "Round-off",
    "Total",
  ]
  const lines = rows.map((r) =>
    [
      r.entryDate,
      r.kind,
      r.counterparty,
      r.counterpartyGstin,
      r.documentNo,
      r.category,
      r.placeOfSupply,
      rupees(r.taxablePaise),
      rupees(r.cgstPaise),
      rupees(r.sgstPaise),
      rupees(r.igstPaise),
      rupees(r.cessPaise),
      rupees(r.roundOffPaise),
      rupees(r.totalPaise),
    ]
      .map(cell)
      .join(",")
  )
  return [header.join(","), ...lines].join("\r\n") + "\r\n"
}

export async function confirmedEntries(
  userId: string,
  period: { from: string; to: string }
) {
  return withUser(userId, (tx) =>
    tx
      .select()
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.status, "confirmed"),
          gte(ledgerEntries.entryDate, period.from),
          lte(ledgerEntries.entryDate, period.to)
        )
      )
      .orderBy(ledgerEntries.entryDate)
  )
}

// "Export for my CA" (UX_SPEC §9): a CSV of the period's confirmed entries
// and a PDF summary, both in the person's files
export async function exportPeriod(userId: string, period: { from: string; to: string }) {
  const rows = await confirmedEntries(userId, period)
  const csv = await saveGenerated(userId, {
    name: `kriya-ledger-${period.from}-to-${period.to}.csv`,
    mime: "text/csv",
    bytes: Buffer.from(entriesCsv(rows), "utf8"),
    origin: "generated",
  })
  try {
    const { html } = renderLedgerReport({
      ...period,
      summary: await summarize(userId, period, "category"),
      entries: rows.length,
    })
    const pdf = await savePdf(userId, {
      html,
      name: `kriya-ledger-${period.from}-to-${period.to}`,
    })
    return { csvFileId: csv.id, pdfFileId: pdf.id }
  } catch (error) {
    return {
      csvFileId: csv.id,
      pdfError: error instanceof Error ? error.message : "The PDF couldn't be made.",
    }
  }
}
